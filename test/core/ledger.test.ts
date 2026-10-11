import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashContent, ledgerEntry, loadLedger, saveLedger } from '../../src/core/ledger.js';
import type { Ledger } from '../../src/core/types.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function tmp(): string {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-'));
  return root;
}

describe('hashContent', () => {
  it('produces a prefixed sha256 digest', () => {
    expect(hashContent('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('distinguishes different inputs', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('loadLedger', () => {
  it('returns an empty ledger when the file is absent', () => {
    const p = join(tmp(), 'ledger.json');
    expect(loadLedger(p)).toEqual({ ledger: { version: 1, entries: [] } });
  });

  it('2.0 managedKeys 是可选字段：1.0 旧账本（没有它）必须仍然合法', () => {
    // 回落空账本 = 下次 pull 把全体成员的已投文件当"别人的文件"永久保留，回归极重，
    // 所以"旧格式合法"必须钉死成独立用例。
    const dir = tmp();
    const p = join(dir, 'ledger.json');
    const legacy = JSON.stringify({
      version: 1,
      entries: [{ path: '/x/SKILL.md', hash: 'sha256:abc', resource: 'skills:x', deliveredAt: 't' }],
    });
    writeFileSync(p, legacy, 'utf8');
    const res = loadLedger(p);
    expect(res.warning).toBeUndefined();
    expect(res.ledger.entries[0]).toEqual({
      path: '/x/SKILL.md',
      hash: 'sha256:abc',
      resource: 'skills:x',
      deliveredAt: 't',
    });
    expect('managedKeys' in (res.ledger.entries[0] as object)).toBe(false); // 缺 = 空集，不造字段
  });

  it('managedKeys 读写往返无损；结构坏的 managedKeys 判非法（不误当空集投回去）', () => {
    const dir = tmp();
    const p = join(dir, 'ledger.json');
    const ledger: Ledger = {
      version: 1,
      entries: [
        {
          path: '/x/.claude.json',
          hash: 'sha256:fp',
          resource: 'mcp:alpha',
          deliveredAt: 't',
          managedKeys: { alpha: 'sha256:1', beta: 'sha256:2' },
        },
      ],
    };
    saveLedger(p, ledger);
    expect(loadLedger(p).ledger).toEqual(ledger);

    const bad = join(dir, 'ledger-bad.json');
    writeFileSync(bad, JSON.stringify({ version: 1, entries: [{ ...ledger.entries[0], managedKeys: 'oops' }] }), 'utf8');
    const res = loadLedger(bad);
    expect(res.warning).toBeDefined();
    expect(res.ledger.entries).toEqual([]);
  });

  it('loads a valid ledger', () => {
    const dir = tmp();
    const p = join(dir, 'ledger.json');
    const ledger: Ledger = {
      version: 1,
      entries: [{ path: '/x/SKILL.md', hash: 'sha256:abc', resource: 'skills:x', deliveredAt: 't' }],
    };
    writeFileSync(p, JSON.stringify(ledger), 'utf8');
    const res = loadLedger(p);
    expect(res.warning).toBeUndefined();
    expect(res.ledger).toEqual(ledger);
  });

  it('returns empty + warning for corrupt JSON and does not overwrite the file', () => {
    const dir = tmp();
    const p = join(dir, 'ledger.json');
    const raw = '{ this is not json';
    writeFileSync(p, raw, 'utf8');
    const res = loadLedger(p);
    expect(res.ledger).toEqual({ version: 1, entries: [] });
    expect(res.warning).toBeDefined();
    expect(readFileSync(p, 'utf8')).toBe(raw);
  });

  it('returns empty + warning for an invalid structure and leaves the file alone', () => {
    const dir = tmp();
    const p = join(dir, 'ledger.json');
    const raw = JSON.stringify({ version: 1, entries: [{ path: '/x' }] });
    writeFileSync(p, raw, 'utf8');
    const res = loadLedger(p);
    expect(res.ledger).toEqual({ version: 1, entries: [] });
    expect(res.warning).toBeDefined();
    expect(readFileSync(p, 'utf8')).toBe(raw);
  });
});

describe('saveLedger', () => {
  it('round-trips atomically without leaving a temp file', () => {
    const dir = tmp();
    const p = join(dir, 'nested', 'ledger.json');
    const ledger: Ledger = {
      version: 1,
      entries: [{ path: '/x', hash: 'sha256:1', resource: 'skills:x', deliveredAt: 't' }],
    };
    saveLedger(p, ledger);
    expect(loadLedger(p).ledger).toEqual(ledger);
    const leftovers = readdirSync(join(dir, 'nested')).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('ledgerEntry', () => {
  it('finds an entry by exact path and returns undefined otherwise', () => {
    const ledger: Ledger = {
      version: 1,
      entries: [
        { path: '/a', hash: 'h1', resource: 'r1', deliveredAt: 't' },
        { path: '/b', hash: 'h2', resource: 'r2', deliveredAt: 't' },
      ],
    };
    expect(ledgerEntry(ledger, '/b')?.hash).toBe('h2');
    expect(ledgerEntry(ledger, '/c')).toBeUndefined();
  });
});
