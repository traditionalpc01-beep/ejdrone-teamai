import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContext } from '../../src/cli/context.js';
import { openSnapshot, readExistingSnapshot } from '../../src/cli/snapshot.js';
import { SYNC_INCOMPLETE_MARKER } from '../../src/state.js';

/**
 * openSnapshot 的免 git 分发点：gitAvailable 显式注入 false 时，Codeup 仓改走 API 逐文件
 * 拉取（kinds 照常从落盘文件采集），非 Codeup 仓给出「装 git / 迁 Codeup」两条路的错误。
 * HOME / EJDRONE_HOME 全部落在临时目录（helpers.ts 同思路），不碰真实 HOME；
 * gitAvailable 不注入时走 hasGitAvailable 现查的分支由集成用例（本机有 git）覆盖。
 */

const TOKEN = 'pat-snapshot-token';
const CODEUP_REPO = 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git';

type Body = unknown | ((url: string) => unknown);

function fakeFetch(
  routes: Array<{ match: (method: string, url: string) => boolean; body: Body }>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    for (const route of routes) {
      if (route.match(method, url)) {
        const body = typeof route.body === 'function' ? (route.body as (u: string) => unknown)(url) : route.body;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('{"message":"no route"}', { status: 404 });
  }) as unknown as typeof fetch;
}

/** 最小可采集仓库：一个 ns skill + 一个根 rule（collectResources 无 manifest 也能采出）。 */
const REPO_FILES: Record<string, string> = {
  'skills/be/deploy/SKILL.md': '# deploy\n',
  'rules/style.md': '# style\n',
};

function repoFetch(files: Record<string, string>): typeof fetch {
  return fakeFetch([
    { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: 'org-1' } },
    { match: (_m, url) => url.includes('/branches'), body: [{ name: 'main', defaultBranch: true, commit: { id: 'fe6c9664dead' } }] },
    { match: (_m, url) => url.includes('/files/tree'), body: Object.keys(files).map((p) => ({ path: p, type: 'blob' })) },
    {
      match: (m, url) => m === 'GET' && url.includes('/files/'),
      body: (url: string) => {
        const raw = url.split('/files/')[1]?.split('?')[0] ?? '';
        return { content: Buffer.from(files[decodeURIComponent(raw)] ?? '', 'utf8').toString('base64'), encoding: 'base64' };
      },
    },
  ]);
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-snapshot-'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function makeCtx(): ReturnType<typeof createContext> {
  const home = join(root, 'home');
  const state = join(root, 'state');
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  return createContext({
    env: { HOME: home, EJDRONE_HOME: state, EJDRONE_CODEUP_TOKEN: TOKEN },
    home,
    out: () => {},
    err: () => {},
    interactive: false,
  });
}

describe('openSnapshot 免 git 分发', () => {
  it('git 不可用 + Codeup 仓：走 API 逐文件落盘，snapshot 结构照旧、kinds 从写入的文件采集', async () => {
    const ctx = makeCtx();

    const loaded = await openSnapshot(ctx, CODEUP_REPO, {
      gitAvailable: false,
      fetchImpl: repoFetch(REPO_FILES),
    });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const snapshot = loaded.snapshot;
    expect(snapshot.branch).toBe('main');
    expect(snapshot.head).toBe('fe6c9664dead');
    expect(snapshot.dir).toBe(join(ctx.env.EJDRONE_HOME as string, 'repo'));
    expect(snapshot.kinds.skills.map((r) => `${r.namespace}/${r.name}`)).toEqual(['be/deploy']);
    expect(snapshot.kinds.rules.map((r) => r.name)).toEqual(['style']);
    expect(snapshot.manifest).toBeNull();
    expect(snapshot.manifestError).toBeNull();
    expect(snapshot.mcpFileError).toBeNull();
    // relinked 语义不适用于免 git 链路，不产生该 warning
    expect(snapshot.warnings).toEqual([]);
  });

  it('git 不可用 + 非 Codeup 仓：ok:false，错误点名 git 与免 git 两条路', async () => {
    const ctx = makeCtx();

    const loaded = await openSnapshot(ctx, 'https://gitlab.example.com/team/repo.git', { gitAvailable: false });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain('git');
    expect(loaded.error).toContain('免 git');
    expect(loaded.error).toContain('EJDRONE_CODEUP_TOKEN');
  });

  it('锁被别的进程占用 → ok:false 提示稍后重试，不发同步请求', async () => {
    const ctx = makeCtx();
    // 伪装「另一进程持锁」：写入父进程 pid（必然活着、且不是本进程——本进程 pid 会被
    // heldByCurrentProcess 判为已持锁而直接放行；死 pid 会被按 stale 回收）
    const state = ctx.env.EJDRONE_HOME as string;
    mkdirSync(state, { recursive: true });
    const ppid = Number(process.ppid ?? 0) || process.pid;
    writeFileSync(join(state, 'sync.lock'), `${ppid}\n`, 'utf8');

    const loaded = await openSnapshot(ctx, CODEUP_REPO, {
      gitAvailable: false,
      fetchImpl: repoFetch(REPO_FILES),
    });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain('sync.lock');
  });

  it('半截目录（SYNC_INCOMPLETE 哨兵在）→ readExistingSnapshot 拒绝当团队真相', async () => {
    const ctx = makeCtx();
    const dir = join(ctx.env.EJDRONE_HOME as string, 'repo');
    mkdirSync(join(dir, 'skills', 'half'), { recursive: true });
    writeFileSync(join(dir, SYNC_INCOMPLETE_MARKER), 'main\nabc\n', 'utf8');
    writeFileSync(join(dir, 'skills', 'half', 'SKILL.md'), '# half\n', 'utf8');

    expect(readExistingSnapshot(ctx)).toBeNull();

    // 哨兵撤除后恢复正常读取
    rmSync(join(dir, SYNC_INCOMPLETE_MARKER));
    const snapshot = readExistingSnapshot(ctx);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.kinds.skills.map((r) => r.name)).toEqual(['half']);
  });
});
