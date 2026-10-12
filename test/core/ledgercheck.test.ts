import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLedger } from '../../src/cli/ledgercheck.js';
import { applyPlan } from '../../src/core/apply.js';
import { hashContent } from '../../src/core/ledger.js';
import type { ApplyInput, Ledger, PlannedWrite } from '../../src/core/types.js';

// ledgercheck 的 merge 认识能力靠"真 apply 产出的账本"来喂 —— 核对语义必须与 apply/merge 同源。

let dir = '';
let settings = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ejdrone-audit-'));
  settings = join(dir, 'settings.json');
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const NOW = () => new Date('2026-01-01T00:00:00.000Z');

function memberFile(): string {
  return `${JSON.stringify(
    {
      enabledPlugins: { 'p-a': true },
      mcpServers: { personal: { command: 'mine' } },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] },
    },
    null,
    2,
  )}\n`;
}

const read = (path: string): string => readFileSync(path, 'utf8');

function deliverJson(alpha: string): Ledger {
  writeFileSync(settings, memberFile(), 'utf8');
  const w: PlannedWrite = {
    path: settings,
    content: '',
    resource: 'mcp:alpha',
    merge: { format: 'json', pointer: ['mcpServers'], entries: { alpha } },
  };
  const input: ApplyInput = {
    writes: [w],
    activeResources: ['mcp:alpha'],
    ledger: { version: 1, entries: [] },
    isManaged: () => true,
    now: NOW,
  };
  return applyPlan(input).ledger;
}

const ALPHA = '{"command":"npx","args":["-y","alpha"]}';

describe('auditLedger: merge 记账条目', () => {
  it('整文件哈希永远比不中（文件里还有成员条目）—— merge 条目逐键核对，健康的记为 delivered', () => {
    const ledger = deliverJson(ALPHA);
    const audit = auditLedger(ledger);
    expect(audit.delivered).toHaveLength(1);
    expect(audit.modified).toEqual([]);
    expect(audit.missing).toEqual([]);
  });

  it('成员改他自己的键（我们的条目没动）→ 仍是 delivered，绝不报"本地改过"', () => {
    const ledger = deliverJson(ALPHA);
    const edited = JSON.parse(read(settings)) as Record<string, unknown>;
    (edited.enabledPlugins as Record<string, unknown>)['p-b'] = true; // 成员装了个新插件
    writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');
    const audit = auditLedger(ledger);
    expect(audit.delivered).toHaveLength(1);
    expect(audit.modified).toEqual([]);
  });

  it('成员改我们的条目 → modified；删掉我们的条目 → 也是 modified（键取不到哈希）', () => {
    const ledger = deliverJson(ALPHA);
    const edited = JSON.parse(read(settings)) as { mcpServers: Record<string, { command: string }> };
    edited.mcpServers.alpha.command = 'member-own';
    writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');
    expect(auditLedger(ledger).modified).toHaveLength(1);

    const removed = JSON.parse(read(settings)) as { mcpServers: Record<string, unknown> };
    delete removed.mcpServers.alpha;
    writeFileSync(settings, `${JSON.stringify(removed, null, 2)}\n`, 'utf8');
    const audit = auditLedger(ledger);
    expect(audit.modified).toHaveLength(1);
    expect(audit.delivered).toEqual([]);
  });

  it('TOML merge 条目同样逐块核对：健康 delivered，异形文件认不出 → modified（保守，不炸）', () => {
    const tomlPath = join(dir, 'config.toml');
    writeFileSync(tomlPath, '# note\n[mcp_servers.member]\ncommand = "own"\n', 'utf8');
    const w: PlannedWrite = {
      path: tomlPath,
      content: '',
      resource: 'mcp:team',
      merge: { format: 'toml', pointer: ['mcp_servers'], entries: { team: '[mcp_servers.team]\ncommand = "npx"\n' } },
    };
    const ledger = applyPlan({
      writes: [w],
      activeResources: ['mcp:team'],
      ledger: { version: 1, entries: [] },
      isManaged: () => true,
      now: NOW,
    }).ledger;
    expect(auditLedger(ledger).delivered).toHaveLength(1);

    writeFileSync(tomlPath, '[[bad]]\nx = 1\n', 'utf8');
    const audit = auditLedger(ledger);
    expect(audit.modified).toHaveLength(1);
  });

  it('旧式整文件条目行为不变：内容一致 delivered、改过 modified、没了 missing', () => {
    const md = join(dir, 'SKILL.md');
    writeFileSync(md, 'body', 'utf8');
    const ghost = join(dir, 'ghost.md');
    const ledger: Ledger = {
      version: 1,
      entries: [
        { path: md, hash: 'sha256:not-it', resource: 'skills:a', deliveredAt: 't' },
        { path: ghost, hash: 'sha256:x', resource: 'skills:g', deliveredAt: 't' },
      ],
    };
    const audit = auditLedger(ledger);
    expect(audit.modified.map((e) => e.resource)).toEqual(['skills:a']);
    expect(audit.missing.map((e) => e.resource)).toEqual(['skills:g']);

    const okLedger: Ledger = {
      version: 1,
      entries: [{ path: md, hash: hashContent('body'), resource: 'skills:a', deliveredAt: 't' }],
    };
    expect(auditLedger(okLedger).delivered).toHaveLength(1);
  });

  it('managedKeys 为空对象的条目（历史遗留）走老路径，不进 merge 核对', () => {
    const md = join(dir, 'plain.md');
    writeFileSync(md, 'body', 'utf8');
    const ledger: Ledger = {
      version: 1,
      entries: [
        { path: md, hash: hashContent('body'), resource: 'skills:a', deliveredAt: 't', managedKeys: {} },
      ],
    };
    expect(auditLedger(ledger).delivered).toHaveLength(1);
  });

  it('扩展名猜错格式时双格式兜底：.toml 后缀的 JSON 文件仍判 delivered（格式在账本里没存，猜错不误报）', () => {
    // 账本（types.ts 冻结）不存 merge format，核对按扩展名猜——猜错时解析不出我方键的哈希。
    // 兜底：主格式失败用另一种格式再试，两种都失败才判 modified。
    const weird = join(dir, 'config.toml'); // .toml 后缀，但内容是 JSON 形态
    writeFileSync(weird, memberFile(), 'utf8');
    const w: PlannedWrite = {
      path: weird,
      content: '',
      resource: 'mcp:alpha',
      merge: { format: 'json', pointer: ['mcpServers'], entries: { alpha: ALPHA } },
    };
    const ledger = applyPlan({
      writes: [w],
      activeResources: ['mcp:alpha'],
      ledger: { version: 1, entries: [] },
      isManaged: () => true,
      now: NOW,
    }).ledger;
    expect(auditLedger(ledger).delivered).toHaveLength(1);
    expect(auditLedger(ledger).modified).toEqual([]);
  });
});
