import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncCheckoutViaApi } from '../../src/git/gitless.js';
import { API_CHECKOUT_MARKER, SYNC_INCOMPLETE_MARKER } from '../../src/state.js';

/**
 * 免 git 降级编排层的测试：fetch 全部走 fakeFetch（codeup-api.test.ts 同款假件），不打真实 API；
 * checkout 落在临时目录，不碰真实 HOME。client 机制本身已在 codeup-api.test.ts 覆盖，
 * 这里只验编排：请求顺序、清空重建、路径护栏、回落语义。
 */

const TOKEN = 'pat-gitless-token';
const REPO_URL = 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git';
const BRANCHES = [
  { name: 'main', defaultBranch: true, commit: { id: 'fe6c9664dead' } },
  { name: 'ejdrone/push-1', defaultBranch: false, commit: { id: 'abc' } },
];

type Body = unknown | ((url: string) => unknown);

/** 可编程 fetch 假件：body 允许是 url 的函数（逐文件内容按请求路径现算）。 */
function fakeFetch(
  routes: Array<{ match: (method: string, url: string) => boolean; status?: number; body: Body }>,
): { fetch: typeof fetch; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url });
    for (const route of routes) {
      if (route.match(method, url)) {
        const body = typeof route.body === 'function' ? (route.body as (u: string) => unknown)(url) : route.body;
        return new Response(body === undefined ? '' : JSON.stringify(body), {
          status: route.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{"message":"no route"}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/** 组出 org → branches → tree → files 四组路由；tree 缺省由 files 的键生成（全是 blob）。 */
function repoFetch(files: Record<string, string>, branches: unknown = BRANCHES, tree?: Array<{ path: string; type: string }>) {
  return fakeFetch([
    { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: 'org-1' } },
    { match: (_m, url) => url.includes('/branches'), body: branches },
    {
      match: (_m, url) => url.includes('/files/tree'),
      body: tree ?? Object.keys(files).map((p) => ({ path: p, type: 'blob' })),
    },
    {
      match: (m, url) => m === 'GET' && url.includes('/files/'),
      body: (url: string) => {
        const raw = url.split('/files/')[1]?.split('?')[0] ?? '';
        const content = files[decodeURIComponent(raw)];
        if (content === undefined) throw new Error(`意外收到文件请求：${url}`);
        return { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' };
      },
    },
  ]);
}

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-gitless-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('syncCheckoutViaApi', () => {
  it('逐文件拉取默认分支并写盘：内容逐字节、LF 保留、嵌套目录与中文名建齐', async () => {
    const dir = join(root, 'repo');
    const files = {
      'README.md': '# team\n',
      'skills/be/deploy/SKILL.md': '# deploy\nstep 1\n',
      'rules/风格.md': '# 风格\n行一\n行二\n',
    };
    const { fetch, calls } = repoFetch(files);

    const result = await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });

    expect(result).toEqual({ branch: 'main', head: 'fe6c9664dead' });
    for (const [rel, content] of Object.entries(files)) {
      expect(readFileSync(join(dir, rel), 'utf8')).toBe(content);
    }
    // LF 原样保留，绝无换行转换
    expect(readFileSync(join(dir, 'rules/风格.md'), 'utf8')).not.toContain('\r');
    // org → branches → tree → 每个文件各一次
    expect(calls[0]?.url).toContain('/oapi/v1/platform/user');
    expect(calls[1]?.url).toContain('/branches');
    expect(calls[2]?.url).toContain('/files/tree');
    expect(calls.filter((c) => c.url.includes('/files/') && !c.url.includes('/files/tree')).length).toBe(
      Object.keys(files).length,
    );
    // token 只进请求头，绝不进 URL
    for (const c of calls) expect(c.url).not.toContain(TOKEN);
  });

  it('token 缺失时抛可行动错误，且一个网络请求都不发', async () => {
    const { fetch, calls } = repoFetch({});

    await expect(syncCheckoutViaApi(REPO_URL, join(root, 'repo'), {}, { fetchImpl: fetch })).rejects.toThrow(
      /EJDRONE_CODEUP_TOKEN/,
    );
    expect(calls).toEqual([]);
  });

  it('tree 混入 ../evil 时拒绝写并抛错，checkout 外不落任何文件', async () => {
    const dir = join(root, 'repo');
    const { fetch } = repoFetch({ 'README.md': '# team\n' }, BRANCHES, [
      { path: 'README.md', type: 'blob' },
      { path: '../evil', type: 'blob' },
    ]);

    await expect(
      syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch }),
    ).rejects.toThrow(/escapes|逃逸/i);

    expect(existsSync(join(root, 'evil'))).toBe(false);
    // 校验先于清空：坏 tree 不会把 checkout 打成一半新一半旧
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });

  it('清空重建 dir：预置的旧文件被清掉（reset --hard 的免 git 等价语义）', async () => {
    const dir = join(root, 'repo');
    mkdirSync(join(dir, 'stale'), { recursive: true });
    writeFileSync(join(dir, 'stale', 'old.txt'), 'old\n', 'utf8');
    const { fetch } = repoFetch({ 'README.md': '# team\n' });

    await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });

    expect(existsSync(join(dir, 'stale'))).toBe(false);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# team\n');
  });

  it('没有 defaultBranch 标记时回落 main（与 repo.ts defaultBranch 的最后回落一致）', async () => {
    const dir = join(root, 'repo');
    const branches = [
      { name: 'release', defaultBranch: false, commit: { id: 'r1' } },
      { name: 'main', defaultBranch: false, commit: { id: 'm1' } },
    ];
    const { fetch } = repoFetch({ 'README.md': '# team\n' }, branches);

    const result = await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });

    expect(result).toEqual({ branch: 'main', head: 'm1' });
  });

  it('dir 为空串或相对路径时拒绝清空（清空重建的护栏），网络请求一个不发', async () => {
    const { fetch, calls } = repoFetch({});

    await expect(
      syncCheckoutViaApi(REPO_URL, '', { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch }),
    ).rejects.toThrow(/空串/);
    await expect(
      syncCheckoutViaApi(REPO_URL, 'relative/dir', { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch }),
    ).rejects.toThrow(/绝对路径/);
    expect(calls).toEqual([]);
  });

  it('空仓库（远端无任何分支）：建带哨兵的空目录、head 为空串，不请求 tree', async () => {
    const dir = join(root, 'repo');
    const { fetch, calls } = repoFetch({}, []);

    const result = await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });

    expect(result).toEqual({ branch: 'main', head: '' });
    expect(existsSync(join(dir, API_CHECKOUT_MARKER))).toBe(true);
    expect(calls.some((c) => c.url.includes('/files/tree'))).toBe(false);
  });

  it('head 未变时命中缓存：不发 tree / 文件请求，也不重写目录', async () => {
    const dir = join(root, 'repo');
    const files = { 'README.md': '# team\n' };
    const { fetch, calls } = repoFetch(files);

    await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });
    const firstCount = calls.length;
    // 成员在两次同步之间对本地文件做了手工改动：缓存命中路径不得动它（远端没变就不是
    // 我们的职责去纠正；下一次远端前进时的全量重建自然会覆盖）
    writeFileSync(join(dir, 'README.md'), '# local edit\n', 'utf8');

    const again = await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });

    expect(again).toEqual({ branch: 'main', head: 'fe6c9664dead' });
    expect(calls.length).toBe(firstCount + 2); // 只多了 platform/user 与 branches 两趟
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# local edit\n');
  });

  it('远端有提交但 tree 为空 → 拒绝清空（截断防护），本地已有内容原样保留', async () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# precious\n', 'utf8');
    const { fetch } = repoFetch({}, BRANCHES, []);

    await expect(
      syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch }),
    ).rejects.toThrow(/空文件树|截断/);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# precious\n');
  });

  it('中途拉取失败 → 目录带 SYNC_INCOMPLETE 哨兵（半截不得被当团队真相），且无 API_CHECKOUT 哨兵', async () => {
    const dir = join(root, 'repo');
    const routes = repoFetch({ 'a.md': 'a\n', 'b.md': 'b\n' });
    // 第二个文件请求改挂：a 成功、b 失败
    let fileHits = 0;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/files/') && !url.includes('/files/tree') && (init?.method ?? 'GET') === 'GET') {
        fileHits += 1;
        if (fileHits >= 2) return new Response('{"message":"boom"}', { status: 500 });
      }
      return (routes.fetch as (i: RequestInfo | URL, o?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;

    await expect(
      syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: impl }),
    ).rejects.toThrow(/500/);

    expect(existsSync(join(dir, SYNC_INCOMPLETE_MARKER))).toBe(true);
    expect(existsSync(join(dir, API_CHECKOUT_MARKER))).toBe(false);
    expect(existsSync(join(dir, 'a.md'))).toBe(true); // 半截内容留在盘上，但被哨兵标记
  });

  it('成功同步后：API_CHECKOUT 哨兵记录 branch+head，SYNC_INCOMPLETE 撤除', async () => {
    const dir = join(root, 'repo');
    const { fetch } = repoFetch({ 'README.md': '# team\n' });

    await syncCheckoutViaApi(REPO_URL, dir, { EJDRONE_CODEUP_TOKEN: TOKEN }, { fetchImpl: fetch });

    expect(readFileSync(join(dir, API_CHECKOUT_MARKER), 'utf8')).toBe('main\nfe6c9664dead\n');
    expect(existsSync(join(dir, SYNC_INCOMPLETE_MARKER))).toBe(false);
  });
});
