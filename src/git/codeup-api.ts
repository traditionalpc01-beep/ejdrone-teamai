import { parseRepoRef } from './gitlab.js';

/**
 * 云效 Codeup OpenAPI（中心站 oapi/v1）客户端：免 git 拉取（pull 降级）与 Codeup provider
 * （API 开 MR / 免 git 推送）共用的底层。
 *
 * 端点形状与鉴权方式 2026-10-19 对真实仓库 ejdrone/1C5P/ejdrone-teamai 冒烟核实：
 * - 基址 https://openapi-rdc.aliyuncs.com，鉴权头 `x-yunxiao-token: <个人访问令牌>`；
 * - repositoryId 可用 URL 编码的全路径（ejdrone%2F1C5P%2Fejdrone-teamai）或数字 id，
 *   get_repository / list_branches / files/tree 三条读路径均已真机命中；
 * - organizationId 必填，token 可从 GET /oapi/v1/platform/user 的 lastOrganization 补出；
 * - create branch（query 参数 branch/ref）、create file（body {branch,filePath,content,
 *   commitMessage,encoding}）、create changeRequest（body 含 sourceProjectId/targetProjectId，
 *   数字 id 经 get_repository 解析）的载荷字段取自本机 alibabacloud-devops-mcp-server 源码，
 *   **写路径未做真机回环验证**，provider 侧必须保留失败后的手动 MR 指引兜底。
 *
 * 红线（与 gitlab.ts 同源）：token 只从环境变量读，不落盘、不回显——所有对外文本
 * （含错误消息）都过 maskToken。
 */

export const CODEUP_API_BASE = 'https://openapi-rdc.aliyuncs.com';

/** 仓库地址里的 Codeup 主机。-region 站（devops.<region>.aliyuncs.com）出现前不做猜测。 */
const CODEUP_HOST = 'codeup.aliyun.com';

export interface CodeupClientOptions {
  token: string;
  organizationId: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** codeup.aliyun.com 的仓库地址 → true（scp 式与 https 形态都认）。 */
export function isCodeupUrl(repoUrl: string): boolean {
  const ref = parseRepoRef(repoUrl);
  return ref !== null && ref.baseUrl === `https://${CODEUP_HOST}`;
}

/** 从仓库地址取 `org/group/repo`（不含 .git）。不是 Codeup 地址返回 null。 */
export function codeupProjectPath(repoUrl: string): string | null {
  return isCodeupUrl(repoUrl) ? parseRepoRef(repoUrl)?.projectPath ?? null : null;
}

/**
 * projectPath → URL 编码的 repositoryId（`ejdrone%2F1C5P%2Fejdrone-teamai`）。
 * 逐段 encodeURIComponent 再以 %2F 连接：段内可能有中文、空格（仓库目录就有），整段一起编码
 * 会把分隔斜杠也吃掉。真机命名的就是这种全编码形态。
 */
export function encodeCodeupRepoId(projectPath: string): string {
  return projectPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('%2F');
}

/** token 读取：EJDRONE_CODEUP_TOKEN 优先，回落云效生态通用的 YUNXIAO_ACCESS_TOKEN。 */
export function readCodeupToken(env: NodeJS.ProcessEnv): string {
  const primary = env.EJDRONE_CODEUP_TOKEN;
  if (primary && primary.trim() !== '') return primary.trim();
  const fallback = env.YUNXIAO_ACCESS_TOKEN;
  if (fallback && fallback.trim() !== '') return fallback.trim();
  return '';
}

/**
 * 结构化 API 错误：调用方（provider 层）按 status 判定「已存在 / 不存在 / 权限」，
 * **不要**对错误文本做无词边界的数字正则——正文里的 trace id、局部 MR 号（"!409"）
 * 都会误命中。message 保留 `Codeup OpenAPI <status>: …` 前缀，人读与结构化两不误。
 */
export class CodeupApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'CodeupApiError';
    this.status = status;
  }
}

/** 单次请求的超时：黑洞型网络（防火墙丢包不回 RST）下 Node fetch 默认无连接超时，
 * 会挂到 OS 层 TCP 放弃（Windows 常见 2 分钟）——对会话启动 hook 里的静默 pull 是灾难体感。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 与 gitlab.ts 同款：错误文本里绝不让 token 原文出现。 */
export function maskCodeupToken(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]');
}

/** GET /oapi/v1/platform/user → lastOrganization。免 git 成员不用手填 organizationId 的关键。 */
export async function getCurrentOrganizationId(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  baseUrl: string = CODEUP_API_BASE,
): Promise<string> {
  const doc = (await codeupRequest('/oapi/v1/platform/user', { token, fetchImpl, baseUrl })) as {
    lastOrganization?: unknown;
  };
  const orgId = doc?.lastOrganization;
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    throw new Error('Codeup 未返回 lastOrganization（token 可能无效或不属于任何组织）');
  }
  return orgId.trim();
}

interface RequestOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  method?: string;
  /** JSON body（POST/PUT）；查询参数由各调用方拼进 path */
  body?: unknown;
}

/** 单次 oapi 请求：非 2xx 抛带状态码与截断摘要的 CodeupApiError，全文过 mask。 */
async function codeupRequest(path: string, opts: RequestOptions): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const base = (opts.baseUrl ?? CODEUP_API_BASE).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-yunxiao-token': opts.token,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      // 不跟随重定向：x-yunxiao-token 是自定义头，undici 跨域重定向只剥 Authorization 类
      // 标准头，自定义头会随 302 一起发往新主机——网关/代理一旦返回指向外部的重定向，
      // 成员的云效令牌就明文泄给第三方。manual 下检测到 3xx/opaque 直接拒绝。
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as { name?: string; message?: string };
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const reason = err instanceof Error ? err.message : String(e);
    throw new Error(
      timedOut
        ? `无法访问 Codeup OpenAPI（${REQUEST_TIMEOUT_MS / 1000} 秒超时，检查网络/代理）`
        : `无法访问 Codeup OpenAPI（网络错误: ${maskCodeupToken(reason, opts.token)}）`,
    );
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new Error('Codeup OpenAPI 返回了重定向，已拒绝跟随（令牌不允许发往其他主机）');
  }
  const text = await res.text();
  if (!res.ok) {
    const flat = maskCodeupToken(text.replace(/\s+/g, ' ').trim(), opts.token).slice(0, 300);
    throw new CodeupApiError(res.status, `Codeup OpenAPI ${res.status}: ${flat}`);
  }
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Codeup OpenAPI 返回了非 JSON 内容（前 300 字符: ${maskCodeupToken(text.slice(0, 300), opts.token)}）`);
  }
}

export interface CodeupBranchInfo {
  name: string;
  defaultBranch: boolean;
  /** 分支头提交 id；空串表示响应里没带 */
  commitId: string;
}

export interface CodeupClient {
  /** 仓库数字 id（创建 MR 的 sourceProjectId/targetProjectId 要用它）。 */
  repositoryId(repoId: string): Promise<string>;
  listBranches(repoId: string): Promise<CodeupBranchInfo[]>;
  /** 递归文件树，只返回 blob 的相对路径。 */
  listFilePaths(repoId: string, ref: string): Promise<string[]>;
  /** 单文件内容（base64/text 按 encoding 解码，统一返回 utf-8 文本）。 */
  getFile(repoId: string, ref: string, filePath: string): Promise<string>;
  createBranch(repoId: string, branch: string, ref: string): Promise<void>;
  /** 新建文件；已存在时抛错（调用方决定是否转 updateFile）。 */
  createFile(repoId: string, args: { branch: string; filePath: string; content: string; commitMessage: string }): Promise<void>;
  updateFile(repoId: string, args: { branch: string; filePath: string; content: string; commitMessage: string }): Promise<void>;
  deleteFile(repoId: string, args: { branch: string; filePath: string; commitMessage: string }): Promise<void>;
  createChangeRequest(repoId: string, args: {
    title: string;
    sourceBranch: string;
    targetBranch: string;
    description?: string;
  }): Promise<{ webUrl: string | null }>;
}

export function createCodeupClient(opts: CodeupClientOptions): CodeupClient {
  const { token, organizationId } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? CODEUP_API_BASE;
  const root = `/oapi/v1/codeup/organizations/${organizationId}/repositories`;

  const request = (method: string, path: string, body?: unknown): Promise<unknown> =>
    codeupRequest(path, { token, fetchImpl, baseUrl, method, body });

  // 仓库数字 id 的解析收进闭包：createChangeRequest 要用它填 source/targetProjectId，
  // 走闭包而不是对象方法的 this（对象字面量方法的 this 绑定在解构/spy 重构下会丢）。
  const fetchRepositoryId = async (repoId: string): Promise<string> => {
    const doc = (await request('GET', `${root}/${repoId}`)) as { id?: unknown };
    const id = doc?.id;
    if (typeof id === 'number') return String(id);
    if (typeof id === 'string' && id.trim() !== '') return id.trim();
    throw new Error('Codeup 没有返回仓库数字 id（无法创建合并请求）');
  };

  /** 文件路径整体 encodeURIComponent：斜杠、中文、空格都必须进 %XX，单段拼回路径参数。 */
  const encPath = (filePath: string): string => encodeURIComponent(filePath);

  const query = (params: Record<string, string>): string => {
    const qs = new URLSearchParams(params).toString();
    return qs === '' ? '' : `?${qs}`;
  };

  return {
    repositoryId: fetchRepositoryId,

    async listBranches(repoId) {
      // 团队仓分支数是个位数；perPage=100 一次取全，超出的形态等真出现再加翻页
      const doc = (await request('GET', `${root}/${repoId}/branches${query({ perPage: '100' })}`)) as unknown;
      const list = Array.isArray(doc) ? doc : [];
      return list
        .map((raw) => {
          const item = raw as { name?: unknown; defaultBranch?: unknown; commit?: { id?: unknown } };
          return {
            name: typeof item.name === 'string' ? item.name : '',
            defaultBranch: item.defaultBranch === true,
            commitId:
              typeof item.commit?.id === 'string' ? (item.commit.id as string) : '',
          };
        })
        .filter((b) => b.name !== '');
    },

    async listFilePaths(repoId, ref) {
      // 官方 MCP 客户端（alibabacloud-devops-mcp-server）对该端点只传 path/ref/type，
      // 不带任何分页参数——端点按全量返回设计，这里保持同构。若未来证实大仓会被静默
      // 截断，消费方（gitless 的清空重建）必须先拿到翻页能力再谈「清空」。
      const doc = (await request(
        'GET',
        `${root}/${repoId}/files/tree${query({ type: 'RECURSIVE', ref })}`,
      )) as unknown;
      const list = Array.isArray(doc) ? doc : [];
      return list
        .map((raw) => {
          const item = raw as { path?: unknown; type?: unknown };
          return typeof item.path === 'string' && item.type === 'blob' ? item.path : null;
        })
        .filter((p): p is string => p !== null);
    },

    async getFile(repoId, ref, filePath) {
      const doc = (await request(
        'GET',
        `${root}/${repoId}/files/${encPath(filePath)}${query({ ref })}`,
      )) as { content?: unknown; encoding?: unknown };
      const content = doc?.content;
      if (typeof content !== 'string') throw new Error(`Codeup 没有返回 ${filePath} 的内容`);
      const encoding = typeof doc?.encoding === 'string' ? doc.encoding : 'base64';
      if (encoding === 'base64') return Buffer.from(content, 'base64').toString('utf8');
      return content;
    },

    async createBranch(repoId, branch, ref) {
      // MCP 源码里 create branch 走 query 参数（branch/ref），不是 body
      await request('POST', `${root}/${repoId}/branches${query({ branch, ref })}`);
    },

    async createFile(repoId, args) {
      await request('POST', `${root}/${repoId}/files`, { ...args, encoding: 'text' });
    },

    async updateFile(repoId, args) {
      await request('PUT', `${root}/${repoId}/files/${encPath(args.filePath)}`, { ...args, encoding: 'text' });
    },

    async deleteFile(repoId, args) {
      await request('DELETE', `${root}/${repoId}/files/${encPath(args.filePath)}`, {
        branch: args.branch,
        commitMessage: args.commitMessage,
      });
    },

    async createChangeRequest(repoId, args) {
      const projectId = await fetchRepositoryId(repoId);
      const body: Record<string, unknown> = {
        title: args.title,
        sourceBranch: args.sourceBranch,
        targetBranch: args.targetBranch,
        // 同仓 MR：源=目标=本仓库数字 id（MCP 源码的自动解析逻辑就是这样补的）
        sourceProjectId: projectId,
        targetProjectId: projectId,
        createFrom: 'WEB',
      };
      if (args.description !== undefined) body.description = args.description;
      const doc = (await request('POST', `${root}/${repoId}/changeRequests`, body)) as {
        webUrl?: unknown;
      };
      return { webUrl: typeof doc?.webUrl === 'string' && doc.webUrl !== '' ? doc.webUrl : null };
    },
  };
}
