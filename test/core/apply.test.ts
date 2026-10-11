import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/core/apply.js';
import { hashContent } from '../../src/core/ledger.js';
import type { ApplyInput, Ledger, LedgerEntry, PlannedWrite } from '../../src/core/types.js';

const START = '<!-- ejdrone:team-rules:start -->';
const END = '<!-- ejdrone:team-rules:end -->';

let root = '';
let home = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  home = '';
});

const NOW = () => new Date('2026-01-01T00:00:00.000Z');
const ISO = NOW().toISOString();

function seedFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeInput(over: Partial<ApplyInput>): ApplyInput {
  return {
    writes: [],
    activeResources: [],
    ledger: { version: 1, entries: [] },
    isManaged: (p) => p.startsWith(home),
    now: NOW,
    ...over,
  };
}

function ledgerWith(entries: LedgerEntry[]): Ledger {
  return { version: 1, entries };
}
function rec(path: string, hash: string, resource: string): LedgerEntry {
  return { path, hash, resource, deliveredAt: ISO };
}

describe('applyPlan: whole-file writes', () => {
  it('writes a new file and records it', () => {
    const path = join(home, 'claude', 'skills', 'foo', 'SKILL.md');
    const w: PlannedWrite = { path, content: 'body', resource: 'skills:foo' };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['skills:foo'] }));
    expect(out.result.written).toEqual([w]);
    expect(readFileSync(path, 'utf8')).toBe('body');
    expect(out.ledger.entries).toEqual([rec(path, hashContent('body'), 'skills:foo')]);
  });

  it('treats identical content as already delivered (no write, still recorded)', () => {
    const path = join(home, 'a.md');
    seedFile(path, 'body');
    const w: PlannedWrite = { path, content: 'body', resource: 'skills:a' };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['skills:a'] }));
    expect(out.result.written).toEqual([]);
    expect(out.ledger.entries[0]?.hash).toBe(hashContent('body'));
  });

  it('keeps a locally-modified managed file and retains its ledger entry', () => {
    const path = join(home, 'a.md');
    seedFile(path, 'user-edit');
    const ledger = ledgerWith([rec(path, hashContent('OLD'), 'skills:a')]);
    const w: PlannedWrite = { path, content: 'body', resource: 'skills:a' };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['skills:a'], ledger }));
    expect(out.result.written).toEqual([]);
    expect(out.result.kept).toEqual([{ path, resource: 'skills:a', reason: 'modified-locally' }]);
    expect(readFileSync(path, 'utf8')).toBe('user-edit');
    expect(out.ledger.entries).toEqual([rec(path, hashContent('OLD'), 'skills:a')]);
  });

  it('keeps an unaccounted foreign file and adds no ledger entry', () => {
    const path = join(home, 'x.md');
    seedFile(path, 'foreign');
    const w: PlannedWrite = { path, content: 'body', resource: 'skills:x' };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['skills:x'] }));
    expect(out.result.kept).toEqual([{ path, resource: 'skills:x', reason: 'foreign-file' }]);
    expect(out.ledger.entries).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('foreign');
  });

  it('overwrites a managed file that was not locally modified (upstream update)', () => {
    const path = join(home, 'a.md');
    seedFile(path, 'v1');
    const ledger = ledgerWith([rec(path, hashContent('v1'), 'skills:a')]);
    const w: PlannedWrite = { path, content: 'v2', resource: 'skills:a' };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['skills:a'], ledger }));
    expect(out.result.written).toEqual([w]);
    expect(readFileSync(path, 'utf8')).toBe('v2');
    expect(out.ledger.entries[0]?.hash).toBe(hashContent('v2'));
  });

  it('does not mutate the input ledger', () => {
    const path = join(home, 'a.md');
    const ledger = ledgerWith([rec(join(root, 'untouched'), 'h', 'skills:u')]);
    const snapshot = JSON.stringify(ledger);
    const w: PlannedWrite = { path, content: 'b', resource: 'skills:a' };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['skills:a'], ledger }));
    expect(JSON.stringify(ledger)).toBe(snapshot);
    expect(out.ledger).not.toBe(ledger);
  });
});

describe('applyPlan: deletions', () => {
  it('deletes a managed, unmodified, no-longer-active resource', () => {
    const path = join(home, 'gone.md');
    seedFile(path, 'content');
    const ledger = ledgerWith([rec(path, hashContent('content'), 'skills:gone')]);
    const out = applyPlan(makeInput({ activeResources: [], ledger }));
    expect(out.result.deleted).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect(out.ledger.entries).toEqual([]);
  });

  it('keeps and retains a modified, no-longer-active managed file', () => {
    const path = join(home, 'gone.md');
    seedFile(path, 'DIFFERENT');
    const ledger = ledgerWith([rec(path, hashContent('content'), 'skills:gone')]);
    const out = applyPlan(makeInput({ activeResources: [], ledger }));
    expect(out.result.deleted).toEqual([]);
    expect(out.result.kept).toEqual([{ path, resource: 'skills:gone', reason: 'modified-locally' }]);
    expect(out.ledger.entries).toEqual([rec(path, hashContent('content'), 'skills:gone')]);
    expect(existsSync(path)).toBe(true);
  });

  it('leaves a no-longer-active file alone when it is outside management', () => {
    const path = join(root, 'elsewhere', 'x.md');
    seedFile(path, 'content');
    const ledger = ledgerWith([rec(path, hashContent('content'), 'skills:gone')]);
    const out = applyPlan(makeInput({ activeResources: [], ledger }));
    expect(out.result.deleted).toEqual([]);
    expect(out.result.kept).toEqual([]);
    expect(out.ledger.entries).toEqual([rec(path, hashContent('content'), 'skills:gone')]);
    expect(existsSync(path)).toBe(true);
  });
});

describe('applyPlan: region (block) writes', () => {
  it('creates a block-only file when it does not exist', () => {
    const path = join(home, 'newdir', 'AGENTS.md');
    const w: PlannedWrite = { path, content: 'BODY', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'] }));
    expect(out.result.written).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(`${START}\nBODY\n${END}\n`);
    expect(out.ledger.entries[0]?.hash).toBe(hashContent('BODY\n'));
  });

  it('appends a block to an existing file, preserving all outside content', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, 'USER HEAD\nUSER TAIL\n');
    const w: PlannedWrite = { path, content: 'TEAM RULE', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'] }));
    expect(out.result.written).toHaveLength(1);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('USER HEAD');
    expect(text).toContain('USER TAIL');
    expect(text.indexOf('USER HEAD')).toBeLessThan(text.indexOf('TEAM RULE'));
    expect(out.ledger.entries[0]?.hash).toBe(hashContent('TEAM RULE\n'));
  });

  it('is idempotent for a region write', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, 'MY DOC\n');
    const w: PlannedWrite = { path, content: 'TEAM', resource: 'rules:team', region: { start: START, end: END } };
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'] }));
    const after1 = readFileSync(path, 'utf8');
    const run2 = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger: run1.ledger }));
    expect(run2.result.written).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(after1);
  });

  it('replaces only inside the block on an upstream change, keeping outside bytes exact', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, `HEAD\n${START}\nOLD\n${END}\nTAIL\n`);
    const ledger = ledgerWith([rec(path, hashContent('OLD\n'), 'rules:team')]);
    const w: PlannedWrite = { path, content: 'NEW', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger }));
    expect(out.result.written).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(`HEAD\n${START}\nNEW\n${END}\nTAIL\n`);
    expect(out.ledger.entries[0]?.hash).toBe(hashContent('NEW\n'));
  });

  it('compares only the block: user edits outside the block do not count as a local modification', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, 'MY DOC\n');
    const w: PlannedWrite = { path, content: 'TEAM', resource: 'rules:team', region: { start: START, end: END } };
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'] }));
    const withBlock = readFileSync(path, 'utf8');
    seedFile(path, `MY NEW NOTES\n${withBlock}`);
    const run2 = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger: run1.ledger }));
    expect(run2.result.written).toEqual([]);
    expect(run2.result.kept).toEqual([]);
    const final = readFileSync(path, 'utf8');
    expect(final).toContain('MY NEW NOTES');
    expect(final).toContain('TEAM');
  });

  it('keeps a locally-modified block (compares block text, not whole file)', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, 'MY DOC\n');
    const w: PlannedWrite = { path, content: 'TEAM', resource: 'rules:team', region: { start: START, end: END } };
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'] }));
    seedFile(path, readFileSync(path, 'utf8').replace('TEAM', 'MY OWN RULE'));
    const run2 = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger: run1.ledger }));
    expect(run2.result.kept).toEqual([{ path, resource: 'rules:team', reason: 'modified-locally' }]);
    expect(run2.result.written).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('MY OWN RULE');
  });

  it('treats a foreign file that already has our markers but no ledger entry as foreign-file', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, `${START}\nSOMETHING ELSE\n${END}\n`);
    const w: PlannedWrite = { path, content: 'TEAM', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'] }));
    expect(out.result.kept).toEqual([{ path, resource: 'rules:team', reason: 'foreign-file' }]);
    expect(out.ledger.entries).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('SOMETHING ELSE');
  });

  it('uses the first marker pair when markers are duplicated', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, `${START}\nAAA\n${END}\nOUTSIDE\n${START}\nBBB\n${END}\n`);
    const ledger = ledgerWith([rec(path, hashContent('AAA\n'), 'rules:team')]);
    const w: PlannedWrite = { path, content: 'NEW', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger }));
    expect(out.result.written).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(`${START}\nNEW\n${END}\nOUTSIDE\n${START}\nBBB\n${END}\n`);
  });
});

describe('applyPlan: idempotency across writes and deletes', () => {
  it('second run produces no writes and no deletes', () => {
    const pathNew = join(home, 'new.md');
    const pathOld = join(home, 'old.md');
    seedFile(pathOld, 'oldc');
    const w: PlannedWrite = { path: pathNew, content: 'newc', resource: 'skills:new' };
    const ledger1 = ledgerWith([rec(pathOld, hashContent('oldc'), 'skills:old')]);
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['skills:new'], ledger: ledger1 }));
    expect(run1.result.written.map((x) => x.path)).toEqual([pathNew]);
    expect(run1.result.deleted).toEqual([pathOld]);

    const run2 = applyPlan(makeInput({ writes: [w], activeResources: ['skills:new'], ledger: run1.ledger }));
    expect(run2.result.written).toEqual([]);
    expect(run2.result.deleted).toEqual([]);
    expect(run2.ledger.entries.map((e) => e.path)).toEqual([pathNew]);
  });
});
