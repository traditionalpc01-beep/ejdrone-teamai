import type { Config } from '../core/types.js';
import { commitAll, createBranch, isDirty, listRemoteBranches, prePushScan, push, removePaths, writeFiles } from '../git/repo.js';
import { makeGitProvider } from '../git/provider.js';
import { newMrWebUrl, parseRepoRef } from '../git/gitlab.js';
import type { CliContext } from './context.js';
import { acquireLock, lockPath } from './lock.js';
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
): Promise<MrOutcome> {
  // 与 pull 共用同一把锁：否则会话启动的自动 pull 会把 fetchReset 插进
  // writeFiles 与 commitAll 之间，工作树被就地重置，push 表现为"空提交、没有 MR"。
  const lock = acquireLock(ctx.env);
  if (!lock.ok) {
    ctx.err(`已有 ejdrone 进程正在同步团队仓库（pid ${lock.holder ?? '未知'}）`);
    ctx.err(`下一步：等它结束后重跑；确认没有进程在跑时删除 ${lockPath(ctx.env)}`);
    return { code: 1, branch: null, mrUrl: null };
  }
  try {
    return await submitMrChangeInner(ctx, config, snapshot, change);
  } finally {
    lock.release();
  }
}

async function submitMrChangeInner(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  change: MrChange,
): Promise<MrOutcome> {
  const dir = snapshot.dir;
  const targetBranch = snapshot.branch;

  const remote = await listRemoteBranches(dir, ctx.env);
  const reusable = remote.filter((name) => name.startsWith(change.branchPrefix)).sort();
  const existing = reusable[reusable.length - 1];
  const branch = existing ?? `${change.branchPrefix}${stamp()}`;
  if (existing) {
    ctx.out(`该资源已有未合并分支 ${existing}，就地更新（不再开重复 MR 分支）`);
  }

  // from 用远端分支名：复用时就从那条分支继续，新建时从默认分支继续
  await createBranch(dir, branch, existing ?? targetBranch, ctx.env);

  const written = Object.entries(change.files);
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
