import { existsSync, readFileSync } from 'node:fs';

import { BLOCK_END, BLOCK_START } from '../agents/block.js';
import { hashContent } from '../core/ledger.js';
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

function currentHash(entry: LedgerEntry): string | null {
  let text: string;
  try {
    text = readFileSync(entry.path, 'utf8');
  } catch {
    return null;
  }
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
    const hash = currentHash(entry);
    if (hash === entry.hash) audit.delivered.push(entry);
    else audit.modified.push(entry);
  }
  return audit;
}
