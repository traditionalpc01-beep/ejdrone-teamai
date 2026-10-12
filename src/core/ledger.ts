import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

import { samePath } from '../platform.js';
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
  // 0600 与 saveConfig 对齐：账本内容只有路径 + sha256 + resource key（无明文凭据），
  // 但状态目录里 config 0600、ledger 0644 并存会让维护者误判，且"0600 收紧"清单不该有例外。
  // rename 未必保留 tmp 的权限（umask/目标已存在），这里钉死 0600；不支持改权限的文件系统
  // 上 best-effort，不额外失败。
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  replaceFileSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* 文件系统不支持改权限时不额外失败 */
  }
}

/**
 * tmp → target 的原子替换。POSIX：rename 直接覆盖（原有行为）。
 * win32：先 best-effort 删掉已存在的 target 再 rename —— Windows 上 rename 覆盖已存在
 * 文件不可靠（目标被占用/权限姿态不同会 EPERM/EACCES，还与杀毒软件扫描窗口竞争）。
 * unlink 失败也继续 rename：让 rename 自己报错，不吞真实故障。
 *
 * 注意用 unlinkSync(target) 单参而非 { force: true }：fs.unlinkSync 不接受 options
 * （force 只属于 rmSync），而 try/catch 已经覆盖 ENOENT 等 best-effort 语义。
 */
export function replaceFileSync(tmp: string, target: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    try {
      unlinkSync(target);
    } catch {
      /* 删不掉（不存在/占用/权限）也让 rename 去撞，错误照实抛 */
    }
  }
  renameSync(tmp, target);
}

export function ledgerEntry(ledger: Ledger, path: string): LedgerEntry | undefined {
  // Windows 文件系统大小写不敏感、\ 与 / 等价，账本路径比对必须归一，否则同一文件会被当成两条账。
  return ledger.entries.find((e) => samePath(e.path, path));
}
