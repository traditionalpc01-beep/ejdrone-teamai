import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Ledger, LedgerEntry } from './types.js';

export function hashContent(s: string): string {
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

function emptyLedger(): Ledger {
  return { version: 1, entries: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string';
}

function validateLedger(parsed: unknown): { ok: true; ledger: Ledger } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: 'root must be an object' };
  if (typeof parsed.version !== 'number') return { ok: false, reason: 'version must be a number' };
  if (!Array.isArray(parsed.entries)) return { ok: false, reason: 'entries must be an array' };

  const entries: LedgerEntry[] = [];
  for (const raw of parsed.entries) {
    if (!isRecord(raw)) return { ok: false, reason: 'every entry must be an object' };
    if (
      !isNonEmptyString(raw.path) ||
      !isNonEmptyString(raw.hash) ||
      !isNonEmptyString(raw.resource) ||
      !isNonEmptyString(raw.deliveredAt)
    ) {
      return { ok: false, reason: 'entry needs path, hash, resource and deliveredAt strings' };
    }
    const entry: LedgerEntry = {
      path: raw.path,
      hash: raw.hash,
      resource: raw.resource,
      deliveredAt: raw.deliveredAt,
    };
    // 2.0 merge 投递的逐键记账。**必须可选**：1.0 的旧账本没有这个字段，若判非法 → 回落空账本，
    // 下次 pull 会把全体成员的已投文件当"别人的文件"永久保留（回归比缺字段严重得多）。
    // 读出来缺 = 空集；读出来坏 = 非法（我们自己写出的从不坏；回落只针对真损坏）。
    if (raw.managedKeys !== undefined) {
      if (!isRecord(raw.managedKeys) || !Object.values(raw.managedKeys).every((v) => typeof v === 'string')) {
        return { ok: false, reason: 'managedKeys must map entry keys to hash strings' };
      }
      entry.managedKeys = raw.managedKeys as Record<string, string>;
    }
    entries.push(entry);
  }
  return { ok: true, ledger: { version: parsed.version, entries } };
}

export function loadLedger(path: string): { ledger: Ledger; warning?: string } {
  if (!existsSync(path)) return { ledger: emptyLedger() };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ledger: emptyLedger(), warning: `Cannot read ledger (${path}): ${(e as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ledger: emptyLedger(), warning: `Ledger is not valid JSON (${path}): ${(e as Error).message}` };
  }

  const validated = validateLedger(parsed);
  if (!validated.ok) {
    return { ledger: emptyLedger(), warning: `Invalid ledger structure (${path}): ${validated.reason}` };
  }
  return { ledger: validated.ledger };
}

export function saveLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function ledgerEntry(ledger: Ledger, path: string): LedgerEntry | undefined {
  return ledger.entries.find((e) => e.path === path);
}
