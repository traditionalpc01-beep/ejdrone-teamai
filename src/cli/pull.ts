import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { applyPlan } from '../core/apply.js';
import { hashContent, ledgerEntry, loadLedger, saveLedger } from '../core/ledger.js';
import type { ApplyOutcome, Ledger, PlannedWrite } from '../core/types.js';
import { debugLogPath, ledgerPath, stateDir } from '../state.js';
import { acquireLock, lockPath, STALE_MS } from './lock.js';
import { requireConfig } from './config.js';
import { activeResourcesWithConflictHold, buildDelivery, managedRoots, type Delivery } from './delivery.js';
import { pruneAfterDeletions } from './dirclean.js';
import type { CliContext } from './context.js';
import { openSnapshot } from './snapshot.js';

export interface PullOptions {
  silent?: boolean;
  force?: boolean;
}

export interface PullOutcome {
  /** 1 = 有 keep/conflict 需要人工看；fatal 时也是 1 */
  code: number;
  /** 未能算出完整计划（config / 网络 / manifest 坏） */
  fatal: boolean;
  kept: number;
  conflicts: number;
}

const FORCE_IGNORED = '（区块与受管条目投递不受 --force 影响：只动标记内区块 / 只动我们自己的条目）';

/** 覆盖前删掉整文件目标的旧内容，让 applyPlan 走"文件不存在 → 写入"分支。 */
function forceOverwrite(writes: PlannedWrite[], ledger: Ledger): number {
  let removed = 0;
  for (const write of writes) {
    // region 只动标记内；merge 的文件是成员在用的共享配置（~/.claude.json 等），
    // unlink 会把成员的条目和工具状态一起删掉 —— 两者都不进覆盖路径，交 apply 逐条判定。
    if (write.region || write.merge) continue;
    if (!existsSync(write.path)) continue;
    // 只覆盖我们投递过的文件。从未记账的同名文件是用户自己的东西，
    // --force 也不能删（交给 applyPlan 判成 foreign-file 保留）。
    if (!ledgerEntry(ledger, write.path)) continue;
    let current = '';
    try {
      current = readFileSync(write.path, 'utf8');
    } catch {
      continue;
    }
    if (hashContent(current) === hashContent(write.content)) continue;
    unlinkSync(write.path);
    removed++;
  }
  return removed;
}

export async function pullOnce(ctx: CliContext, options: PullOptions = {}): Promise<PullOutcome> {
  const lock = acquireLock(ctx.env);
  if (lock.ok) {
    try {
      return await pullInner(ctx, options);
    } finally {
      lock.release();
    }
  }
  // 拿不到锁说明同一份 checkout/ledger 正被另一个进程动。静默模式下直接跳过本次
  // （那个进程会把内容同步好），绝不非零退出 —— hook 失败不该挡住用户开工具。
  if (options.silent) return { code: 0, fatal: false, kept: 0, conflicts: 0 };
  ctx.err(`已有 ejdrone 进程正在同步团队仓库（pid ${lock.holder ?? '未知'}）`);
  // stale 已改为"持锁人死了才回收"：锁显示活着时大概率真有一个 pull 在跑。
  // 持有时间超过阈值（休眠/挂起的残留）才额外提醒一句，帮成员判断要不要手动删锁。
  if (lock.heldMs !== null && lock.heldMs > STALE_MS) {
    ctx.err(`提示：这把锁已持有约 ${Math.round(lock.heldMs / 60_000)} 分钟——若确认没有别的 ejdrone 在跑，可删除上面的锁文件重试`);
  }
  ctx.err(`下一步：等它结束再重跑；确认没有进程在跑时删除 ${lockPath(ctx.env)}`);
  return { code: 1, fatal: true, kept: 0, conflicts: 0 };
}

async function pullInner(ctx: CliContext, options: PullOptions): Promise<PullOutcome> {
  const silent = Boolean(options.silent);
  const buffer: string[] = [];
  /** 正常进度：--silent 时完全丢弃 */
  const emit = (line: string): void => {
    if (!silent) ctx.out(line);
  };
  /** 问题：--silent 时只进 ~/.ejdrone/debug.log */
  const warn = (line: string): void => {
    if (silent) buffer.push(line);
    else ctx.out(line);
  };
  const finish = (): void => {
    if (!silent || buffer.length === 0) return;
    try {
      mkdirSync(stateDir(ctx.env), { recursive: true });
      const text = `[${new Date().toISOString()}] pull --silent\n${buffer.join('\n')}\n`;
      appendFileSync(debugLogPath(ctx.env), text, 'utf8');
    } catch {
      /* hook 场景：写日志失败也绝不非零退出 */
    }
  };
  const fatal = (message: string, nextStep: string): PullOutcome => {
    warn(`错误：${message}`);
    warn(`下一步：${nextStep}`);
    finish();
    return { code: 1, fatal: true, kept: 0, conflicts: 0 };
  };

  const configResult = requireConfig(ctx);
  if (!configResult.ok) return fatal(configResult.error, configResult.nextStep);
  const config = configResult.config;

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    return fatal(
      `同步团队仓库失败：${loaded.error}`,
      '检查网络与仓库地址（ejdrone status 可看当前 config）；离线时可先 ejdrone list --source local 查看本地内容',
    );
  }
  const snapshot = loaded.snapshot;

  if (snapshot.manifestError) {
    return fatal(
      `角色 manifest 无法解析，本次全量停发（已装内容保持不变）：${snapshot.manifestError}`,
      `修正 ${snapshot.dir}/manifest/roles.yaml 后重新运行 ejdrone pull；细节见 ejdrone doctor`,
    );
  }

  for (const warning of snapshot.warnings) warn(`提示：${warning}`);

  const delivery = buildDelivery(ctx, config, snapshot);
  for (const note of delivery.notes) warn(`提示：${note}`);

  if (delivery.conflicts.length > 0) {
    for (const conflict of delivery.conflicts) warn(`冲突：${conflict}`);
    warn('下一步：该类型本次停发（已装内容保留），请调整仓库目录使同一 namespace 与根目录不再重名，然后重新 ejdrone pull');
  }

  const ledgerFile = ledgerPath(ctx.env);
  const loadedLedger = loadLedger(ledgerFile);
  if (loadedLedger.warning) warn(`提示：${loadedLedger.warning}`);

  let outcome: ApplyOutcome;
  try {
    if (options.force) {
      const forced = forceOverwrite(delivery.writes, loadedLedger.ledger);
      if (forced > 0) emit(`--force：即将覆盖 ${forced} 个本地改过的文件${FORCE_IGNORED}`);
    }
    outcome = applyPlan({
      writes: delivery.writes,
      activeResources: activeResourcesWithConflictHold(delivery, loadedLedger.ledger),
      ledger: loadedLedger.ledger,
      isManaged: delivery.isManaged,
    });
    saveLedger(ledgerFile, outcome.ledger);
    pruneAfterDeletions(outcome.result.deleted, managedRoots(ctx, delivery.adapters));
  } catch (e) {
    return fatal(`投递过程中出错（已写入的部分保持原样）：${e instanceof Error ? e.message : String(e)}`, '运行 ejdrone doctor 检查权限与磁盘状态');
  }

  const { written, deleted, kept } = outcome.result;
  emit(
    `已投递 ${written.length} 个文件到 ${delivery.adapters.length} 个工具；删除 ${deleted.length}；保留 ${kept.length}（本地改过或他人文件，绝不覆盖）`,
  );
  if (snapshot.manifest === null) {
    emit('提示：仓库没有 manifest/roles.yaml，只下发根条目（管理员可用 ejdrone roles add <id> 启用角色）');
  }
  for (const keep of kept) {
    const what = keep.entries && keep.entries.length > 0
      ? `条目 ${keep.entries.map((e) => `"${e}"`).join('、')}`
      : keep.resource;
    // apply.ts applyMergeWrite 的 !outcome.ok 分支（§3.3 规则 5）：merge 目标文件解析失败/异形
    // 也走 kept 点名（reason 冻结联合里只能取 'foreign-file'，且不带条目点名）。这一形态与
    // "非本工具投递的文件"必须分开说 —— 那是我们的目标文件，只是成员侧配置坏了，要指认修法。
    // 判别签名：mcp 资源 + 无条目点名（规则 6 的 foreign-entry 恒带 entries，不会混淆）。
    const mergeUnparseable =
      keep.reason === 'foreign-file' && keep.resource.startsWith('mcp:') && !(keep.entries && keep.entries.length > 0);
    const reasonText = mergeUnparseable
      ? 'MCP 配置文件无法解析或形状不认识，本次未投递（已装内容不动；修好该文件后下次 pull 自动恢复）'
      : keep.reason === 'modified-locally'
        ? '本地已修改'
        : '非本工具投递的文件';
    warn(`  保留 ${keep.path}（${what}：${reasonText}）`);
  }
  for (const path of deleted) emit(`  删除 ${path}`);

  finish();
  // haltedKinds 里除了冲突还包含"某类配置文件解析不出来"的停发（如 mcp.yaml）：
  // 两者都是团队写错了、成员这次少拿一类内容，退出码不能像"一切正常"那样是 0。
  const code = kept.length > 0 || delivery.haltedKinds.length > 0 ? 1 : 0;
  return { code, fatal: false, kept: kept.length, conflicts: delivery.conflicts.length };
}

/** 命令入口：--silent 恒返回 0（hook 场景绝不能阻塞工具启动）。 */
export async function pullCommand(ctx: CliContext, options: PullOptions = {}): Promise<number> {
  const outcome = await pullOnce(ctx, options);
  if (options.silent) return 0;
  return outcome.code;
}

