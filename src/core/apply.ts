import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeEntries } from './merge.js';
import type { MergeOutcome } from './merge.js';
import { hashContent, ledgerEntry } from './ledger.js';
import {
  appendBlock,
  blockText,
  hasOrphanMarker,
  locateRegion,
  normalizeInner,
  replaceRegion,
} from './region.js';
import type {
  ApplyInput,
  ApplyOutcome,
  ApplyResult,
  KeptFile,
  Ledger,
  LedgerEntry,
  PlannedWrite,
} from './types.js';

/**
 * applyPlan 的可选入参。不塞进 ApplyInput 是因为 types.ts 已冻结；
 * 调用方（pull 管线接 T6.2/T6.5 时）把"条目里含已解析 ${VAR} 值"的文件路径显式传进来 ——
 * 权限收紧只信显式入参，绝不去猜内容。
 */
export interface ApplyOptions {
  /** 计划内容里含已解析 ${VAR} 值的路径：写入时把文件权限收紧到 0600（含原本 0644 的） */
  resolvedValuePaths?: Iterable<string>;
}

interface MergeGroup {
  path: string;
  format: 'json' | 'toml';
  pointer: string[];
  writes: PlannedWrite[];
  /** desired key → 条目文本（多资源指向同一文件时取并集，先到者保留） */
  entries: Record<string, string>;
  /** desired key → 归属资源（kept 报告用） */
  keyOwner: Map<string, string>;
}

export function applyPlan(input: ApplyInput, options: ApplyOptions = {}): ApplyOutcome {
  const now = input.now ?? (() => new Date());
  const deliveredAt = now().toISOString();
  const active = new Set(input.activeResources);
  const tighten = new Set(options.resolvedValuePaths ?? []);

  const result: ApplyResult = { written: [], deleted: [], kept: [] };
  const entriesByPath = new Map<string, LedgerEntry>();
  for (const e of input.ledger.entries) entriesByPath.set(e.path, { ...e });

  const record = (path: string, hash: string, resource: string, managedKeys?: Record<string, string>): void => {
    const entry: LedgerEntry = { path, hash, resource, deliveredAt };
    if (managedKeys !== undefined) entry.managedKeys = managedKeys;
    entriesByPath.set(path, entry);
  };

  const writeFileContent = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  };

  // merge 投递：先把每个共享文件的完整新内容全部算完（纯函数，零落盘），再统一进入写入循环。
  // mergeEntries 若抛（未知 format = 内部 bug），异常从第一趟穿出 —— writeFileSync 一次都没调过。
  const mergeGroups = collectMergeGroups(input.writes);
  const mergeOutcomes = new Map<string, { group: MergeGroup; outcome: MergeOutcome }>();
  for (const group of mergeGroups.values()) {
    mergeOutcomes.set(group.path, { group, outcome: runMerge(group, input) });
  }

  const handledMergePaths = new Set<string>();
  for (const write of input.writes) {
    if (write.merge) {
      if (handledMergePaths.has(write.path)) continue;
      handledMergePaths.add(write.path);
      applyMergeWrite(write.path, mergeOutcomes.get(write.path), input, result, record, entriesByPath, tighten);
    } else if (write.region) {
      applyRegionWrite(write, input, result, record, writeFileContent);
    } else {
      applyWholeFileWrite(write, input, result, record, writeFileContent, tighten);
    }
  }

  // 删除：ledger 里有、但不在 activeResources 且落在管辖范围内的条目。
  for (const [path, entry] of [...entriesByPath]) {
    if (active.has(entry.resource)) continue;
    // merge 记账的共享文件永不整文件 unlink / 改名保留 —— 文件里还住着成员的条目和工具状态，
    // "本次不再投某个 server"由 merge 规则 3 逐键删除，轮不到这里动手。
    if (hasManagedKeys(entry)) {
      if (!existsSync(path)) entriesByPath.delete(path);
      continue;
    }
    if (!input.isManaged(path)) continue;
    if (!existsSync(path)) {
      entriesByPath.delete(path);
      continue;
    }
    const current = readFileSync(path, 'utf8');
    if (hashContent(current) === entry.hash) {
      unlinkSync(path);
      entriesByPath.delete(path);
      result.deleted.push(path);
    } else {
      result.kept.push({ path, resource: entry.resource, reason: 'modified-locally' });
    }
  }

  const ledger: Ledger = { version: input.ledger.version, entries: [...entriesByPath.values()] };
  return { result, ledger };
}

function hasManagedKeys(entry: LedgerEntry): boolean {
  return entry.managedKeys !== undefined && Object.keys(entry.managedKeys).length > 0;
}

function collectMergeGroups(writes: PlannedWrite[]): Map<string, MergeGroup> {
  const groups = new Map<string, MergeGroup>();
  for (const write of writes) {
    const merge = write.merge;
    if (!merge) continue;
    let group = groups.get(write.path);
    if (!group) {
      group = {
        path: write.path,
        format: merge.format,
        pointer: merge.pointer,
        writes: [],
        entries: {},
        keyOwner: new Map(),
      };
      groups.set(write.path, group);
    }
    group.writes.push(write);
    for (const [key, text] of Object.entries(merge.entries)) {
      if (!Object.prototype.hasOwnProperty.call(group.entries, key)) {
        group.entries[key] = text;
        group.keyOwner.set(key, write.resource);
      }
    }
  }
  return groups;
}

function runMerge(group: MergeGroup, input: ApplyInput): MergeOutcome {
  let current: string | null;
  if (existsSync(group.path)) {
    try {
      current = readFileSync(group.path, 'utf8');
    } catch {
      // 读不出来 = 无法安全合并；错误文案只提路径，不提内容。
      return { ok: false, error: `cannot read ${group.path}` };
    }
  } else {
    current = null;
  }
  const previous = ledgerEntry(input.ledger, group.path)?.managedKeys ?? {};
  return mergeEntries({
    format: group.format,
    pointer: group.pointer,
    current,
    previous,
    desired: group.entries,
  });
}

/** 受管条目合并的键指纹：与文件里的成员条目无关，只对我们那几个键负责（ledgercheck 逐键核对）。 */
function mergeFingerprint(managedKeys: Record<string, string>): string {
  const parts = Object.entries(managedKeys)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, h]) => `${k}\u0000${h}`);
  return hashContent(parts.join('\u0001'));
}

function applyMergeWrite(
  path: string,
  packed: { group: MergeGroup; outcome: MergeOutcome } | undefined,
  input: ApplyInput,
  result: ApplyResult,
  record: (path: string, hash: string, resource: string, managedKeys?: Record<string, string>) => void,
  entriesByPath: Map<string, LedgerEntry>,
  tighten: Set<string>,
): void {
  if (!packed) return;
  const { group, outcome } = packed;
  if (!outcome.ok) {
    // §3.3 规则 5：解析失败/异形 → 本次整体跳过该工具，不落盘；账本原样保留（下次 pull 再试）。
    return;
  }
  const delivered = outcome.delivered ?? {};
  const kept = outcome.kept ?? [];
  const leader = group.writes[0] as PlannedWrite;
  const keepResource = (key: string): string => group.keyOwner.get(key) ?? leader.resource;

  for (const k of kept) {
    result.kept.push({
      path,
      resource: keepResource(k.key),
      reason: k.reason === 'foreign-entry' ? 'foreign-file' : 'modified-locally',
    });
  }

  if (Object.keys(delivered).length === 0 && !outcome.changed) {
    // 我们在这个文件里已无任何条目、本轮也没有要写的字节：账本改回无记账即可。
    entriesByPath.delete(path);
    return;
  }

  if (outcome.changed && outcome.text !== undefined) {
    const existed = existsSync(path);
    const prevMode = existed ? statSync(path).mode & 0o777 : undefined;
    // 新建的 merge 文件一律 0600（§3.3 规则 5；成员在用的旧文件只在含已解析值时才收紧）。
    const mode = !existed || tighten.has(path) ? 0o600 : prevMode ?? 0o644;
    atomicWriteWithMode(path, outcome.text, mode);
    for (const write of group.writes) result.written.push(write);
  }
  if (Object.keys(delivered).length === 0) {
    // 清空了我们最后的条目：文件是成员的，绝不 unlink，但记账到此为止。
    entriesByPath.delete(path);
    return;
  }
  record(path, mergeFingerprint(delivered), leader.resource, delivered);
}

/**
 * 临时文件 + rename 落盘：半写文件不允许存在。
 * mode 为 null 时尽量保持目标原权限；权限位从临时文件起就是 0600，
 * 收紧场景（含已解析 ${VAR} 值）不会让密钥先以组可读的形态出现在磁盘上。
 */
function atomicWriteWithMode(path: string, text: string, mode: number | null): void {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  const prevMode = existed ? statSync(path).mode & 0o777 : undefined;
  const tmp = join(dirname(path), `.${basenameOf(path)}.ejdrone-tmp-${process.pid}`);
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    const finalMode = mode ?? prevMode;
    if (finalMode !== undefined) chmodSync(path, finalMode);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
}

function basenameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function applyWholeFileWrite(
  write: PlannedWrite,
  input: ApplyInput,
  result: ApplyResult,
  record: (path: string, hash: string, resource: string) => void,
  writeFileContent: (path: string, content: string) => void,
  tighten: Set<string>,
): void {
  const path = write.path;
  const newHash = hashContent(write.content);
  const entry = ledgerEntry(input.ledger, path);

  // 含已解析值的新文件从第一次落盘就是 0600；不含的走原路径（保持 1.0 行为逐字节不变）。
  const emit = (content: string): void => {
    if (tighten.has(path)) atomicWriteWithMode(path, content, 0o600);
    else writeFileContent(path, content);
  };

  if (!existsSync(path)) {
    emit(write.content);
    record(path, newHash, write.resource);
    result.written.push(write);
    return;
  }

  const existing = readFileSync(path, 'utf8');
  const existingHash = hashContent(existing);
  if (existingHash === newHash) {
    record(path, newHash, write.resource);
    return;
  }
  if (entry && entry.hash === existingHash) {
    emit(write.content);
    record(path, newHash, write.resource);
    result.written.push(write);
    return;
  }
  result.kept.push({
    path,
    resource: write.resource,
    reason: entry ? 'modified-locally' : 'foreign-file',
  });
}

function applyRegionWrite(
  write: PlannedWrite,
  input: ApplyInput,
  result: ApplyResult,
  record: (path: string, hash: string, resource: string) => void,
  writeFileContent: (path: string, content: string) => void,
): void {
  const path = write.path;
  const { start, end } = write.region as { start: string; end: string };
  const deliveredInner = normalizeInner(write.content);
  const deliveredHash = hashContent(deliveredInner);
  const entry = ledgerEntry(input.ledger, path);

  // 零规则时不去创建或改动 AGENTS.md —— 既没内容可投，也没有区块要清。
  // 只有"已存在区块"（团队删掉了最后一条 rule）才继续走下面的清空路径。
  if (write.content.trim() === '') {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (locateRegion(current, start, end) === null) return;
  }

  if (!existsSync(path)) {
    const newText = blockText(start, end, write.content);
    writeFileContent(path, newText);
    record(path, deliveredHash, write.resource);
    result.written.push(write);
    return;
  }

  const existing = readFileSync(path, 'utf8');
  const loc = locateRegion(existing, start, end);

  if (loc === null && hasOrphanMarker(existing, start, end)) {
    result.kept.push({
      path,
      resource: write.resource,
      reason: entry ? 'modified-locally' : 'foreign-file',
    });
    return;
  }

  if (!loc) {
    const newText = appendBlock(existing, start, end, write.content);
    writeFileContent(path, newText);
    record(path, deliveredHash, write.resource);
    result.written.push(write);
    return;
  }

  const currentInner = existing.slice(loc.contentStart, loc.contentEnd);
  const currentInnerHash = hashContent(currentInner);

  if (currentInnerHash === deliveredHash) {
    record(path, deliveredHash, write.resource);
    return;
  }
  if (entry && entry.hash === currentInnerHash) {
    const newText = replaceRegion(existing, loc, write.content);
    writeFileContent(path, newText);
    record(path, deliveredHash, write.resource);
    result.written.push(write);
    return;
  }
  // 区块被本地改过（有记账）或属他人文件（无记账）：只动区块之外的内容 = 不动。
  const kept: KeptFile = {
    path,
    resource: write.resource,
    reason: entry ? 'modified-locally' : 'foreign-file',
  };
  result.kept.push(kept);
}
