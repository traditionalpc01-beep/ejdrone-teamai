import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

export function applyPlan(input: ApplyInput): ApplyOutcome {
  const now = input.now ?? (() => new Date());
  const deliveredAt = now().toISOString();
  const active = new Set(input.activeResources);

  const result: ApplyResult = { written: [], deleted: [], kept: [] };
  const entriesByPath = new Map<string, LedgerEntry>();
  for (const e of input.ledger.entries) entriesByPath.set(e.path, { ...e });

  const record = (path: string, hash: string, resource: string): void => {
    entriesByPath.set(path, { path, hash, resource, deliveredAt });
  };

  const writeFileContent = (path: string, content: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  };

  for (const write of input.writes) {
    if (write.region) {
      applyRegionWrite(write, input, result, record, writeFileContent);
    } else {
      applyWholeFileWrite(write, input, result, record, writeFileContent);
    }
  }

  // 删除：ledger 里 resource 不在 activeResources 且落在管辖范围内的条目。
  for (const [path, entry] of [...entriesByPath]) {
    if (active.has(entry.resource)) continue;
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

function applyWholeFileWrite(
  write: PlannedWrite,
  input: ApplyInput,
  result: ApplyResult,
  record: (path: string, hash: string, resource: string) => void,
  writeFileContent: (path: string, content: string) => void,
): void {
  const path = write.path;
  const newHash = hashContent(write.content);
  const entry = ledgerEntry(input.ledger, path);

  if (!existsSync(path)) {
    writeFileContent(path, write.content);
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
    writeFileContent(path, write.content);
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
