import type { ApiPushRequest, Config, GitProvider, MrRequest, MrResult } from '../core/types.js';
import {
  CodeupApiError,
  codeupProjectPath,
  createCodeupClient,
  encodeCodeupRepoId,
  getCurrentOrganizationId,
  maskCodeupToken,
  readCodeupToken,
} from './codeup-api.js';

/**
 * Codeup provider：OpenAPI 自动开 MR + 免 git 推送（API 建分支 → 写文件 → 删文件 → 开 MR）。
 *
 * 与 gitlab.ts 同一姿态：
 * - token 只从环境变量读（readCodeupToken），不落盘、不回显，所有对外文本过 mask；
 * - 失败一律折进 MrResult.instructions，绝不上抛 —— 分支/文件可能已经推了一半，
 *   把错误抛出去会让上层把它误报成「push 失败」，而此时恰恰需要的是手动收尾指引。
 *
 * 「已存在 / 不存在」的判定优先读 CodeupApiError.status（结构化），错误文本只作兜底
 * —— 文本兜底用带词组的正则（already exist / not found），裸 'exist' 会把
 * 'does not exist' 误判成已存在。
 *
 * 写路径（建分支/写文件/开 MR）未做真机回环验证（见 codeup-api.ts 头注释），
 * 所以每条失败路径都必须能落到「如何手动继续」。
 */

const DEFAULT_TARGET_BRANCH = 'main';
const CODEUP_WEB_BASE = 'https://codeup.aliyun.com';

interface Access {
  client: ReturnType<typeof createCodeupClient>;
  repoId: string;
  token: string;
}

type AccessResult = { ok: true; access: Access } | { ok: false; result: MrResult };

function repoWebUrl(projectPath: string): string {
  return `${CODEUP_WEB_BASE}/${projectPath}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 已存在：结构化 status 409 优先；文本兜底匹配「已存在 / already exist」（整词组，
 * 'does not exist' 里的裸 exist 不许命中）。400 不算——它多半是参数校验错误，
 * 误判成已存在会静默转 updateFile 把真因盖掉。 */
function isAlreadyExists(e: unknown): boolean {
  if (e instanceof CodeupApiError) return e.status === 409;
  return /已存在|already exist/i.test(errorMessage(e));
}

/** 不存在（删除时目标已不在 = 目标状态已达成）：status 404 优先，文本兜底同上原则。 */
function isNotFound(e: unknown): boolean {
  if (e instanceof CodeupApiError) return e.status === 404;
  return /不存在|not found/i.test(errorMessage(e));
}

/** 与 cli/mr.ts 的 stamp 同形（UTC 定宽时间戳）。本地实现一份：git 层反向依赖 cli 层
 * 会造成 mr→provider→codeup→mr 的 import 环。 */
function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 共用前置解析：repo 地址 → projectPath / repoId，token → orgId → client。
 * organizationId 每次现算（与 gitless.ts 同策略，不落 config）：缓存会把「换 token /
 * 换组织」冻在陈旧值里，出现 pull 正常、push 404 的自相矛盾。任何一步不成立都返回
 * instructions（不抛），文案里带下一步。
 */
async function resolveAccess(
  config: Config,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<AccessResult> {
  const projectPath = codeupProjectPath(config.repo);
  if (projectPath === null) {
    return {
      ok: false,
      result: {
        url: null,
        instructions: `config 里的仓库地址不是 Codeup 仓库（${config.repo}），provider 却是 codeup。请核对 ejdrone init 的仓库地址，或改用匹配的 --provider`,
      },
    };
  }
  const token = readCodeupToken(env);
  if (token === '') {
    return {
      ok: false,
      result: {
        url: null,
        instructions: `未设置 EJDRONE_CODEUP_TOKEN（云效个人访问令牌）。设置后重跑 ejdrone push；或打开 ${repoWebUrl(projectPath)} 从分支手动发起合并请求`,
      },
    };
  }
  const repoId = encodeCodeupRepoId(projectPath);
  try {
    const organizationId = await getCurrentOrganizationId(token, fetchImpl);
    return {
      ok: true,
      access: { client: createCodeupClient({ token, organizationId, fetchImpl }), repoId, token },
    };
  } catch (e) {
    return {
      ok: false,
      result: {
        url: null,
        instructions: `无法确定 Codeup organizationId（${maskCodeupToken(errorMessage(e), token)}）。请确认 token 有效且属于仓库所在组织`,
      },
    };
  }
}

/** 从 Codeup 错误里给一条人类可读的原因猜测，形态照 gitlab.ts 的 httpInstructions；
 * 优先结构化 status，文本兜底（找不到 status 时无 hint，不猜）。 */
function statusHint(e: unknown): string {
  const status = e instanceof CodeupApiError ? e.status : null;
  if (status === 401 || status === 403) return '（EJDRONE_CODEUP_TOKEN 无效、过期或对该仓库没有权限）';
  if (status === 400 || status === 409) return '（常见原因：同名合并请求已存在、源分支与目标分支相同）';
  return '';
}

export function createCodeupProvider(
  config: Config,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): GitProvider {
  const manualMrHint = (branch: string): string => {
    const projectPath = codeupProjectPath(config.repo);
    const web = projectPath === null ? config.repo : repoWebUrl(projectPath);
    return `请打开 ${web} 从分支 ${branch} 手动发起合并请求`;
  };

  /** MR 创建 + 结果包装，openMr 与 apiPush 共用同一控制流（修一处两边同步生效）。 */
  const createMr = async (
    access: Access,
    args: { title: string; sourceBranch: string; targetBranch: string; description: string },
  ): Promise<MrResult> => {
    try {
      const mr = await access.client.createChangeRequest(access.repoId, args);
      if (mr.webUrl) return { url: mr.webUrl, branch: args.sourceBranch };
      return {
        url: null,
        branch: args.sourceBranch,
        instructions: `Codeup 接受了请求但没有返回合并请求链接。${manualMrHint(args.sourceBranch)}`,
      };
    } catch (e) {
      const reason = maskCodeupToken(errorMessage(e), access.token);
      return {
        url: null,
        branch: args.sourceBranch,
        instructions: `合并请求未能创建。${reason}${statusHint(e)}。修正后可重跑 ejdrone push；或${manualMrHint(args.sourceBranch)}`,
      };
    }
  };

  return {
    kind: 'codeup',

    async openMr(req: MrRequest): Promise<MrResult> {
      const resolved = await resolveAccess(config, env, fetchImpl);
      if (!resolved.ok) return resolved.result;
      return createMr(resolved.access, {
        title: req.title,
        sourceBranch: req.branch,
        targetBranch: req.targetBranch?.trim() || DEFAULT_TARGET_BRANCH,
        description: req.body,
      });
    },

    async apiPush(req: ApiPushRequest): Promise<MrResult> {
      const resolved = await resolveAccess(config, env, fetchImpl);
      if (!resolved.ok) return resolved.result;
      const { client, repoId, token } = resolved.access;
      const targetBranch = req.targetBranch?.trim() || DEFAULT_TARGET_BRANCH;
      const commitMessage = `${req.title}（ejdrone API 提交）`;

      // 空仓库首笔引导：不开分支不开 MR，文件直写默认分支（对应 git 路径的 bootstrap：
      // 直推 targetBranch + 顺手带 README/.gitattributes，由 mr.ts 组装进 files）。
      if (req.bootstrap === true) {
        const failures: string[] = [];
        for (const [filePath, content] of Object.entries(req.files)) {
          try {
            await client.createFile(repoId, { branch: targetBranch, filePath, content, commitMessage });
          } catch (e) {
            const reason = maskCodeupToken(errorMessage(e), token);
            if (!isAlreadyExists(e)) failures.push(`${filePath}: ${reason}`);
          }
        }
        if (failures.length > 0) {
          return {
            url: null,
            branch: targetBranch,
            instructions: [
              `空仓库引导提交部分失败（默认分支 ${targetBranch} 上可能已有部分文件）：`,
              ...failures.map((f) => `  - ${f}`),
              '下一步：逐项处理后重试；或在网页上手动补齐后运行 ejdrone pull 分发。',
            ].join('\n'),
          };
        }
        return {
          url: null,
          branch: targetBranch,
          bootstrapped: true,
          instructions: `空仓库引导提交已直接写入默认分支 ${targetBranch}，无需合并请求`,
        };
      }

      // 分支策略：按前缀复用远端既有分支（与 git 路径 listRemoteBranches 的复用语义
      // 对齐——同一资源重复推送更新同一条分支/MR，不开重复 MR）。列不出分支（网络/
      // 权限抖动）就退回新开时间戳分支，宁可多开一条也不让推送卡死。
      let branch = `${req.branchPrefix}${stamp()}`;
      let reusedNote = '';
      try {
        const names = (await client.listBranches(repoId))
          .map((b) => b.name)
          .filter((name) => name.startsWith(req.branchPrefix))
          .sort();
        const existing = names[names.length - 1];
        if (existing !== undefined) {
          branch = existing;
          reusedNote = `该资源已有未合并分支 ${existing}，就地更新（不再开重复 MR 分支）；`;
        }
      } catch {
        /* 列不出远端分支：退回新开分支 */
      }

      // 1. 建分支（复用时跳过）。已存在类错误（并发推送同前缀）不算失败，直接继续写。
      if (reusedNote === '') {
        try {
          await client.createBranch(repoId, branch, targetBranch);
        } catch (e) {
          const reason = maskCodeupToken(errorMessage(e), token);
          if (!isAlreadyExists(e)) {
            return {
              url: null,
              branch,
              instructions: `免 git 推送在第 1 步（建分支 ${branch}）失败：${reason}${statusHint(e)}。` +
                `仓库内容没有变化（若服务端实际已建出分支，可到网页确认后重试）；或装好 git 后重跑（会改走本地 git push）`,
            };
          }
        }
      }

      // 2. 逐文件写入：createFile 失败若是「已存在」类（分支上已有该文件）转 updateFile，
      //    其余失败记账继续 —— 尽量把其余文件推完，最后统一汇报。
      //    注意：Codeup oapi 没有批量提交端点，每个文件是一个独立 commit（MR 提交列表
      //    会有同标题的一串），重度提交场景引导成员装 git 走单 commit 路径。
      const failures: string[] = [];
      for (const [filePath, content] of Object.entries(req.files)) {
        try {
          await client.createFile(repoId, { branch, filePath, content, commitMessage });
        } catch (e) {
          if (!isAlreadyExists(e)) {
            failures.push(`${filePath}: ${maskCodeupToken(errorMessage(e), token)}`);
            continue;
          }
          try {
            await client.updateFile(repoId, { branch, filePath, content, commitMessage });
          } catch (e2) {
            failures.push(`${filePath}: ${maskCodeupToken(errorMessage(e2), token)}`);
          }
        }
      }

      // 3. 删除：git 路径的 removes 可能是目录（skills/<ns>/<name>，靠 git rm -r），
      //    API 只有单文件 deleteFile——先取目标分支文件树，把目录前缀展开成具体文件。
      //    展开为空的路径原样保留（可能是已不在的文件，deleteFile 的 404 按达成计）。
      if ((req.removedPaths ?? []).length > 0) {
        let baselineTree: string[] = [];
        try {
          baselineTree = await client.listFilePaths(repoId, targetBranch);
        } catch (e) {
          failures.push(`（删除前取文件树失败: ${maskCodeupToken(errorMessage(e), token)}，本次未执行删除）`);
        }
        const deleteTargets = new Set<string>();
        for (const removed of req.removedPaths ?? []) {
          const expanded = baselineTree.filter((p) => p === removed || p.startsWith(`${removed}/`));
          if (expanded.length > 0) {
            for (const p of expanded) deleteTargets.add(p);
          } else {
            deleteTargets.add(removed);
          }
        }
        for (const filePath of deleteTargets) {
          try {
            await client.deleteFile(repoId, { branch, filePath, commitMessage });
          } catch (e) {
            const reason = maskCodeupToken(errorMessage(e), token);
            // 404 类：文件本来就不在，目标状态（已删除）已达成，按成功计
            if (!isNotFound(e)) failures.push(`${filePath}（删除）: ${reason}`);
          }
        }
      }

      // 部分失败就不开 MR：半份资源（SKILL.md 在、辅助文件缺）一旦合入主干，
      // pull 会把残缺条目全员下发。宁可停在分支上让评审人补齐。
      if (failures.length > 0) {
        return {
          url: null,
          branch,
          instructions: [
            `${reusedNote}免 git 推送部分失败：分支 ${branch} 上已有部分文件，合并请求未创建（残缺内容不能合入主干）。`,
            ...failures.map((f) => `  - ${f}`),
            `下一步：按上面的错误逐项处理后重试；或在网页上手动补齐 ${branch} 的文件后再开合并请求。`,
          ].join('\n'),
        };
      }

      // 4. 开 MR（复用分支时同名 MR 已存在的 400/409 由 createMr 的 instructions 兜底，
      //    评审人在网页上继续既有 MR 即可）。
      const mr = await createMr({
        client,
        repoId,
        token,
      }, {
        title: req.title,
        sourceBranch: branch,
        targetBranch,
        description: req.body,
      });
      return reusedNote === '' ? mr : { ...mr, instructions: `${reusedNote}${mr.instructions ?? ''}` };
    },
  };
}
