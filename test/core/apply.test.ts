import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPlan } from '../../src/core/apply.js';
import { hashContent } from '../../src/core/ledger.js';
import { hasHook, removeHook, upsertHook } from '../../src/hooks.js';
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

  it('零规则 + 文件不存在：完全不碰这个文件，也不记账', () => {
    const path = join(home, 'AGENTS.md');
    const w: PlannedWrite = { path, content: '', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger: ledgerWith([]) }));
    expect(out.result.written).toHaveLength(0);
    expect(out.result.kept).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
    expect(out.ledger.entries).toHaveLength(0);
  });

  it('零规则 + 文件里没有区块：不去创建一个空区块', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, '用户自己的说明\n');
    const w: PlannedWrite = { path, content: '', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: [], ledger: ledgerWith([]) }));
    expect(out.result.written).toHaveLength(0);
    expect(readFileSync(path, 'utf8')).toBe('用户自己的说明\n');
  });

  it('零规则 + 已存在区块：执行清空但保留标记（团队删掉了最后一条 rule）', () => {
    const path = join(home, 'AGENTS.md');
    seedFile(path, `OUTSIDE\n${START}\nOLD RULE\n${END}\n`);
    const ledger = ledgerWith([rec(path, hashContent('OLD RULE\n'), 'rules:team')]);
    const w: PlannedWrite = { path, content: '', resource: 'rules:team', region: { start: START, end: END } };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['rules:team'], ledger }));
    expect(out.result.written).toHaveLength(1);
    const after = readFileSync(path, 'utf8');
    expect(after).toContain('OUTSIDE');
    expect(after).toContain(START);
    expect(after).toContain(END);
    expect(after).not.toContain('OLD RULE');
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

// ---------------------------------------------------------------- M6：merge 投递

function memberClaudeJson(): string {
  return `${JSON.stringify(
    {
      userID: 'user-1',
      cachedGrowthBookFeatures: { 'flag-a': true },
      mcpServers: { mcpServers: { command: 'scar' }, personal: { command: 'mine' } },
    },
    null,
    2,
  )}\n`;
}

function mergeJsonWrite(path: string, resource: string, entries: Record<string, string>): PlannedWrite {
  return { path, content: '', resource, merge: { format: 'json', pointer: ['mcpServers'], entries } };
}

const ALPHA = '{"command":"npx","args":["-y","alpha"]}';
const BETA = '{"url":"https://beta.example/mcp"}';

describe('applyPlan: merge delivery (受管条目合并)', () => {
  it('首次 apply：只写我们的条目，成员条目原样，ledger 记 managedKeys', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    chmodSync(path, 0o644);
    const w = mergeJsonWrite(path, 'mcp:alpha', { alpha: ALPHA });
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:alpha'] }));

    expect(out.result.written).toEqual([w]);
    expect(out.result.kept).toEqual([]);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      userID: string;
      mcpServers: Record<string, unknown>;
    };
    expect(doc.mcpServers.alpha).toEqual({ command: 'npx', args: ['-y', 'alpha'] });
    expect(doc.mcpServers.personal).toEqual({ command: 'mine' }); // 规则 4：成员的键原样
    expect(doc.userID).toBe('user-1');

    const entry = out.ledger.entries[0] as LedgerEntry;
    expect(entry.path).toBe(path);
    expect(entry.resource).toBe('mcp:alpha');
    expect(Object.keys(entry.managedKeys ?? {})).toEqual(['alpha']);
    // merge 条目的 hash 是"我们那几个键"的指纹，不是整文件哈希
    expect(entry.hash).not.toBe(hashContent(readFileSync(path, 'utf8')));
    // 成员权限不被打扰（本轮无已解析值入参）
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('二次 apply：changed=false，一个字节都不写，ledger 条目不变', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    const w = mergeJsonWrite(path, 'mcp:alpha', { alpha: ALPHA });
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:alpha'] }));
    const bytes = readFileSync(path, 'utf8');

    const run2 = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:alpha'], ledger: run1.ledger }));
    expect(run2.result.written).toEqual([]);
    expect(run2.result.kept).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(run2.ledger.entries).toEqual(run1.ledger.entries); // 指纹稳定 + 幂等
  });

  it('成员改过我们那条：kept(modified-locally)，文件不被覆盖，账本保留旧哈希继续追踪', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    const w = mergeJsonWrite(path, 'mcp:alpha', { alpha: ALPHA });
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:alpha'] }));
    const memberEdited = readFileSync(path, 'utf8').replace('"command": "npx"', '"command": "member-own"');
    seedFile(path, memberEdited);

    const run2 = applyPlan(
      makeInput({
        writes: [mergeJsonWrite(path, 'mcp:alpha', { alpha: '{"command":"team-v2"}' })],
        activeResources: ['mcp:alpha'],
        ledger: run1.ledger,
      }),
    );
    expect(run2.result.written).toEqual([]);
    expect(run2.result.kept).toEqual([{ path, resource: 'mcp:alpha', reason: 'modified-locally' }]);
    expect(readFileSync(path, 'utf8')).toBe(memberEdited); // 一个字都不动
    expect(run2.ledger.entries[0]?.managedKeys).toEqual(run1.ledger.entries[0]?.managedKeys);
  });

  it('本次不再投该 server：条目被删而成员条目原样；最后的条目删完 → 记账消失、文件绝不 unlink', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    const run1 = applyPlan(
      makeInput({ writes: [mergeJsonWrite(path, 'mcp:alpha', { alpha: ALPHA })], activeResources: ['mcp:alpha'] }),
    );
    const run2 = applyPlan(
      makeInput({
        writes: [mergeJsonWrite(path, 'mcp:beta', { beta: BETA })],
        activeResources: ['mcp:beta'],
        ledger: run1.ledger,
      }),
    );
    let doc = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect('alpha' in doc.mcpServers).toBe(false); // 规则 3：没改过 → 删
    expect(doc.mcpServers.beta).toEqual({ url: 'https://beta.example/mcp' });
    expect(doc.mcpServers.personal).toEqual({ command: 'mine' });
    expect(Object.keys(run2.ledger.entries[0]?.managedKeys ?? {})).toEqual(['beta']);

    // 停投最后一个：文件里只剩成员内容，账本条目消失，但文件还在（成员在用）
    const run3 = applyPlan(
      makeInput({
        writes: [mergeJsonWrite(path, 'mcp:beta', {})],
        activeResources: ['mcp:beta'],
        ledger: run2.ledger,
      }),
    );
    expect(run3.result.written).toHaveLength(1);
    expect(run3.ledger.entries).toEqual([]);
    expect(existsSync(path)).toBe(true);
    doc = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers).toEqual({ mcpServers: { command: 'scar' }, personal: { command: 'mine' } });
  });

  it('merge path 永不进 unlink 分支：账本条目停发也只保留（比对整文件哈希都不做）', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    const stale: LedgerEntry = {
      path,
      hash: 'sha256:whatever',
      resource: 'mcp:gone',
      deliveredAt: ISO,
      managedKeys: { gone: 'sha256:abc' },
    };
    const out = applyPlan(makeInput({ activeResources: [], ledger: ledgerWith([stale]) }));
    expect(out.result.deleted).toEqual([]);
    expect(out.result.kept).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(out.ledger.entries).toEqual([stale]); // 记账保留，下次 pull 由 merge 规则接手
  });

  it('两个 PlannedWrite 指向同一 path：合并成一次 merge 调用，desired 取并集', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    const wA = mergeJsonWrite(path, 'mcp:alpha', { alpha: ALPHA });
    const wB = mergeJsonWrite(path, 'mcp:beta', { beta: BETA });
    const out = applyPlan(makeInput({ writes: [wA, wB], activeResources: ['mcp:alpha', 'mcp:beta'] }));
    expect(out.result.written).toEqual([wA, wB]);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(doc.mcpServers).sort()).toEqual(['beta', 'mcpServers', 'personal', 'alpha'].sort());
    expect(out.ledger.entries).toHaveLength(1);
    expect(Object.keys(out.ledger.entries[0]?.managedKeys ?? {}).sort()).toEqual(['alpha', 'beta']);

    const out2 = applyPlan(
      makeInput({ writes: [wA, wB], activeResources: ['mcp:alpha', 'mcp:beta'], ledger: out.ledger }),
    );
    expect(out2.result.written).toEqual([]); // 并集没有互相覆盖丢键 → 幂等
  });

  it('文件解析失败：整体跳过该工具，不落盘、不记账、不留临时文件', () => {
    const path = join(home, '.claude.json');
    seedFile(path, '{ broken LEAK-CANARY');
    const w = mergeJsonWrite(path, 'mcp:alpha', { alpha: ALPHA });
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:alpha'] }));
    expect(out.result.written).toEqual([]);
    expect(out.result.kept).toEqual([]);
    expect(out.ledger.entries).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('{ broken LEAK-CANARY');
    const leftovers = readdirSync(home).filter((f) => f.includes('ejdrone-tmp') || f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('渲染阶段抛错（未知 format = 内部 bug）：同计划里的普通写入也一次都不落盘', () => {
    const plainPath = join(home, 'skills', 'foo', 'SKILL.md');
    const mergePath = join(home, '.claude.json');
    const plain: PlannedWrite = { path: plainPath, content: 'body', resource: 'skills:foo' };
    const bad: PlannedWrite = {
      path: mergePath,
      content: '',
      resource: 'mcp:z',
      merge: { format: 'yaml' as unknown as 'json', pointer: ['mcpServers'], entries: { z: '{}' } },
    };
    expect(() => applyPlan(makeInput({ writes: [plain, bad], activeResources: ['skills:foo', 'mcp:z'] }))).toThrow();
    expect(existsSync(plainPath)).toBe(false); // 写前先算完整 plan：一个 writeFileSync 都没跑
    expect(existsSync(mergePath)).toBe(false);
  });

  it('TOML：投递进成员手写的 config.toml，块外字节不变；二次 apply 幂等；0600 保持', () => {
    const path = join(home, 'codex', 'config.toml');
    const tomlText = [
      '# user note',
      'model = "gpt-5"',
      '',
      '[features]',
      'x = true',
      '',
      '[mcp_servers.member]',
      'command = "own"',
      '',
    ].join('\n');
    seedFile(path, tomlText);
    chmodSync(path, 0o600);
    const w: PlannedWrite = {
      path,
      content: '',
      resource: 'mcp:team',
      merge: {
        format: 'toml',
        pointer: ['mcp_servers'],
        entries: { team: '[mcp_servers.team]\ncommand = "npx"\n\n[mcp_servers.team.env]\nTOKEN = "v"\n' },
      },
    };
    const out = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:team'] }));
    expect(out.result.written).toEqual([w]);
    const after = readFileSync(path, 'utf8');
    expect(after).toContain('# user note');
    expect(after).toContain('[mcp_servers.member]\ncommand = "own"\n');
    expect(after).toContain('[mcp_servers.team]\ncommand = "npx"');
    expect(after).toContain('[mcp_servers.team.env]\nTOKEN = "v"');
    expect(Object.keys(out.ledger.entries[0]?.managedKeys ?? {})).toEqual(['team']);
    expect(statSync(path).mode & 0o777).toBe(0o600); // 原有权限保持

    const out2 = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:team'], ledger: out.ledger }));
    expect(out2.result.written).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(after);
  });

  it('含已解析 ${VAR} 值：显式入参路径 → 0600（原本 0644 的也收紧）；新建 merge 文件恒 0600', () => {
    const path = join(home, '.claude.json');
    seedFile(path, memberClaudeJson());
    chmodSync(path, 0o644);
    const w = mergeJsonWrite(path, 'mcp:alpha', { alpha: '{"env":{"TOKEN":"s"}}' });
    applyPlan(makeInput({ writes: [w], activeResources: ['mcp:alpha'] }), { resolvedValuePaths: [path] });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const fresh = join(home, 'fresh', '.claude.json');
    const w2 = mergeJsonWrite(fresh, 'mcp:alpha', { alpha: ALPHA });
    applyPlan(makeInput({ writes: [w2], activeResources: ['mcp:alpha'] }));
    expect(statSync(fresh).mode & 0o777).toBe(0o600); // 规则 5：新建就收紧

    const plainPath = join(home, 'secret.md');
    const plain: PlannedWrite = { path: plainPath, content: 'has-resolved', resource: 'skills:p' };
    applyPlan(makeInput({ writes: [plain], activeResources: ['skills:p'] }), { resolvedValuePaths: [plainPath] });
    expect(statSync(plainPath).mode & 0o777).toBe(0o600);
  });

  it('同一个 settings.json：先装 hook 再 merge mcp 条目，两条写路径互不破坏', () => {
    const settings = join(home, 'qoder-cn', 'settings.json');
    seedFile(
      settings,
      `${JSON.stringify(
        { enabledPlugins: { 'p-a': true }, mcpServers: { GitHub: { url: 'https://gh' } } },
        null,
        2,
      )}\n`,
    );
    chmodSync(settings, 0o600); // 真机 ~/.qoder-cn/settings.json 是 0600
    const SPEC = { event: 'SessionStart', cmd: 'EJDRONE_HOOK=1 /node /cli.js pull --silent' };
    upsertHook(settings, SPEC);

    const w = mergeJsonWrite(settings, 'mcp:team', { team: '{"command":"npx"}' });
    const run1 = applyPlan(makeInput({ writes: [w], activeResources: ['mcp:team'] }));
    expect(run1.result.written).toEqual([w]);
    let doc = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, any>;
    expect(hasHook(settings, 'SessionStart')).toBe(true); // merge 没伤 hooks 键
    expect(doc.mcpServers.GitHub).toEqual({ url: 'https://gh' }); // hook 写回没伤成员 mcp 键
    expect(doc.mcpServers.team).toEqual({ command: 'npx' });
    expect(doc.enabledPlugins).toEqual({ 'p-a': true });
    expect(statSync(settings).mode & 0o777).toBe(0o600);

    const run2 = applyPlan(
      makeInput({ writes: [w], activeResources: ['mcp:team'], ledger: run1.ledger }),
    );
    expect(run2.result.written).toEqual([]); // 与 hook 共存的格式回环下仍幂等

    removeHook(settings, 'SessionStart'); // hook 卸载也不得带走我们的条目
    doc = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, any>;
    expect(hasHook(settings, 'SessionStart')).toBe(false);
    expect(doc.mcpServers.team).toEqual({ command: 'npx' });
    expect(doc.mcpServers.GitHub).toEqual({ url: 'https://gh' });
  });
});
