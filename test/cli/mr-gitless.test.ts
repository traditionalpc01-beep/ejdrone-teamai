import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContext } from '../../src/cli/context.js';
import { submitMrChange } from '../../src/cli/mr.js';
import { emptyKinds } from '../../src/core/types.js';
import type { Config, Snapshot } from '../../src/core/types.js';

/**
 * submitMrChange 的免 git 分发点（mr.ts submitMrChangeWithoutGit）：
 * 本机没有 git 时，provider 有 apiPush 走纯 OpenAPI，没有则给可行动错误并返回非 0；
 * 部分文件写失败时不得开 MR（残缺内容合入主干会被全员 pull 下发）。
 * provider 内部行为（建分支/写文件/开 MR 的序列与兜底）在 test/git/codeup.test.ts 已覆盖，
 * 这里只钉分发层的退出码与文案。网络经 vi.stubGlobal 假造（submitMrChange 没有 fetchImpl
 * 注入口，provider 在内部构造——stub 全局 fetch 是唯一注入口，vitest 自动还原）。
 */

const TOKEN = 'pat-mr-token';
const CODEUP_REPO = 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git';

let root = '';
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-mr-gitless-'));
  stdout = [];
  stderr = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function makeCtx(env: Record<string, string> = {}) {
  const home = join(root, 'home');
  const state = join(root, 'state');
  return createContext({
    env: { HOME: home, EJDRONE_HOME: state, ...env },
    home,
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
    interactive: false,
  });
}

function makeConfig(provider: Config['provider']): Config {
  return {
    version: 1,
    repo: CODEUP_REPO,
    provider,
    codeupOrgId: 'org-1', // 预置，省掉 /platform/user 一趟
    primaryRole: null,
    additionalRoles: [],
    subscribedTags: [],
    agents: ['claude'],
  };
}

/** gitless 路径只读 snapshot.branch 与 snapshot.head（head==='' 即空仓 bootstrap）。 */
function bareSnapshot(head = 'fe6c9664dead'): Snapshot {
  return {
    dir: join(root, 'no-checkout'),
    head,
    branch: 'main',
    manifest: null,
    manifestError: null,
    kinds: emptyKinds(),
    warnings: [],
    mcpFileError: null,
  };
}

const CHANGE = {
  files: { 'skills/alpha/SKILL.md': '# alpha\n' },
  removes: [],
  branchPrefix: 'ejdrone/push-skills-alpha-',
  title: 'add alpha',
  body: '说明',
};

interface Route {
  match: (method: string, url: string) => boolean;
  status?: number;
  body: unknown;
}

function stubCodeupFetch(routes: Route[]): { calls: Array<{ method: string; url: string; body?: unknown }> } {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      for (const route of routes) {
        if (route.match(method, url)) {
          return new Response(JSON.stringify(route.body), {
            status: route.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response('{"message":"no route"}', { status: 404 });
    }) as unknown as typeof fetch,
  );
  return { calls };
}

describe('submitMrChange 免 git 分发', () => {
  it('provider 不支持免 git 推送：非 0 退出，指路「装 git / 交管理员代推」', async () => {
    const ctx = makeCtx();
    // provider=git（generic）：没有 apiPush。config.repo 刻意用非 Codeup 地址避免误导，
    // 但分发层只看 provider 能力，不看仓库域名。
    const config = makeConfig('git');
    config.repo = 'https://gitlab.example.com/team/repo.git';

    const outcome = await submitMrChange(ctx, config, bareSnapshot(), CHANGE, { gitAvailable: false });

    expect(outcome.code).toBe(1);
    expect(outcome.mrUrl).toBeNull();
    expect(stderr.join('\n')).toContain('不支持免 git 推送');
    expect(stderr.join('\n')).toContain('git');
  });

  it('provider=codeup：纯 API 推送建 MR，退出码 0，分支带时间戳且不复用远端', async () => {
    const ctx = makeCtx({ EJDRONE_CODEUP_TOKEN: TOKEN });
    const { calls } = stubCodeupFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: 'org-1' } },
      {
        match: (m, url) => m === 'GET' && url.includes('/branches'),
        body: [{ name: 'main', defaultBranch: true, commit: { id: 'fe6c9664dead' } }],
      },
      { match: (_m, url) => url.endsWith('/ejdrone%2F1C5P%2Fejdrone-teamai'), body: { id: 7561542 } },
      { match: (m, url) => m === 'POST' && url.includes('/branches'), body: {} },
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), body: {} },
      { match: (m, url) => m === 'POST' && url.includes('/changeRequests'), body: { webUrl: 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai/-/changes/9' } },
    ]);

    const outcome = await submitMrChange(ctx, makeConfig('codeup'), bareSnapshot(), CHANGE, { gitAvailable: false });

    expect(outcome.code).toBe(0);
    expect(outcome.mrUrl).toBe('https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai/-/changes/9');
    expect(outcome.branch).toMatch(/^ejdrone\/push-skills-alpha-\d{8}T\d{6}Z$/);
    expect(stdout.join('\n')).toContain('免 git 推送');
    // 序列：org/user → 列分支（无同前缀）→ 建分支（query 带 branch/ref）→ 写文件 → 开 MR
    const branchCall = calls.find((c) => c.method === 'POST' && c.url.includes('/branches'));
    expect(branchCall?.url).toContain('ref=main');
    const fileCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/files'));
    expect(fileCall?.body).toMatchObject({
      filePath: 'skills/alpha/SKILL.md',
      content: '# alpha\n',
      branch: outcome.branch,
    });
    const mrCall = calls.find((c) => c.method === 'POST' && c.url.includes('/changeRequests'));
    expect(mrCall?.body).toMatchObject({
      sourceBranch: outcome.branch,
      targetBranch: 'main',
      sourceProjectId: '7561542',
      targetProjectId: '7561542',
    });
  });

  it('空仓库（snapshot.head 为空）→ bootstrap：README/.gitattributes 直写 main，不开 MR，退出码 0', async () => {
    const ctx = makeCtx({ EJDRONE_CODEUP_TOKEN: TOKEN });
    const { calls } = stubCodeupFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: 'org-1' } },
      { match: (m, url) => m === 'GET' && url.includes('/branches'), body: [] },
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), body: {} },
    ]);

    const outcome = await submitMrChange(ctx, makeConfig('codeup'), bareSnapshot(''), CHANGE, { gitAvailable: false });

    expect(outcome.code).toBe(0);
    expect(outcome.mrUrl).toBeNull();
    expect(outcome.branch).toBe('main');
    expect(stdout.join('\n')).toContain('首个提交已直接落到 main');
    // 引导补齐与 git 路径同源：README.md + .gitattributes + 原文件，全部直写 main
    const fileCalls = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/files'));
    expect(fileCalls.map((c) => (c.body as { filePath: string }).filePath).sort()).toEqual(
      ['.gitattributes', 'README.md', 'skills/alpha/SKILL.md'],
    );
    expect(fileCalls.every((c) => (c.body as { branch: string }).branch === 'main')).toBe(true);
    expect(calls.some((c) => c.url.includes('/changeRequests'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/branches?'))).toBe(false);
  });

  it('文件写失败（非已存在类）：不开 MR、退出码非 0，错误点名是哪个文件', async () => {
    const ctx = makeCtx({ EJDRONE_CODEUP_TOKEN: TOKEN });
    stubCodeupFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: 'org-1' } },
      {
        match: (m, url) => m === 'GET' && url.includes('/branches'),
        body: [{ name: 'main', defaultBranch: true, commit: { id: 'fe6c9664dead' } }],
      },
      { match: (m, url) => m === 'POST' && url.includes('/branches'), body: {} },
      // 写文件被服务端拒绝且不属于「已存在」：整体停在分支上，不能开 MR
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), status: 403, body: { message: 'forbidden by hook' } },
      {
        match: (m, url) => m === 'POST' && url.includes('/changeRequests'),
        body: { webUrl: 'https://codeup.aliyun.com/should-not-exist' },
      },
    ]);

    const outcome = await submitMrChange(ctx, makeConfig('codeup'), bareSnapshot(), CHANGE, { gitAvailable: false });

    expect(outcome.code).toBe(1);
    expect(outcome.mrUrl).toBeNull();
    expect(stdout.join('\n')).toContain('skills/alpha/SKILL.md');
    expect(stdout.join('\n')).toContain('合并请求未创建');
  });
});
