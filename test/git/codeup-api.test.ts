import { describe, expect, it } from 'vitest';

import {
  CodeupApiError,
  codeupProjectPath,
  createCodeupClient,
  encodeCodeupRepoId,
  getCurrentOrganizationId,
  isCodeupUrl,
  maskCodeupToken,
  readCodeupToken,
} from '../../src/git/codeup-api.js';

/** 可编程 fetch 假件：按 (method, path) 记录请求并返回预设响应；gitlab.test.ts 同款思路，不打真实 API。 */
function fakeFetch(
  routes: Array<{ match: (method: string, url: string) => boolean; status?: number; body: unknown }>,
): { fetch: typeof fetch; calls: Array<{ method: string; url: string; body?: unknown }> } {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    for (const route of routes) {
      if (route.match(method, url)) {
        return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('{"message":"no route"}}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const TOKEN = 'pat-secret-token';
const REPO = 'ejdrone%2F1C5P%2Fejdrone-teamai';
const ROOT = `/oapi/v1/codeup/organizations/org-1/repositories`;

describe('isCodeupUrl / codeupProjectPath / encodeCodeupRepoId', () => {
  it('https 与 .git 后缀都认，主机名必须是 codeup.aliyun.com', () => {
    expect(isCodeupUrl('https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git')).toBe(true);
    expect(isCodeupUrl('https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai')).toBe(true);
    expect(isCodeupUrl('https://gitlab.example.com/team/repo.git')).toBe(false);
    expect(isCodeupUrl('https://github.com/team/repo.git')).toBe(false);
  });

  it('projectPath 去掉 .git；非 Codeup 地址返回 null', () => {
    expect(codeupProjectPath('https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git')).toBe(
      'ejdrone/1C5P/ejdrone-teamai',
    );
    expect(codeupProjectPath('https://gitlab.example.com/team/repo.git')).toBeNull();
  });

  it('repoId 逐段编码：中文与空格进 %XX，分隔斜杠成 %2F', () => {
    expect(encodeCodeupRepoId('ejdrone/1C5P/ejdrone-teamai')).toBe(REPO);
    expect(encodeCodeupRepoId('ejdrone/g 1/仓库名')).toBe('ejdrone%2Fg%201%2F%E4%BB%93%E5%BA%93%E5%90%8D');
  });
});

describe('readCodeupToken / maskCodeupToken', () => {
  it('EJDRONE_CODEUP_TOKEN 优先，回落 YUNXIAO_ACCESS_TOKEN，都没有返回空串', () => {
    expect(readCodeupToken({ EJDRONE_CODEUP_TOKEN: ' a ' })).toBe('a');
    expect(readCodeupToken({ YUNXIAO_ACCESS_TOKEN: 'b' })).toBe('b');
    expect(readCodeupToken({ EJDRONE_CODEUP_TOKEN: '', YUNXIAO_ACCESS_TOKEN: 'b' })).toBe('b');
    expect(readCodeupToken({})).toBe('');
  });

  it('mask 把 token 原文从任意文本里替换掉', () => {
    expect(maskCodeupToken(`boom ${TOKEN} boom`, TOKEN)).not.toContain(TOKEN);
    expect(maskCodeupToken('no token here', '')).toBe('no token here');
  });
});

describe('getCurrentOrganizationId', () => {
  it('从 /oapi/v1/platform/user 取 lastOrganization', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { lastOrganization: 'org-1' } },
    ]);
    await expect(getCurrentOrganizationId(TOKEN, fetch)).resolves.toBe('org-1');
    expect(calls[0]?.headers).toBeUndefined(); // headers 不进记录，token 只在真实请求头里
  });

  it('缺失 lastOrganization 时报可读错误', async () => {
    const { fetch } = fakeFetch([
      { match: (_m, url) => url.endsWith('/oapi/v1/platform/user'), body: { userId: 'x' } },
    ]);
    await expect(getCurrentOrganizationId(TOKEN, fetch)).rejects.toThrow(/lastOrganization/);
  });
});

describe('createCodeupClient 读路径', () => {
  it('listBranches 取 name/defaultBranch/commit.id', async () => {
    const { fetch } = fakeFetch([
      {
        match: (_m, url) => url.includes(`/branches`),
        body: [
          { name: 'main', defaultBranch: true, commit: { id: 'fe6c9664' } },
          { name: 'ejdrone/push-x', defaultBranch: false, commit: { id: 'abc' } },
          { noName: true },
        ],
      },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    const branches = await client.listBranches(REPO);
    expect(branches).toEqual([
      { name: 'main', defaultBranch: true, commitId: 'fe6c9664' },
      { name: 'ejdrone/push-x', defaultBranch: false, commitId: 'abc' },
    ]);
  });

  it('listFilePaths 只要 blob 的 path，tree 项跳过', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: (_m, url) => url.includes('/files/tree'),
        body: [
          { path: 'skills', type: 'tree' },
          { path: 'skills/dev/code-review/SKILL.md', type: 'blob' },
          { path: 'learnings/2026-10-14-推送团队资源时.md', type: 'blob' },
        ],
      },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    await expect(client.listFilePaths(REPO, 'main')).resolves.toEqual([
      'skills/dev/code-review/SKILL.md',
      'learnings/2026-10-14-推送团队资源时.md',
    ]);
    expect(calls[0]?.url).toContain('type=RECURSIVE');
    expect(calls[0]?.url).toContain('ref=main');
  });

  it('getFile：base64 解码为 utf-8，text 原样返回；路径整体编码', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: (_m, url) => url.includes('/files/'),
        body: { content: Buffer.from('# 标题\n', 'utf8').toString('base64'), encoding: 'base64' },
      },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    await expect(client.getFile(REPO, 'main', 'learnings/中文 名称.md')).resolves.toBe('# 标题\n');
    // 中文与空格都进了 %XX，斜杠也是
    expect(calls[0]?.url).toContain(encodeURIComponent('learnings/中文 名称.md'));
  });
});

describe('createCodeupClient 写路径', () => {
  it('createBranch 走 query 参数 branch/ref', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (m, url) => m === 'POST' && url.includes('/branches'), body: {} },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    await client.createBranch(REPO, 'ejdrone/push-1', 'main');
    const call = calls[0];
    expect(call?.url).toContain(`branch=${encodeURIComponent('ejdrone/push-1')}`);
    expect(call?.url).toContain('ref=main');
    expect(call?.body).toBeUndefined();
  });

  it('createFile / updateFile 载荷含 branch+filePath+content+commitMessage+encoding', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (m, url) => m === 'POST' && url.endsWith('/files'), body: {} },
      { match: (m, url) => m === 'PUT' && url.includes('/files/'), body: {} },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    await client.createFile(REPO, {
      branch: 'ejdrone/push-1',
      filePath: 'skills/a/SKILL.md',
      content: '# a',
      commitMessage: 'add a',
    });
    await client.updateFile(REPO, {
      branch: 'ejdrone/push-1',
      filePath: 'skills/b/SKILL.md',
      content: '# b',
      commitMessage: 'edit b',
    });
    expect(calls[0]?.body).toEqual({
      branch: 'ejdrone/push-1',
      filePath: 'skills/a/SKILL.md',
      content: '# a',
      commitMessage: 'add a',
      encoding: 'text',
    });
    expect(calls[1]?.url).toContain(`/files/${encodeURIComponent('skills/b/SKILL.md')}`);
  });

  it('createChangeRequest 先解析数字 id 再 POST，源/目标项目都是该 id', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (_m, url) => url.endsWith(`/${REPO}`), body: { id: 7561542, name: 'ejdrone-teamai' } },
      { match: (m, url) => m === 'POST' && url.includes('/changeRequests'), body: { webUrl: 'https://codeup.aliyun.com/x/mr/1' } },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    const mr = await client.createChangeRequest(REPO, {
      title: 'add skill',
      sourceBranch: 'ejdrone/push-1',
      targetBranch: 'main',
      description: 'body',
    });
    expect(mr.webUrl).toBe('https://codeup.aliyun.com/x/mr/1');
    expect(calls[1]?.body).toMatchObject({
      title: 'add skill',
      sourceBranch: 'ejdrone/push-1',
      targetBranch: 'main',
      sourceProjectId: '7561542',
      targetProjectId: '7561542',
    });
  });

  it('非 2xx 抛带状态码的错误，且响应文本里的 token 被抹掉', async () => {
    const { fetch } = fakeFetch([
      {
        match: (_m, url) => url.includes('/files/tree'),
        status: 401,
        body: { message: `bad token ${TOKEN}` },
      },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    const err = await client.listFilePaths(REPO, 'main').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('[redacted]');
  });

  it('非 2xx 抛 CodeupApiError，status 结构化可读（provider 层按它分派，不做文本正则）', async () => {
    const { fetch } = fakeFetch([
      { match: (m, url) => m === 'POST' && url.includes('/branches'), status: 409, body: { message: 'conflict' } },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    const err = await client.createBranch(REPO, 'x', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeupApiError);
    expect((err as CodeupApiError).status).toBe(409);
    expect((err as CodeupApiError).message).toContain('Codeup OpenAPI 409');
  });

  it('302 重定向被拒绝（token 不许发往其他主机），错误说明原因', async () => {
    const { fetch } = fakeFetch([
      {
        match: (_m, url) => url.includes('/files/tree'),
        status: 302,
        body: '',
      },
    ]);
    const client = createCodeupClient({ token: TOKEN, organizationId: 'org-1', fetchImpl: fetch });
    const err = await client.listFilePaths(REPO, 'main').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('重定向');
    expect(err.message).toContain('拒绝跟随');
  });
});
