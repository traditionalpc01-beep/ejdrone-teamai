import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import type { PlannedWrite, Resource } from '../../src/core/types.js';
import { HOOK_COMMAND_MARKER } from '../../src/hooks.js';
import { BLOCK_END, BLOCK_START, BLOCK_RESOURCE_KEY } from '../../src/agents/block.js';
import { AGENT_IDS, adapters, registry } from '../../src/agents/index.js';
import { claudeAdapter } from '../../src/agents/claude.js';
import { qoderAdapter } from '../../src/agents/qoder-cn.js';
import { cursorAdapter } from '../../src/agents/cursor.js';
import { codexAdapter } from '../../src/agents/codex.js';
import { dshAdapter } from '../../src/agents/dsh.js';
import { rulesBlockPath, skillsRoot, TOOL_PATHS, toolRoot } from '../../src/agents/paths.js';

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

function skillFixture(): Resource {
  return {
    kind: 'skills',
    namespace: '',
    name: 'demo-skill',
    files: {
      'SKILL.md': '# Demo\nskill body\n',
      'scripts/run.sh': 'echo hello\n',
    },
  };
}

// 带 frontmatter：description + paths glob
const ruleWithFm = (): Resource => ({
  kind: 'rules',
  namespace: '',
  name: 'code-style',
  files: {
    content: '---\ndescription: Style guide\npaths:\n  - "src/**"\n---\n\n# Code Style\nBody text.\n',
  },
});

// 无 frontmatter
const rulePlain = (): Resource => ({
  kind: 'rules',
  namespace: 'fe',
  name: 'react',
  files: { content: 'no frontmatter body\nsecond line\n' },
});

function findWrite(writes: PlannedWrite[], resource: string): PlannedWrite | undefined {
  return writes.find((w) => w.resource === resource);
}

// ---- 模拟 apply 层的 region 替换（apply 属他人模块，这里仅验证本模块产出的结构可用） ----
function applyRegion(existing: string, pw: PlannedWrite): string {
  const region = pw.region;
  if (!region) throw new Error('not a block write');
  const si = existing.indexOf(region.start);
  if (si < 0) throw new Error('start marker not found');
  const ei = existing.indexOf(region.end, si + region.start.length);
  if (ei < 0) throw new Error('end marker not found');
  const before = existing.slice(0, si + region.start.length);
  const after = existing.slice(ei);
  return `${before}\n${pw.content}${after}`;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe('registry / index', () => {
  const tableIds = Object.keys(TOOL_PATHS);
  const registered = adapters.map((a) => a.id);

  it('每个已注册适配器都在 paths.ts 里有表项，且注册顺序与表顺序一致', () => {
    for (const id of registered) expect(tableIds).toContain(id);
    expect(registered).toEqual(tableIds.filter((id) => registered.includes(id)));
  });

  it('AGENT_IDS 只包含已注册的工具（paths.ts 允许有还没写适配器的表项）', () => {
    expect(AGENT_IDS).toEqual(registered);
  });

  it('registry byId unknown id returns undefined (no throw)', () => {
    const reg = registry();
    expect(reg.byId('nope')).toBeUndefined();
    expect(reg.byId('claude')?.label).toBe('Claude Code');
    expect(reg.all().map((a) => a.id)).toEqual(registered);
    expect(reg.ids()).toEqual(registered);
  });
});

describe('detect', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-detect-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('false when tool root dir is absent', () => {
    expect(claudeAdapter.detect(home, HOME_ENV)).toBe(false);
    expect(cursorAdapter.detect(home, HOME_ENV)).toBe(false);
    expect(codexAdapter.detect(home, HOME_ENV)).toBe(false);
  });

  it('true once the root dir exists', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    expect(claudeAdapter.detect(home, HOME_ENV)).toBe(true);
  });

  it('dsh honours DSH_HOME env override', () => {
    const dshHome = join(home, 'elsewhere', 'dsh-root');
    mkdirSync(dshHome, { recursive: true });
    const env: NodeJS.ProcessEnv = { DSH_HOME: dshHome };
    expect(dshAdapter.detect(home, env)).toBe(true); // 落在 DSH_HOME，而非 ~/.dsh
    expect(toolRoot('dsh', home, env)).toBe(dshHome);
    // 未设置时回落 ~/.dsh
    expect(toolRoot('dsh', home, HOME_ENV)).toBe(join(home, '.dsh'));
    expect(dshAdapter.detect(home, HOME_ENV)).toBe(false);
  });
});

describe('planSkills landing (all 5 adapters)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-skills-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const cases: Array<{ adapter: typeof claudeAdapter; rootRel: string }> = [
    { adapter: claudeAdapter, rootRel: '.claude' },
    { adapter: qoderAdapter, rootRel: '.qoder-cn' },
    { adapter: cursorAdapter, rootRel: '.cursor' },
    { adapter: codexAdapter, rootRel: '.codex' },
    { adapter: dshAdapter, rootRel: '.dsh' },
  ];

  for (const { adapter, rootRel } of cases) {
    it(`${adapter.id}: one write per file under <root>/skills/<name>/`, () => {
      const writes = adapter.planSkills([skillFixture()], home, HOME_ENV);
      const base = join(home, rootRel, 'skills', 'demo-skill');
      expect(writes).toHaveLength(2);
      const byPath = new Map(writes.map((w) => [w.path, w]));
      expect(byPath.get(join(base, 'SKILL.md'))?.content).toBe('# Demo\nskill body\n');
      expect(byPath.get(join(base, 'scripts', 'run.sh'))?.content).toBe('echo hello\n');
      for (const w of writes) {
        expect(w.resource).toBe('skills:demo-skill');
        expect(w.path.startsWith(join(home, rootRel, 'skills'))).toBe(true);
        expect(w.region).toBeUndefined();
      }
    });
  }

  it('dsh skills land under DSH_HOME/skills when env set', () => {
    const dshHome = join(home, 'custom-dsh');
    mkdirSync(dshHome, { recursive: true });
    const env: NodeJS.ProcessEnv = { DSH_HOME: dshHome };
    const writes = dshAdapter.planSkills([skillFixture()], home, env);
    expect(skillsRoot('dsh', home, env)).toBe(join(dshHome, 'skills'));
    for (const w of writes) expect(w.path.startsWith(join(dshHome, 'skills'))).toBe(true);
  });
});

describe('rulesdir mode (claude / qoder): verbatim content', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-rulesdir-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  for (const { adapter, rootRel } of [
    { adapter: claudeAdapter, rootRel: '.claude' },
    { adapter: qoderAdapter, rootRel: '.qoder-cn' },
  ]) {
    it(`${adapter.id}: rules written verbatim incl. frontmatter`, () => {
      const withFm = ruleWithFm();
      const plain = rulePlain();
      const writes = adapter.planRules([withFm, plain], home, HOME_ENV);
      expect(writes).toHaveLength(2);
      const a = findWrite(writes, 'rules:code-style');
      const b = findWrite(writes, 'rules:react');
      expect(a?.path).toBe(join(home, rootRel, 'rules', 'code-style.md'));
      // 原文逐字节保留（含 frontmatter）
      expect(a?.content).toBe(withFm.files['content']);
      expect(b?.path).toBe(join(home, rootRel, 'rules', 'react.md'));
      expect(b?.content).toBe(plain.files['content']);
      expect(a?.region).toBeUndefined();
    });
  }
});

describe('mdc mode (cursor): rewritten frontmatter, body preserved byte-for-byte', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-mdc-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('paths -> globs, alwaysApply true, body byte-identical', () => {
    const withFm = ruleWithFm();
    const writes = cursorAdapter.planRules([withFm], home, HOME_ENV);
    const w = writes[0];
    expect(w?.path).toBe(join(home, '.cursor', 'rules', 'code-style.mdc'));
    expect(w?.resource).toBe('rules:code-style');
    // 精确锁定：原 frontmatter 的 description + paths 转成 globs，正文逐字节保持
    expect(w?.content).toBe(
      '---\ndescription: "Style guide"\nglobs: src/**\nalwaysApply: true\n---\n\n# Code Style\nBody text.\n',
    );
    // 用 yaml 交叉验证 frontmatter 字段
    const fmEnd = (w?.content ?? '').indexOf('\n---\n', 4);
    const fmBlock = (w?.content ?? '').slice(4, fmEnd);
    const meta = parseYaml(fmBlock) as Record<string, unknown>;
    expect(meta['description']).toBe('Style guide');
    expect(meta['globs']).toBe('src/**');
    expect(meta['alwaysApply']).toBe(true);
    // 正文（我们生成的 frontmatter 之后）逐字节 == 原去 frontmatter 正文
    const producedBody = (w?.content ?? '').slice(fmEnd + '\n---\n'.length);
    expect(producedBody).toBe('\n# Code Style\nBody text.\n');
  });

  it('no frontmatter: description falls back to name, no globs, body unchanged', () => {
    const plain = rulePlain();
    const writes = cursorAdapter.planRules([plain], home, HOME_ENV);
    const w = writes[0];
    expect(w?.content).toBe(
      '---\ndescription: "react"\nalwaysApply: true\n---\nno frontmatter body\nsecond line\n',
    );
    expect(w?.content).not.toContain('globs:');
    expect(w?.content).toContain('alwaysApply: true');
  });

  it('description falls back to first paragraph after heading when frontmatter lacks it', () => {
    const rule: Resource = {
      kind: 'rules',
      namespace: '',
      name: 'heading-only',
      files: { content: '# Title\n\nFirst paragraph here.\n\nMore.\n' },
    };
    const w = cursorAdapter.planRules([rule], home, HOME_ENV)[0];
    const meta = parseYaml((w?.content ?? '').slice(4, (w?.content ?? '').indexOf('\n---\n', 4))) as Record<
      string,
      unknown
    >;
    expect(meta['description']).toBe('First paragraph here.');
  });
});

describe('block mode (codex / dsh): single merged region write', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-block-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  for (const { adapter, rootRel } of [
    { adapter: codexAdapter, rootRel: '.codex' },
    { adapter: dshAdapter, rootRel: '.dsh' },
  ]) {
    it(`${adapter.id}: merges rules, deterministic order, no marker text in content`, () => {
      const writes = adapter.planRules([rulePlain(), ruleWithFm()], home, HOME_ENV);
      expect(writes).toHaveLength(1);
      const w = writes[0] as PlannedWrite;
      expect(w.path).toBe(join(home, rootRel, 'AGENTS.md'));
      expect(w.resource).toBe(BLOCK_RESOURCE_KEY);
      expect(w.region).toEqual({ start: BLOCK_START, end: BLOCK_END });
      // 顺序：namespace ''(code-style) 先于 'fe'(react)
      // code-style 去 frontmatter + paths 提示行；react 原文 trim
      expect(w.content).toBe(
        'Applies to files matching: src/**\n\n# Code Style\nBody text.\n\n---\n\nno frontmatter body\nsecond line\n',
      );
      // 区块正文不含标记行本身
      expect(w.content).not.toContain(BLOCK_START);
      expect(w.content).not.toContain(BLOCK_END);
    });

    it(`${adapter.id}: empty rules => empty content (clear block, keep markers)`, () => {
      const writes = adapter.planRules([], home, HOME_ENV);
      expect(writes).toHaveLength(1);
      expect((writes[0] as PlannedWrite).content).toBe('');
      expect((writes[0] as PlannedWrite).region).toEqual({ start: BLOCK_START, end: BLOCK_END });
    });

    it(`${adapter.id}: region replace keeps user content byte-identical, replaces not appends`, () => {
      mkdirSync(join(home, rootRel), { recursive: true });
      const existing = [
        '# My personal notes',
        'Keep this line.',
        '',
        BLOCK_START,
        'STALE OLD TEAM CONTENT',
        BLOCK_END,
        '',
        'Trailing user content.',
        '',
      ].join('\n');
      writeFileSync(join(home, rootRel, 'AGENTS.md'), existing, 'utf8');

      const w = adapter.planRules([ruleWithFm()], home, HOME_ENV)[0] as PlannedWrite;
      const result = applyRegion(readFileSync(join(home, rootRel, 'AGENTS.md'), 'utf8'), w);

      // 标记外内容逐字节不变
      expect(result.startsWith('# My personal notes\nKeep this line.\n\n' + BLOCK_START)).toBe(true);
      expect(result.endsWith(BLOCK_END + '\n\nTrailing user content.\n')).toBe(true);
      // 区块被替换而非重复追加
      expect(result).not.toContain('STALE OLD TEAM CONTENT');
      expect(countOccurrences(result, BLOCK_START)).toBe(1);
      expect(countOccurrences(result, BLOCK_END)).toBe(1);
      expect(result).toContain('Applies to files matching: src/**');
    });

    it(`${adapter.id}: empty-rules write clears block interior but retains markers`, () => {
      mkdirSync(join(home, rootRel), { recursive: true });
      const existing = `prefix\n${BLOCK_START}\nOLD\n${BLOCK_END}\nsuffix\n`;
      const w = adapter.planRules([], home, HOME_ENV)[0] as PlannedWrite;
      const result = applyRegion(existing, w);
      expect(result).toContain(BLOCK_START);
      expect(result).toContain(BLOCK_END);
      expect(result).not.toContain('OLD');
      expect(countOccurrences(result, BLOCK_START)).toBe(1);
      expect(result.startsWith('prefix\n')).toBe(true);
      expect(result.endsWith('\n' + BLOCK_END + '\nsuffix\n')).toBe(true);
    });
  }
});

describe('ownsPath', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-owns-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('rulesdir adapters own skills + rules subtrees only', () => {
    expect(claudeAdapter.ownsPath(join(home, '.claude', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
    expect(claudeAdapter.ownsPath(join(home, '.claude', 'rules', 'x.md'), home, HOME_ENV)).toBe(true);
    expect(claudeAdapter.ownsPath(join(home, '.claude', 'CLAUDE.md'), home, HOME_ENV)).toBe(false);
    expect(claudeAdapter.ownsPath(join(home, '.cursor', 'rules', 'x.mdc'), home, HOME_ENV)).toBe(false);
  });

  it('block adapters: AGENTS.md is NOT owned (shared file, only manage its block)', () => {
    for (const { adapter, rootRel } of [
      { adapter: codexAdapter, rootRel: '.codex' },
      { adapter: dshAdapter, rootRel: '.dsh' },
    ]) {
      expect(adapter.ownsPath(join(home, rootRel, 'AGENTS.md'), home, HOME_ENV)).toBe(false);
      expect(adapter.ownsPath(join(home, rootRel, 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
    }
  });

  it('dsh ownsPath resolves against DSH_HOME', () => {
    const dshHome = join(home, 'env-dsh');
    const env: NodeJS.ProcessEnv = { DSH_HOME: dshHome };
    expect(dshAdapter.ownsPath(join(dshHome, 'AGENTS.md'), home, env)).toBe(false);
    expect(dshAdapter.ownsPath(join(dshHome, 'skills', 'a', 'SKILL.md'), home, env)).toBe(true);
    expect(rulesBlockPath('dsh', home, env)).toBe(join(dshHome, 'AGENTS.md'));
    expect(isAbsolute(dshHome)).toBe(true);
  });
});

describe('installHook / uninstallHook', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-hook-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installs and is idempotent; preserves user hooks and other keys', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const settingsPath = join(home, '.claude', 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            SessionStart: [{ matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const cmd = `${HOOK_COMMAND_MARKER} node /opt/ejdrone-skills/dist/cli.js pull --silent`;
    expect(claudeAdapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });
    expect(claudeAdapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme: string;
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.theme).toBe('dark'); // 其他键保持
    const list = settings.hooks.SessionStart;
    const ours = list.filter((e) => (e.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)));
    const user = list.filter((e) => (e.hooks ?? []).some((h) => h.command === 'echo mine'));
    expect(ours).toHaveLength(1); // 幂等：只有一条我们的
    expect(user).toHaveLength(1); // 用户自己的保留
  });

  it('bad JSON settings => installed:false, no throw', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not valid json', 'utf8');
    let outcome = { installed: true };
    expect(() => {
      outcome = claudeAdapter.installHook(home, HOME_ENV, 'ejdrone pull');
    }).not.toThrow();
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toContain(join(home, '.claude', 'settings.json')); // 错误信息含路径
  });

  it('cursor: any hook failure degrades to installed:false, never throws', () => {
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'hooks.json'), '[]', 'utf8'); // 非对象 => HookSettingsError
    let outcome = { installed: true };
    expect(() => {
      outcome = cursorAdapter.installHook(home, HOME_ENV, 'ejdrone pull');
    }).not.toThrow();
    expect(outcome.installed).toBe(false);
    expect(typeof outcome.reason).toBe('string');
  });

  it('uninstall removes only our entry; missing file is a silent no-op', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const settingsPath = join(home, '.codex', 'hooks.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ matcher: 'user', hooks: [{ type: 'command', command: 'keep me' }] }] } },
        null,
        2,
      ),
      'utf8',
    );
    codexAdapter.installHook(home, HOME_ENV, `${HOOK_COMMAND_MARKER} node /opt/ejdrone-skills/dist/cli.js pull --silent`);
    codexAdapter.uninstallHook(home, HOME_ENV);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const list = after.hooks.SessionStart;
    expect(list.some((e) => (e.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)))).toBe(false);
    expect(list.some((e) => (e.hooks ?? []).some((h) => h.command === 'keep me'))).toBe(true);

    // 文件不存在静默返回
    expect(() => codexAdapter.uninstallHook(join(home, 'missing'), HOME_ENV)).not.toThrow();
  });
});
