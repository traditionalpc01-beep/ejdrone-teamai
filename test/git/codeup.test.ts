import { describe, expect, it } from 'vitest';

import type { ApiPushRequest, Config, MrRequest } from '../../src/core/types.js';
import { createCodeupProvider } from '../../src/git/codeup.js';
import { makeGitProvider } from '../../src/git/provider.js';

/**
 * 网络全部走注入的 fetchImpl（gitlab.test.ts / codeup-api.test.ts 同款思路，不打真实 API）。
 * token 用一个假值，好在断言里验证它不会外泄。
 *
 * organizationId 的策略是「每次现算 /platform/user」（不落 config）：所有用例的
 * 标准路由组都带 platform/user；想测解析失败就单独特制路由。
 */

const TOKEN = 'pat-secret-token';
const ORG = 'org-1';
const REPO_ID = 'ejdrone%2F1C5P%2Fejdrone-teamai';
const REPO_URL = 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git';
const ROOT = `/oapi/v1/codeup/organizations/${ORG}/repositories`;
const MR_URL = 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai/change/9';

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    repo: REPO_URL,
    provider: 'codeup',
    primaryRole: null,
    additionalRoles: [],
    subscribedTags: [],
    agents: [],
    ...overrides,
  };
}

const mrReq: MrRequest = { branch: 'ejdrone/push-1', title: 'push skills', body: '来自 ejdrone' };

function apiReq(overrides: Partial<ApiPushRequest> = {}): ApiPushRequest {
  return {
    branchPrefix: 'ejdrone/push-1-',
    targetBranch: 'main',
    title: 'feat(dev): add skill a',
    body: '由 ejdrone 生成',
    files: { 'skills/dev/a/SKILL.md': '# a\n' },
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

interface FakeFetch {
  fetch: typeof fetch;
  calls: Call[];
}

/** 可编程 fetch 假件：按 (method, url) 记录请求并返回预设响应。 */
function fakeFetch(
  routes: Array<{ match: (method: string, url: string) => boolean; status?: number; body?: unknown }>,
): FakeFetch {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({
      method,
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    for (const route of routes) {
      if (route.match(method, url)) {
        return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{"message":"no route"}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function fetchRejecting(error: Error): FakeFetch {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    throw error;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

/** 只留 URL 的尾部形状，断言调用顺序时不被基址噪音淹没 */
function shapeOf(call: Call | undefined): string {
  expect(call).toBeDefined();
  const tail = call!.url.replace(/^https:\/\/openapi-rdc\.aliyuncs\.com/, '');
  return `${call!.method} ${tail}`;
}

/** 新开分支场景的标准路由组：platform/user + 远端只有 main（无同前缀分支可复用）。 */
function fullRoutes(webUrl: string = MR_URL) {
  return [
    { match: (_m: string, url: string) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: ORG } },
    { match: (m: string, url: string) => m === 'GET' && url.includes('/branches'), body: [{ name: 'main', defaultBranch: true, commit: { id: 'abc' } }] },
    { match: (m: string, url: string) => m === 'POST' && url.includes('/branches'), body: {} },
    { match: (m: string, url: string) => m === 'POST' && url.endsWith('/files'), body: {} },
    { match: (m: string, url: string) => m === 'PUT' && url.includes('/files/'), body: {} },
    { match: (m: string, url: string) => m === 'DELETE' && url.includes('/files/'), body: {} },
    { match: (m: string, url: string) => m === 'GET' && url.endsWith(`/${REPO_ID}`), body: { id: 7561542 } },
    { match: (m: string, url: string) => m === 'POST' && url.includes('/changeRequests'), body: { webUrl } },
  ];
}

/** provider 现算出的时间戳分支名（ejdrone/push-1-<stamp>），断言用匹配器而非具体值。 */
const NEW_BRANCH_RE = /^ejdrone\/push-1-\d{8}T\d{6}Z$/;

describe('openMr', () => {
  it('成功 → 返回 webUrl；orgId 现算（/platform/user 一次），token 只进请求头', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).openMr(mrReq);

    expect(result).toEqual({ url: MR_URL, branch: 'ejdrone/push-1' });
    expect(calls.filter((c) => c.url.includes('/platform/user'))).toHaveLength(1);
    expect(calls.find((c) => c.url.includes('/changeRequests'))?.headers['x-yunxiao-token']).toBe(TOKEN);
  });

  it('缺 token → instructions 提示 EJDRONE_CODEUP_TOKEN，一次请求都不发', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());

    const result = await createCodeupProvider(config(), {}, fetch).openMr(mrReq);

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('EJDRONE_CODEUP_TOKEN');
    expect(calls).toHaveLength(0);
  });

  it('HTTP 失败 → instructions 带状态码与手动 MR 指引，token 原文不外泄', async () => {
    const { fetch } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: ORG } },
      { match: (m, url) => m === 'GET' && url.endsWith(`/${REPO_ID}`), status: 401, body: { message: `bad ${TOKEN}` } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).openMr(mrReq);

    expect(result.url).toBeNull();
    const text = result.instructions ?? '';
    expect(text).toContain('401');
    expect(text).toContain('EJDRONE_CODEUP_TOKEN 无效');
    expect(text).toContain('ejdrone/push-1');
    expect(text).toContain(REPO_URL.replace('.git', ''));
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[redacted]');
  });

  it('网络失败 → instructions 带原因与 token 指引，不上抛', async () => {
    const { fetch, calls } = fetchRejecting(new TypeError('fetch failed: ENOTFOUND openapi-rdc.aliyuncs.com'));

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).openMr(mrReq);

    expect(result.url).toBeNull();
    // 第一个网络调用就是 /platform/user（orgId 现算），失败折进 organizationId 指引
    expect(result.instructions).toContain('organizationId');
    expect(result.instructions).toContain('ENOTFOUND');
    expect(calls[0]?.headers['x-yunxiao-token']).toBe(TOKEN);
  });

  it('2xx 但没有 webUrl → instructions 指到仓库网页手动建 MR', async () => {
    const { fetch } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: ORG } },
      { match: (m, url) => m === 'GET' && url.endsWith(`/${REPO_ID}`), body: { id: 7561542 } },
      { match: (m, url) => m === 'POST' && url.includes('/changeRequests'), body: {} },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).openMr(mrReq);

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('手动发起合并请求');
  });

  it('organizationId 解析失败（token 无效）→ instructions 指 token，不带手动 MR 指引里的分支噪音', async () => {
    const { fetch } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), status: 401, body: { message: 'invalid token' } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).openMr(mrReq);

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('organizationId');
    expect(result.instructions).toContain('token');
  });

  it('config.repo 不是 Codeup 地址 → 错误 instructions，不发请求', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());

    const result = await createCodeupProvider(
      config({ repo: 'https://gitlab.example.com/team/repo.git' }),
      { EJDRONE_CODEUP_TOKEN: TOKEN },
      fetch,
    ).openMr(mrReq);

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('Codeup');
    expect(calls).toHaveLength(0);
  });
});

describe('apiPush（免 git：复用/新建分支 → 写文件 → 删文件 → 开 MR）', () => {
  it('新开分支全序列：platform/user → GET branches（无同前缀）→ POST branch → files → 数字 id → changeRequests', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(
      apiReq({ files: { 'skills/dev/a/SKILL.md': '# a\n', 'rules/dev/b.md': '# b\n' } }),
    );

    expect(result.url).toBe(MR_URL);
    expect(result.branch).toMatch(NEW_BRANCH_RE);
    const usedBranch = result.branch as string;
    // 序列：platform/user → GET branches → POST branches → 两次 POST files → GET repoId → POST changeRequests
    expect(calls[0]?.url).toContain('/platform/user');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url).toContain('/branches');
    expect(calls[2]?.url).toContain(`/branches?branch=${encodeURIComponent(usedBranch)}&ref=main`);
    expect(shapeOf(calls[3])).toBe(`POST ${ROOT}/${REPO_ID}/files`);
    expect(shapeOf(calls[4])).toBe(`POST ${ROOT}/${REPO_ID}/files`);
    expect(shapeOf(calls[5])).toBe(`GET ${ROOT}/${REPO_ID}`);
    expect(calls[6]?.url).toContain('/changeRequests');
    expect(calls[3]?.body).toMatchObject({
      filePath: 'skills/dev/a/SKILL.md',
      content: '# a\n',
      commitMessage: 'feat(dev): add skill a（ejdrone API 提交）',
      encoding: 'text',
    });
    expect(calls[6]?.body).toMatchObject({
      title: 'feat(dev): add skill a',
      sourceBranch: usedBranch,
      targetBranch: 'main',
      sourceProjectId: '7561542',
    });
  });

  it('同前缀分支已存在 → 就地复用（不再 POST /branches），MR 开在同一条分支上', async () => {
    const existing = 'ejdrone/push-1-20261019T000000Z';
    const { fetch, calls } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: ORG } },
      {
        match: (m, url) => m === 'GET' && url.includes('/branches'),
        body: [
          { name: 'main', defaultBranch: true, commit: { id: 'abc' } },
          { name: existing, defaultBranch: false, commit: { id: 'ddd' } },
        ],
      },
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), body: {} },
      { match: (m, url) => m === 'GET' && url.endsWith(`/${REPO_ID}`), body: { id: 7561542 } },
      { match: (m, url) => m === 'POST' && url.includes('/changeRequests'), body: { webUrl: MR_URL } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBe(MR_URL);
    expect(result.branch).toBe(existing);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/branches'))).toBe(false);
    expect(result.instructions).toContain('就地更新');
  });

  it('列不出远端分支（GET branches 404）→ 退回新开时间戳分支，推送不被卡死', async () => {
    const routes = fullRoutes().map((r) =>
      r.match.toString().includes('/branches') && r.match('GET', `/branches`)
        ? { ...r, status: 404, body: { message: 'nope' } }
        : r,
    );
    // GET branches 404、POST branches 正常：复用探测失败但建分支可用
    const { fetch, calls } = fakeFetch(routes);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBe(MR_URL);
    expect(result.branch).toMatch(NEW_BRANCH_RE);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/branches'))).toBe(true);
  });

  it('removedPaths 是目录（skills/<ns>/<name>）→ 按目标分支文件树展开成具体文件再逐个删除', async () => {
    const { fetch, calls } = fakeFetch([
      ...fullRoutes(),
      {
        match: (m, url) => m === 'GET' && url.includes('/files/tree'),
        body: [
          { path: 'skills/be/deploy/SKILL.md', type: 'blob' },
          { path: 'skills/be/deploy/helper.md', type: 'blob' },
          { path: 'skills/fe/other/SKILL.md', type: 'blob' },
        ],
      },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(
      apiReq({ removedPaths: ['skills/be/deploy'] }),
    );

    expect(result.url).toBe(MR_URL);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes.map((c) => c.url).every((u) => u.includes('deploy'))).toBe(true);
    // 目录路径本身绝不能被直接 DELETE（API 只认文件）：URL 不得以编码后的目录路径结尾
    const encodedDir = encodeURIComponent('skills/be/deploy');
    expect(deletes.some((c) => c.url.endsWith(encodedDir))).toBe(false);
    // 前缀不匹配的文件（fe/other）不许被误删
    expect(deletes.some((c) => c.url.includes('other'))).toBe(false);
  });

  it('删除路径 404（文件本来就不在）→ 视为目标状态已达成', async () => {
    const { fetch, calls } = fakeFetch([
      ...fullRoutes(),
      { match: (m, url) => m === 'GET' && url.includes('/files/tree'), body: [] },
      { match: (m, url) => m === 'DELETE' && url.includes('/files/'), status: 404, body: { message: 'file not found' } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(
      apiReq({ removedPaths: ['docs/gone.md'] }),
    );

    expect(result.url).toBe(MR_URL);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('createFile 报已存在（409，结构化状态码）→ 转 updateFile，MR 照常创建', async () => {
    const { fetch, calls } = fakeFetch([
      ...fullRoutes().slice(0, 3),
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), status: 409, body: { message: 'conflict' } },
      { match: (m, url) => m === 'PUT' && url.includes('/files/'), body: {} },
      ...fullRoutes().slice(6),
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBe(MR_URL);
    expect(shapeOf(calls[3])).toBe(`POST ${ROOT}/${REPO_ID}/files`);
    expect(shapeOf(calls[4])).toBe(`PUT ${ROOT}/${REPO_ID}/files/${encodeURIComponent('skills/dev/a/SKILL.md')}`);
  });

  it('错误文本含 "does not exist" 不会被误判成已存在（裸 exist 陷阱）', async () => {
    const { fetch, calls } = fakeFetch([
      ...fullRoutes().slice(0, 3),
      // 400 + 文本 "repository does not exist"：不是 409，且文本兜底用整词组，不许命中
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), status: 400, body: { message: 'repository does not exist' } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('does not exist');
    expect(result.instructions).toContain('合并请求未创建');
  });

  it('分支已存在（409）→ 不失败，继续写文件并开 MR', async () => {
    const routes = fullRoutes().map((r) =>
      r.match('POST', '/branches') && r.match.toString().includes("m === 'POST'")
        ? { ...r, status: 409, body: { message: 'branch already exists' } }
        : r,
    );
    const { fetch, calls } = fakeFetch(routes);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBe(MR_URL);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/files'))).toHaveLength(1);
  });

  it('文件写入失败（非已存在类）→ 不开 MR，instructions 点名失败文件与所在分支', async () => {
    const { fetch, calls } = fakeFetch([
      ...fullRoutes().slice(0, 3),
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), status: 500, body: { message: 'boom' } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBeNull();
    expect(result.branch).toMatch(NEW_BRANCH_RE);
    const text = result.instructions ?? '';
    expect(text).toContain('skills/dev/a/SKILL.md');
    expect(text).toContain('合并请求未创建');
    expect(calls.some((c) => c.url.includes('/changeRequests'))).toBe(false);
  });

  it('建分支失败（非已存在类）→ instructions 说明仓库无变化', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: ORG } },
      { match: (m, url) => m === 'GET' && url.includes('/branches'), body: [{ name: 'main', defaultBranch: true }] },
      { match: (m, url) => m === 'POST' && url.includes('/branches'), status: 403, body: { message: 'forbidden' } },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(apiReq());

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('建分支');
    expect(result.instructions).toContain('403');
    expect(calls.filter((c) => c.url.endsWith('/files'))).toHaveLength(0);
  });

  it('bootstrap=true（空仓库）→ 不建分支不开 MR，文件直写默认分支并标记 bootstrapped', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: ORG } },
      { match: (m, url) => m === 'GET' && url.includes('/branches'), body: [] },
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), body: {} },
    ]);

    const result = await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(
      apiReq({ bootstrap: true, files: { 'README.md': '# team\n', '.gitattributes': '* text=auto eol=lf\n' } }),
    );

    expect(result.url).toBeNull();
    expect(result.bootstrapped).toBe(true);
    expect(result.branch).toBe('main');
    expect(calls.some((c) => c.url.includes('/branches?'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/changeRequests'))).toBe(false);
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/files'))).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ branch: 'main', filePath: 'README.md' });
  });

  it('targetBranch 缺省回落 main', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());

    await createCodeupProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch).apiPush(
      apiReq({ targetBranch: undefined }),
    );

    expect(calls.find((c) => c.method === 'POST' && c.url.includes('/branches'))?.url).toContain('ref=main');
  });

  it('缺 token → instructions，一次请求都不发', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());

    const result = await createCodeupProvider(config(), {}, fetch).apiPush(apiReq());

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('EJDRONE_CODEUP_TOKEN');
    expect(calls).toHaveLength(0);
  });
});

describe('工厂分派', () => {
  it('makeGitProvider 对 provider=codeup 返回 codeup provider（含 apiPush）', async () => {
    const { fetch, calls } = fakeFetch(fullRoutes());
    const provider = makeGitProvider(config(), { EJDRONE_CODEUP_TOKEN: TOKEN }, fetch);

    expect(provider.kind).toBe('codeup');
    expect(typeof provider.apiPush).toBe('function');

    const result = await provider.openMr(mrReq);
    expect(result.url).toBe(MR_URL);
    expect(calls.filter((c) => c.url.includes('/platform/user'))).toHaveLength(1);
  });
});
