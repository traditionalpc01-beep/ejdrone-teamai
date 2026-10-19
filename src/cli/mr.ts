import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../core/types.js';
import { teamGitattributes, teamReadme } from './team-readme.js';
import { commitAll, createBranch, isDirty, listRemoteBranches, prePushScan, push, removePaths, writeFiles } from '../git/repo.js';
import { makeGitProvider } from '../git/provider.js';
import { newMrWebUrl, parseRepoRef } from '../git/gitlab.js';
import { hasGitAvailable } from '../platform.js';
import type { CliContext } from './context.js';
import { acquireLock, lockPath, STALE_MS } from './lock.js';
import type { Snapshot } from './snapshot.js';

export interface MrChange {
  /** checkout 相对路径 → 新内容 */
  files: Record<string, string>;
  /** 要从仓库删除的 checkout 相对路径（文件或目录） */
  removes: string[];
  /** 分支前缀，形如 ejdrone/push-skills-review-；同一前缀的远端分支会被就地复用 */
  branchPrefix: string;
  title: string;
  body: string;
}

export interface MrOutcome {
  code: number;
  /** 抢不到锁时为 null（还没有分支） */
  branch: string | null;
  mrUrl: string | null;
}

export interface SubmitMrChangeOptions {
  /**
   * 本机是否有可用 git。注入点（同 snapshot 的可选参数风格）：
   * 测试伪装「没装 git」用；缺省真探测 hasGitAvailable(env)。
   */
  gitAvailable?: boolean;
}

/** UTC 时间戳：20261011T053000Z（定宽，可字典序比较出最新分支） */
export function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function manualMrUrl(repo: string, branch: string): string | null {
  const ref = parseRepoRef(repo);
  return ref ? newMrWebUrl(ref.baseUrl, ref.projectPath, branch) : null;
}

/** 建分支 → 改文件 → 扫描 → 提交 → 推送 → 开 MR。评审流唯一出口。 */
export async function submitMrChange(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  change: MrChange,
  options: SubmitMrChangeOptions = {},
): Promise<MrOutcome> {
  const gitAvailable = options.gitAvailable ?? hasGitAvailable(ctx.env);
  // 与 pull 共用同一把锁：否则会话启动的自动 pull 会把 fetchReset 插进
  // writeFiles 与 commitAll 之间，工作树被就地重置，push 表现为"空提交、没有 MR"。
  const lock = acquireLock(ctx.env);
  if (!lock.ok) {
    ctx.err(`已有 ejdrone 进程正在同步团队仓库（pid ${lock.holder ?? '未知'}）`);
    if (lock.heldMs !== null && lock.heldMs > STALE_MS) {
      ctx.err(`提示：这把锁已持有约 ${Math.round(lock.heldMs / 60_000)} 分钟——若确认没有别的 ejdrone 在跑，可删除上面的锁文件重试`);
    }
    ctx.err(`下一步：等它结束后重跑；确认没有进程在跑时删除 ${lockPath(ctx.env)}`);
    return { code: 1, branch: null, mrUrl: null };
  }
  try {
    return await submitMrChangeInner(ctx, config, snapshot, change, gitAvailable);
  } finally {
    lock.release();
  }
}

async function submitMrChangeInner(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  change: MrChange,
  gitAvailable: boolean,
): Promise<MrOutcome> {
  // 本机没有 git：provider 支持免 git 推送就走纯 API（不碰本地 checkout），否则给可行动错误。
  if (!gitAvailable) return submitMrChangeWithoutGit(ctx, config, change, snapshot);
  const dir = snapshot.dir;
  const targetBranch = snapshot.branch;

  const remote = await listRemoteBranches(dir, ctx.env);
  // 空仓库（刚建好、一个提交都没有）：没有可评审的基线，MR 也没有目标分支可指。
  const bootstrap = remote.length === 0;
  const reusable = remote.filter((name) => name.startsWith(change.branchPrefix)).sort();
  const existing = reusable[reusable.length - 1];
  const branch = bootstrap ? targetBranch : existing ?? `${change.branchPrefix}${stamp()}`;
  if (existing) {
    ctx.out(`该资源已有未合并分支 ${existing}，就地更新（不再开重复 MR 分支）`);
  }

  // from 用远端分支名：复用时就从那条分支继续，新建时从默认分支继续；空仓库无起点
  await createBranch(dir, branch, bootstrap ? undefined : existing ?? targetBranch, ctx.env);
  // checkout 停在临时分支期间，`--dry-run`/`status` 这类只读命令会把「还没合入的内容」当成
  // 团队真相（2026-10-13 Windows 真机实测：contribute 之后紧接着 `contribute --dry-run`
  // 因「目标路径已存在」被拒）。整段用 finally 包住，任何退出路径都把工作树还给默认分支。
  // 空仓库那一路本来就落在 targetBranch 上；还原只在 createBranch 之后生效，不会吃掉待提交内容。
  try {
    return await finishMrChange(ctx, config, snapshot, change, { branch, targetBranch, bootstrap });
  } finally {
    if (!bootstrap) {
      try {
        await createBranch(dir, targetBranch, targetBranch, ctx.env);
      } catch {
        // 还原失败不改变本次结果：下一次 pull 的 fetchReset 会把工作树校正回 origin/<默认分支>
      }
    }
  }
}

/**
 * 免 git 推送：本机没有 git 时，provider 实现了 apiPush 就走纯 OpenAPI
 * （复用或新建分支 → 写文件 → 删文件 → 开 MR），文件来源与 git 路径同一个 MrChange
 * （仓库根相对路径 → 内容）；没实现 apiPush 则给可行动错误并返回非 0。
 *
 * 该路径不触碰本地 checkout 与 ledger（免 git 机器上本来也没有 checkout），
 * 但敏感内容扫描必须照走 —— git 路径在 commit 前有 prePushScan，这里不能绕过。
 * 空仓库（snapshot.head === ''，与 git 路径 remote.length === 0 同判据）走 bootstrap：
 * README/.gitattributes 与 git 路径同一份补齐逻辑，直推默认分支、不开 MR。
 */
async function submitMrChangeWithoutGit(
  ctx: CliContext,
  config: Config,
  change: MrChange,
  snapshot: Snapshot,
): Promise<MrOutcome> {
  const provider = makeGitProvider(config, ctx.env);
  if (!provider.apiPush) {
    ctx.err(`错误：本机没有可用的 git，当前托管（provider=${config.provider}）也不支持免 git 推送。`);
    ctx.err('下一步：安装 Git for Windows（https://git-scm.com/download/win）后重跑；或把待推文件交给管理员代推。');
    return { code: 1, branch: null, mrUrl: null };
  }

  const findings = prePushScan(change.files);
  if (findings.length > 0) {
    for (const finding of findings) ctx.err(`安全检查：${finding}`);
    ctx.err('下一步：移除敏感内容后重新运行该命令');
    return { code: 1, branch: null, mrUrl: null };
  }

  const targetBranch = snapshot.branch?.trim() || 'main';
  // 空仓库判据与 git 路径一致（fetchReset 对无提交远端返回 head=''）：首笔引导直推默认分支
  const bootstrap = snapshot.head === '';
  const files = withBootstrapExtras(config, change.files, snapshot.dir, targetBranch, bootstrap);
  ctx.out(
    bootstrap
      ? `本机没有 git，改走 ${config.provider} OpenAPI 免 git 推送（空仓库引导 → 直推 ${targetBranch}）`
      : `本机没有 git，改走 ${config.provider} OpenAPI 免 git 推送（分支 ${change.branchPrefix}* → ${targetBranch}）`,
  );
  try {
    const mr = await provider.apiPush({
      branchPrefix: change.branchPrefix,
      targetBranch,
      title: change.title,
      body: change.body,
      files,
      removedPaths: change.removes,
      bootstrap,
    });
    const branch = mr.branch ?? `${change.branchPrefix}?`;
    if (mr.bootstrapped === true) {
      if (mr.instructions) ctx.out(mr.instructions);
      ctx.out(`团队仓库首个提交已直接落到 ${branch}：空仓库没有可评审的基线，之后的变更继续走 MR`);
      return { code: 0, branch, mrUrl: null };
    }
    if (mr.url) {
      if (mr.instructions) ctx.out(mr.instructions);
      ctx.out(`MR 已创建：${mr.url}`);
      ctx.out('下一步：请评审人合入；其他成员下次会话自动拿到变更');
      return { code: 0, branch, mrUrl: mr.url };
    }
    if (mr.instructions) ctx.out(mr.instructions);
    // 免 git 路径没有「分支已推送成功」这个可靠锚点（instructions 也可能意味着一步都没推成），
    // 与 git 路径的 openMr 失败（code 0）不同，这里按失败计，让调用方看输出后重试
    return { code: 1, branch, mrUrl: null };
  } catch (e) {
    ctx.err(`错误：免 git 推送失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：装好 git 后重跑（会改走本地 git push），或到仓库网页从对应分支手动处理');
    return { code: 1, branch: null, mrUrl: null };
  }
}

/**
 * 空仓库首笔提交的补齐（README 说明书 + .gitattributes 行尾钉 LF），git 与免 git
 * 两条路径共用同一份逻辑——分支不同、补齐内容必须逐字相同，否则两条链路建出的
 * 团队仓基线不一致。
 */
function withBootstrapExtras(
  config: Config,
  files: Record<string, string>,
  dir: string,
  targetBranch: string,
  bootstrap: boolean,
): Record<string, string> {
  if (!bootstrap) return files;
  const merged: Record<string, string> = { ...files };
  if (!('README.md' in merged) && !existsSync(join(dir, 'README.md'))) {
    // 新同事打开仓库就该看得见怎么加入，而不是靠有人在群里再贴一遍命令。
    merged['README.md'] = teamReadme(config.repo, targetBranch);
  }
  if (!('.gitattributes' in merged) && !existsSync(join(dir, '.gitattributes'))) {
    // 第一笔提交就把行尾钉成 LF，别让第一个 Windows 成员把 CRLF 提交进团队真相。
    merged['.gitattributes'] = teamGitattributes();
  }
  return merged;
}

async function finishMrChange(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  change: MrChange,
  state: { branch: string; targetBranch: string; bootstrap: boolean },
): Promise<MrOutcome> {
  const { branch, targetBranch, bootstrap } = state;
  const dir = snapshot.dir;

  // 空仓库首笔的 README/.gitattributes 补齐与免 git 路径共用 withBootstrapExtras
  // （两条链路建出的团队仓基线必须逐字一致）
  const files = withBootstrapExtras(config, change.files, dir, targetBranch, bootstrap);
  const written = Object.entries(files);
  if (written.length > 0) {
    writeFiles(dir, Object.fromEntries(written.map(([rel, content]) => [`./${rel}`, content])));
  }
  if (change.removes.length > 0) {
    await removePaths(dir, change.removes.map((rel) => `./${rel}`), ctx.env);
  }

  const findings = prePushScan(change.files);
  if (findings.length > 0) {
    for (const finding of findings) ctx.err(`安全检查：${finding}`);
    ctx.err('下一步：移除敏感内容后重新运行该命令');
    return { code: 1, branch, mrUrl: null };
  }

  if (!(await isDirty(dir, ctx.env))) {
    ctx.out('内容与仓库一致，无需提交，也没有新的 MR');
    return { code: 0, branch, mrUrl: null };
  }

  await commitAll(dir, change.title, ctx.env);
  await push(dir, branch, ctx.env);

  if (bootstrap) {
    ctx.out(`团队仓库首个提交已直接落到 ${branch}：空仓库没有可评审的基线，之后的变更继续走 MR`);
    return { code: 0, branch, mrUrl: null };
  }

  ctx.out(`已推送分支 ${branch}（等待合入 ${targetBranch}）`);

  const provider = makeGitProvider(config, ctx.env);
  try {
    const mr = await provider.openMr({ branch, title: change.title, body: change.body, targetBranch });
    if (mr.url) {
      ctx.out(`MR 已创建：${mr.url}`);
      ctx.out('下一步：请评审人合入；其他成员下次会话自动拿到变更');
    } else {
      if (mr.instructions) {
        ctx.out(mr.instructions);
      } else {
        ctx.out('分支已推送，但 provider 没有返回 MR 链接，请到项目页面手动创建 MR。');
      }
      ctx.out(`下一步：合入 ${branch} → ${targetBranch} 后运行 ejdrone pull 验证`);
    }
    return { code: 0, branch, mrUrl: mr.url };
  } catch (e) {
    // 分支此时已经推送成功，绝不能报成"push 失败"
    ctx.out(`分支 ${branch} 已推送成功，但自动开 MR 失败：${e instanceof Error ? e.message : String(e)}`);
    const link = manualMrUrl(config.repo, branch);
    ctx.out(link ? `下一步：用该链接手动开 MR：${link}` : '下一步：到项目页面手动创建 MR，源分支 ' + branch);
    return { code: 0, branch, mrUrl: null };
  }
}
