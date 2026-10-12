import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { namespacesForRoles } from '../core/manifest.js';
import {
  learningFileName,
  learningPathTaken,
  learningRepoPath,
  normalizeLearning,
  RESERVED_LEARNINGS_NAMESPACE,
} from '../core/learning.js';
import type { Config } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { isValidResourceName } from './constants.js';
import { submitMrChange, type MrChange } from './mr.js';
import { openSnapshot, readExistingSnapshot, type Snapshot } from './snapshot.js';

/**
 * `ejdrone contribute --file <path> [--title <t>] [--ns <ns>] [--dry-run]`（M9 / T9.2）。
 *
 * 与 teamai 的关键偏差（父计划 §7.1，都是有意为之）：
 * - **走 push 的分支 + MR 管线**（`submitMrChange`），不用孤儿分支免评审——经验入库走评审
 *   是这个项目存在的前提；锁由 submitMrChange 内部持有（AGENTS.md：MR 期间必须持 sync.lock）。
 * - **`--dry-run` 一个 git 副作用都不许有**：连 openSnapshot 的 clone/fetch 都不做，
 *   撞名检查改用离线 checkout（`readExistingSnapshot`，纯读本地文件）。
 * - 撞名**拒绝并提示改名**，不加 rand6。
 */

export interface ContributeOptions {
  /** 成员本地 learning 文件路径 */
  file: string;
  /** 覆盖标题（缺省依次取 frontmatter title / 正文首个 # 标题 / 文件名） */
  title?: string;
  /** 目标 namespace 目录名；角色映射多个 namespace 时必给（与 push 同规则） */
  ns?: string;
  dryRun?: boolean;
}

function absPath(ctx: CliContext, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(ctx.cwd, value);
}

/**
 * 目标 namespace 目录名。判歧义规则与 push.ts 的 resolveTargetNamespace 一致
 * （那份实现是 push 模块私有的，contribute 不擅自去改别人的文件，照规则在本模块复刻）。
 */
function resolveContributeNamespace(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot | null,
  nsOption: string | undefined,
): string | null {
  const explicit = (nsOption ?? '').trim();
  if (explicit !== '') {
    if (!isValidResourceName(explicit)) {
      ctx.err(`错误：--ns「${explicit}」不合法（只允许小写字母、数字、-、_，且不能含 /）`);
      ctx.err('下一步：用 manifest/roles.yaml 里已声明的 namespace 名');
      return null;
    }
    if (explicit === RESERVED_LEARNINGS_NAMESPACE) {
      ctx.err(`错误：--ns「${RESERVED_LEARNINGS_NAMESPACE}」是保留名（codebase 知识图谱预留目录）`);
      ctx.err('下一步：换一个 namespace 名；这条经验值得全员共享的话就推仓库根目录');
      return null;
    }
    return explicit;
  }

  const role = (config.primaryRole ?? '').trim();
  if (role === '') {
    ctx.out('提示：当前没有角色，learning 将入库到仓库根目录 learnings/（全员共享）');
    return '';
  }

  const mapped =
    snapshot === null || snapshot.manifest === null
      ? { namespaces: [], unknownRoles: [role] }
      : namespacesForRoles(snapshot.manifest, [role]);
  if (mapped.unknownRoles.length === 0) {
    if (mapped.namespaces.length === 1) return mapped.namespaces[0] ?? '';
    if (mapped.namespaces.length > 1) {
      ctx.err(`错误：角色「${role}」订阅了多个 namespace：${mapped.namespaces.join(', ')}`);
      ctx.err('下一步：加 --ns <namespace> 明确入库到哪一个');
      return null;
    }
  }

  if (!isValidResourceName(role)) {
    ctx.err(`错误：角色「${role}」既不在 manifest/roles.yaml 里，也不是合法的目录名`);
    ctx.err('下一步：用 --ns <合法 namespace> 指定目标目录');
    return null;
  }
  ctx.out(`提示：「${role}」不在 manifest/roles.yaml 的角色 id 里，按同名 namespace 目录 learnings/${role}/ 入库`);
  return role;
}

export async function contributeCommand(ctx: CliContext, options: ContributeOptions): Promise<number> {
  const file = (options.file ?? '').trim();
  if (file === '') {
    ctx.err('错误：contribute 需要一个本地 learning 文件。');
    ctx.err('下一步：ejdrone contribute --file <path>（可加 --title 覆盖标题、--ns 指定 namespace、--dry-run 先看落库形态）');
    return 1;
  }

  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  const target = absPath(ctx, file);
  if (!existsSync(target)) {
    ctx.err(`错误：找不到 learning 文件：${target}`);
    ctx.err('下一步：先用编辑器写好这份经验，再运行 ejdrone contribute --file <path>');
    return 1;
  }
  if (!statSync(target).isFile()) {
    ctx.err(`错误：${target} 不是文件（learning 是一份 markdown 文件，不是目录）`);
    ctx.err('下一步：ejdrone contribute --file <path> 指到具体的 .md 文件');
    return 1;
  }
  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (e) {
    ctx.err(`错误：读不了该文件：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  // dry-run 绝不做 clone/fetch（零 git 副作用）；只读本地已有 checkout 来查撞名。
  let snapshot: Snapshot | null = null;
  if (options.dryRun) {
    snapshot = readExistingSnapshot(ctx);
    if (snapshot === null) {
      ctx.out('提示：本地还没有仓库 checkout，--dry-run 无法核对目标路径是否重名；正式提交时会再查一次。');
    }
  } else {
    const loaded = await openSnapshot(ctx, config.repo);
    if (!loaded.ok) {
      ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
      ctx.err('下一步：确认网络与仓库地址后重跑 ejdrone contribute');
      return 1;
    }
    snapshot = loaded.snapshot;
  }

  const namespace = resolveContributeNamespace(ctx, config, snapshot, options.ns);
  if (namespace === null) return 1;

  const learning = normalizeLearning({ raw, fileName: basename(target), titleOverride: options.title });
  if (learning.warning) ctx.out(`提示：${basename(target)} ${learning.warning}`);
  const fileName = learningFileName(learning.title, learning.date);
  const relPath = learningRepoPath(namespace, fileName);

  const taken =
    (snapshot !== null && learningPathTaken(snapshot.kinds.learnings, namespace, fileName)) ||
    (snapshot !== null && existsSync(join(snapshot.dir, relPath)));
  if (taken) {
    ctx.err(`错误：目标路径 ${relPath} 在团队仓库里已存在（或同名 learning 已在库）。`);
    ctx.err('下一步：给这份经验换个标题（--title 或改正文标题）再跑；我们不给文件名加随机后缀，撞名请靠改名区分。');
    return 1;
  }

  if (options.dryRun) {
    ctx.out('以下为 --dry-run 预览：未建分支、未提交、未推送、未开 MR。');
    ctx.out(`目标路径：${relPath}`);
    ctx.out('落库内容：');
    ctx.out(learning.content);
    ctx.out(`提示：确认无误后去掉 --dry-run 正式提交（tags ${learning.tags.length === 0 ? '还没写，评审时记得补' : `已带 ${learning.tags.length} 个`}）。`);
    return 0;
  }

  // 走到这里必然经过 openSnapshot 的成功分支（dry-run 已在上面返回）；类型收口用的防御。
  if (snapshot === null) {
    ctx.err('错误：内部错误：正式提交前缺少仓库快照。');
    ctx.err('下一步：运行 ejdrone doctor 检查仓库状态');
    return 1;
  }

  ctx.out('待入库：');
  ctx.out(`  learning ${relPath} ← ${target}`);
  if (learning.tags.length === 0) {
    ctx.out('提示：这份 learning 还没有 tags；MR 里请评审人顺手补 2–5 个，方便后续 recall 命中。');
  }

  // 分支前缀按目标路径做短哈希：slug 常含中文，直接进 ref 名会让远端与 GitLab UI 的兼容性
  // 变得不可控；同一目标路径重跑仍走「就地复用未合并分支」的老规则（mr.ts）。
  const digest = createHash('sha1').update(relPath).digest('hex').slice(0, 8);
  const change: MrChange = {
    files: { [relPath]: learning.content },
    removes: [],
    branchPrefix: `ejdrone/contribute-learning-${digest}-`,
    title: `docs(${namespace === '' ? 'root' : namespace}): add learning ${fileName}`,
    body: [
      '由 ejdrone contribute 生成。',
      '',
      `目标路径：${relPath}`,
      `标题：${learning.title}`,
      `日期：${learning.date}`,
      `tags：${learning.tags.length > 0 ? learning.tags.join(', ') : '（无，请评审时补 2–5 个）'}`,
      '',
      `提交者角色：${config.primaryRole ?? '（未设置）'}`,
      '请评审：内容是否适合团队共享、是否含密钥、tags 是否需要补。',
    ].join('\n'),
  };

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out('提示：合入后其他成员下次 pull 会拿到这份 learning，ejdrone recall 就能检索到它。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：入库流程失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查仓库状态（~/.ejdrone/repo 可安全删除后重建）');
    return 1;
  }
}
