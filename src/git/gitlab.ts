import type { Config, GitProvider, MrRequest, MrResult } from '../core/types.js';
import { repoDir } from '../state.js';
import { defaultBranch, scrubCredentials } from './repo.js';

/**
 * GitLab 开 MR。token 只从环境变量读，绝不落盘，也绝不出现在任何输出里
 * （包括错误消息 —— 所有对外文本都过 maskToken）。
 */

export interface RepoRef {
  /** scheme://host，不含尾部斜杠 */
  baseUrl: string;
  /** group/sub/project，不含 .git */
  projectPath: string;
}

const SCP_LIKE = /^[^@/\s]+@([^:/\s]+):(.+)$/;

/**
 * 支持 `https://host/group/sub/project.git` 与 `git@host:group/sub/project.git`，
 * 以及 `ssh://git@host/group/project.git`（web 界面仍走 https）。
 */
export function parseRepoRef(repoUrl: string): RepoRef | null {
  const raw = repoUrl.trim();
  if (raw === '') return null;

  let host = '';
  let scheme = 'https';
  let path = '';

  try {
    const u = new URL(raw);
    if (u.protocol === 'ssh:' || u.protocol === 'git:') scheme = 'https';
    else if (u.protocol === 'http:' || u.protocol === 'https:') scheme = u.protocol.slice(0, -1);
    else return null;
    host = u.host;
    path = u.pathname;
  } catch {
    const m = SCP_LIKE.exec(raw);
    if (!m || !m[1] || !m[2]) return null;
    host = m[1];
    path = m[2];
  }

  const projectPath = normalizeProjectPath(path);
  if (!projectPath) return null;
  return { baseUrl: `${scheme}://${host}`, projectPath };
}

function normalizeProjectPath(path: string): string | null {
  const trimmed = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const withoutSuffix = trimmed.endsWith('.git') ? trimmed.slice(0, -'.git'.length) : trimmed;
  const segments = withoutSuffix.split('/').filter((s) => s !== '');
  if (segments.length < 2) return null;
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return segments.join('/');
}

/** GitLab 网页"新建 MR"链接；查询参数名与分支名都必须 encode */
export function newMrWebUrl(baseUrl: string, projectPath: string, branch: string): string {
  return `${baseUrl}/${projectPath}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}

function readToken(env: NodeJS.ProcessEnv): string {
  const primary = env.EJDRONE_GITLAB_TOKEN;
  if (primary && primary.trim() !== '') return primary.trim();
  const fallback = env.GL_TOKEN;
  if (fallback && fallback.trim() !== '') return fallback.trim();
  return '';
}

function maskToken(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('[redacted]');
}

function missingTokenInstructions(manualUrl: string): string {
  return `分支已推送。设置 EJDRONE_GITLAB_TOKEN 后重跑 ejdrone push，或用下面的链接手动开 MR: ${manualUrl}`;
}

export function createGitlabProvider(
  config: Config,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): GitProvider {
  return {
    kind: 'gitlab',
    async openMr(req: MrRequest): Promise<MrResult> {
      const ref = parseRepoRef(config.repo);
      if (!ref) {
        // config.repo 可能内嵌凭据，回显前先抹掉
        throw new Error(`Cannot derive a GitLab project path from repo URL: ${scrubCredentials(config.repo)}`);
      }
      const baseUrl = (config.gitlabBaseUrl?.trim() || ref.baseUrl).replace(/\/+$/, '');
      const manualUrl = newMrWebUrl(baseUrl, ref.projectPath, req.branch);
      const token = readToken(env);
      if (token === '') return { url: null, instructions: missingTokenInstructions(manualUrl) };

      const targetBranch = req.targetBranch?.trim() || (await detectTargetBranch(env));
      try {
        const res = await fetchImpl(
          `${baseUrl}/api/v4/projects/${encodeURIComponent(ref.projectPath)}/merge_requests`,
          {
            method: 'POST',
            headers: { 'PRIVATE-TOKEN': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source_branch: req.branch,
              target_branch: targetBranch,
              title: req.title,
              description: req.body,
              remove_source_branch: true,
            }),
          },
        );
        const text = await readBody(res);
        if (!res.ok) {
          return { url: null, instructions: httpInstructions(res.status, text, req.branch, token, manualUrl) };
        }
        const webUrl = extractWebUrl(text);
        if (webUrl) return { url: webUrl };
        return {
          url: null,
          instructions: `GitLab 接受了请求但没有返回 MR 链接（响应: ${truncate(maskToken(text, token), 300)}）。分支 ${req.branch} 已推送，请用链接手动开 MR: ${manualUrl}`,
        };
      } catch (e) {
        const reason = maskToken(errorMessage(e), token);
        return {
          url: null,
          instructions: `无法访问 GitLab API（网络错误: ${reason}）。分支 ${req.branch} 已推送成功，请重跑 ejdrone push 或用链接手动开 MR: ${manualUrl}`,
        };
      }
    },
  };
}

/** 本地 clone 能读到就用真实默认分支；读不到（首次 push、无 clone）回落 main。 */
async function detectTargetBranch(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    return await defaultBranch(repoDir(env), env);
  } catch {
    return 'main';
  }
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function extractWebUrl(text: string): string | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== 'object') return null;
  const webUrl = (doc as { web_url?: unknown }).web_url;
  return typeof webUrl === 'string' && webUrl.trim() !== '' ? webUrl : null;
}

/** 从 GitLab 的错误 JSON 里抽出人类可读摘要（不回显请求头，避免带出 token） */
function errorSummary(text: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  if (doc === null || typeof doc !== 'object') return text;
  const bag = doc as Record<string, unknown>;
  for (const key of ['message', 'error', 'errors']) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (value !== undefined && value !== null) return JSON.stringify(value);
  }
  return JSON.stringify(bag);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function httpInstructions(status: number, text: string, branch: string, token: string, manualUrl: string): string {
  const hint =
    status === 401 || status === 403
      ? '（EJDRONE_GITLAB_TOKEN 无效、过期或对该项目没有权限）'
      : status === 400
        ? '（常见原因：同名 MR 已存在、分支或目标分支不匹配）'
        : '';
  return `MR 未能创建，但分支 ${branch} 已推送成功。GitLab 返回 ${status}: ${truncate(maskToken(errorSummary(text), token), 300)}${hint}。修正后可重跑 ejdrone push，或用链接手动开 MR: ${manualUrl}`;
}
