import { existsSync, readFileSync } from 'node:fs';

import { BLOCK_END, BLOCK_START } from '../agents/block.js';
import { hashContent } from '../core/ledger.js';
import { currentEntryHashes } from '../core/merge.js';
import type { Ledger, LedgerEntry } from '../core/types.js';

export interface LedgerAudit {
  delivered: LedgerEntry[];
  /** 记账在、文件已不在（可能被手动删除） */
  missing: LedgerEntry[];
  /** 磁盘内容与投递时不一致 = 本地改过，pull 会保留 */
  modified: LedgerEntry[];
}

/** 与 core/apply.ts 同构的区块定位：只比较标记内的文本。 */
function regionInner(text: string): string | null {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return null;
  const lineEnd = text.indexOf('\n', start + BLOCK_START.length);
  if (lineEnd < 0) return null;
  const end = text.indexOf(BLOCK_END, lineEnd + 1);
  if (end < 0) return null;
  const endLineStart = text.lastIndexOf('\n', end - 1) + 1;
  return text.slice(lineEnd + 1, Math.max(lineEnd + 1, endLineStart));
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isManagedKeys(entry: LedgerEntry): boolean {
  return entry.managedKeys !== undefined && Object.keys(entry.managedKeys).length > 0;
}

/** merge 文件只可能来自 JSON / TOML 两种落点；按扩展名分派，未知扩展名交给 json 分支解析失败兜底。 */
function mergeFormatFor(path: string): 'json' | 'toml' {
  return path.endsWith('.toml') ? 'toml' : 'json';
}

/**
 * merge 记账条目的核对：**逐条目键**比哈希，绝不拿整文件哈希判"本地改过" ——
 * 整文件里还住着成员自己的条目和工具状态字段，整文件哈希永远比不中。
 * 键在文件里找不到 / 文件解析不出 / 异形 → 记入 modified（与 apply 的"宁可不动"同口径）。
 */
function mergeIntact(entry: LedgerEntry): boolean {
  const text = readText(entry.path);
  const keys = Object.keys(entry.managedKeys ?? {});
  if (text === null) return false;
  const hashes = currentEntryHashes(mergeFormatFor(entry.path), text, keys);
  for (const key of keys) {
    if (hashes[key] !== entry.managedKeys?.[key]) return false;
  }
  return true;
}

function currentHash(entry: LedgerEntry): string | null {
  const text = readText(entry.path);
  if (text === null) return null;
  if (text.includes(BLOCK_START) || text.includes(BLOCK_END)) {
    const inner = regionInner(text);
    if (inner !== null) return hashContent(inner);
  }
  return hashContent(text);
}

export function auditLedger(ledger: Ledger): LedgerAudit {
  const audit: LedgerAudit = { delivered: [], missing: [], modified: [] };
  for (const entry of ledger.entries) {
    if (!existsSync(entry.path)) {
      audit.missing.push(entry);
      continue;
    }
    if (isManagedKeys(entry)) {
      if (mergeIntact(entry)) audit.delivered.push(entry);
      else audit.modified.push(entry);
      continue;
    }
    const hash = currentHash(entry);
    if (hash === entry.hash) audit.delivered.push(entry);
    else audit.modified.push(entry);
  }
  return audit;
}
