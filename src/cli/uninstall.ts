import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { registry } from '../agents/index.js';
import { hookTarget } from '../agents/paths.js';
import { hasHook } from '../hooks.js';
import { hashContent, loadLedger, saveLedger } from '../core/ledger.js';
import { BLOCK_END, BLOCK_RESOURCE_KEY, BLOCK_START } from '../agents/block.js';
import { locateRegion, normalizeInner, stripRegion } from '../core/region.js';
import type { LedgerEntry } from '../core/types.js';
import { configPath, ledgerPath, loadConfig, stateDir } from '../state.js';
import type { CliContext } from './context.js';
import { managedRoots } from './delivery.js';
import { pruneAfterDeletions } from './dirclean.js';

export interface UninstallOptions {
  force?: boolean;
}

export async function uninstallCommand(ctx: CliContext, options: UninstallOptions): Promise<number> {
  if (!options.force) {
    if (!ctx.interactive) {
      ctx.err('错误：非交互模式下 uninstall 需要显式确认。');
      ctx.err('下一步：确认后运行 ejdrone uninstall --force');
      return 1;
    }
    const ok = await ctx.confirm(
      '将移除所有 ejdrone hook 并删除由本工具投递的 skill/rule 文件（你改过的会保留），继续吗？',
      false,
    );
    if (!ok) {
      ctx.out('已取消，未做任何改动。');
      return 0;
    }
  }

  const adapters = registry().all();
  const { config, error } = loadConfig(ctx.env);
  if (config === null) {
    ctx.out(`提示：没有可用 config（${error ?? '尚未初始化'}），仍会清理 hook 与投递记账`);
  }

  for (const adapter of adapters) {
    // 只处理真的装了我们 hook 的工具：没装过的话 removeHook 也不会写文件，
    // 但报"已清理"会误导人以为动过那个工具的配置。
    const target = hookTarget(adapter.id, ctx.home, ctx.env);
    if (target === null || !existsSync(target.path) || !hasHook(target.path, target.event)) continue;
    try {
      adapter.uninstallHook(ctx.home, ctx.env);
      ctx.out(`hook：${adapter.label} 已清理`);
    } catch (e) {
      ctx.out(`hook：${adapter.label} 清理失败：${e instanceof Error ? e.message : String(e)}`);
      ctx.out(`        下一步：手动检查 ${join(stateDir(ctx.env), adapter.id)} 下的 hook 配置文件`);
    }
  }

  const file = ledgerPath(ctx.env);
  const { ledger, warning } = loadLedger(file);
  if (warning) ctx.out(`提示：${warning}`);

  const owned = (path: string): boolean => adapters.some((adapter) => adapter.ownsPath(path, ctx.home, ctx.env));
  const removed: LedgerEntry[] = [];
  const stripped: LedgerEntry[] = [];
  const kept: Array<{ entry: LedgerEntry; reason: string }> = [];

  for (const entry of ledger.entries) {
    if (!existsSync(entry.path)) {
      removed.push(entry);
      continue;
    }
    let current: string | null = null;
    try {
      current = readFileSync(entry.path, 'utf8');
    } catch {
      current = null;
    }

    if (entry.resource === BLOCK_RESOURCE_KEY) {
      // 区块文件（AGENTS.md 一类）是用户的：只撤掉我们那对标记及其正文，绝不删整个文件。
      // 撤掉后所剩空白就说明这文件本来只为区块而存在，留成空文件即可。
      if (current === null) {
        kept.push({ entry, reason: '读取失败' });
        continue;
      }
      const loc = locateRegion(current, BLOCK_START, BLOCK_END);
      if (loc === null) {
        stripped.push(entry);
        continue;
      }
      const inner = current.slice(loc.contentStart, loc.contentEnd);
      if (hashContent(normalizeInner(inner)) !== entry.hash) {
        kept.push({ entry, reason: '本地已修改（区块被你改过，撤掉会丢你的内容）' });
        continue;
      }
      try {
        writeFileSync(entry.path, stripRegion(current, loc), 'utf8');
        stripped.push(entry);
      } catch (e) {
        kept.push({ entry, reason: `写入失败：${e instanceof Error ? e.message : String(e)}` });
      }
      continue;
    }

    if (!owned(entry.path)) {
      kept.push({ entry, reason: '不在本工具管理的目录内' });
      continue;
    }
    if (current === null || hashContent(current) !== entry.hash) {
      kept.push({ entry, reason: current === null ? '读取失败' : '本地已修改' });
      continue;
    }
    unlinkSync(entry.path);
    removed.push(entry);
  }

  const dropped = new Set<LedgerEntry>([...removed, ...stripped]);
  const remaining = ledger.entries.filter((entry) => !dropped.has(entry));
  if (remaining.length === 0) {
    if (existsSync(file)) unlinkSync(file);
  } else {
    saveLedger(file, { version: ledger.version, entries: remaining });
  }
  pruneAfterDeletions(
    removed.map((entry) => entry.path),
    managedRoots(ctx, adapters),
  );

  ctx.out('');
  ctx.out(
    `清理完成：删除 ${removed.length} 个由 ejdrone 投递的文件及其记账` +
      (stripped.length > 0 ? `；撤掉 ${stripped.length} 处团队区块（文件与你写在标记外的内容保留）` : ''),
  );
  for (const item of kept) ctx.out(`  保留 ${item.entry.path}（${item.entry.resource}：${item.reason}）`);
  ctx.out(`config 保留在 ${configPath(ctx.env)}；要彻底移除本工具状态请手动删除该目录，npm 包由 npm uninstall 负责`);
  return 0;
}
