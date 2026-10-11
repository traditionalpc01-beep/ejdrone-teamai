import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLOCK_END, BLOCK_START, BLOCK_RESOURCE_KEY } from '../../src/agents/block.js';
import { opencodeAdapter } from '../../src/agents/opencode.js';
import type { PlannedWrite, Resource } from '../../src/core/types.js';
import { describeAdapter } from './suite.js';

// 公共六项表驱动断言。
describeAdapter(opencodeAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

const ruleFixture: Resource = {
  kind: 'rules',
  namespace: '',
  name: 'code-style',
  files: { content: '---\ndescription: Style guide\npaths:\n  - "src/**"\n---\n\n# Code Style\nBody.\n' },
};

/**
 * 特例 1：rootRel '.config/opencode' 是全表少见的多级根目录 ——
 * detect 必须整条链都建出来才算已安装，只建 ~/.config 不算。
 */
describe('opencode 特例：多级根目录 .config/opencode', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-opencode-root-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('只建 <home>/.config 时 detect 仍为 false，整条链建齐才为 true', () => {
    expect(opencodeAdapter.detect(home, HOME_ENV)).toBe(false);
    mkdirSync(join(home, '.config'), { recursive: true });
    expect(opencodeAdapter.detect(home, HOME_ENV)).toBe(false);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    expect(opencodeAdapter.detect(home, HOME_ENV)).toBe(true);
  });
});

/**
 * 特例 2：rulesMode 'block' —— rules 写进多级根目录下的 AGENTS.md 区块，
 * 且那个文件是用户共享文件，适配器绝不能 own 它（只管标记区块内内容）。
 * 特例 3：表里没给 hookFile —— installHook 降级为 installed:false，不抛错。
 */
describe('opencode 特例：block 模式落点与无 hook', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-opencode-block-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('planRules 落到 <home>/.config/opencode/AGENTS.md，带 region 标记，resource 用 block.ts 的导出常量', () => {
    const writes = opencodeAdapter.planRules([ruleFixture], home, HOME_ENV);
    expect(writes).toHaveLength(1);
    const w = writes[0] as PlannedWrite;
    expect(w.path).toBe(join(home, '.config', 'opencode', 'AGENTS.md'));
    expect(w.resource).toBe(BLOCK_RESOURCE_KEY); // 不手写字符串，防止和 block.ts 漂移
    expect(w.region).toEqual({ start: BLOCK_START, end: BLOCK_END });
    expect(w.content).toContain('# Code Style');
  });

  it('ownsPath 对那个 AGENTS.md 返回 false（共享文件，只区块内可动）', () => {
    const agentsMd = join(home, '.config', 'opencode', 'AGENTS.md');
    expect(opencodeAdapter.ownsPath(agentsMd, home, HOME_ENV)).toBe(false);
    // 但自己的 skills 子树照管
    expect(opencodeAdapter.ownsPath(join(home, '.config', 'opencode', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
  });

  it('表里没有 hookFile：installHook 返回 installed:false 且不抛错', () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    let outcome = { installed: true };
    expect(() => {
      outcome = opencodeAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    }).not.toThrow();
    expect(outcome.installed).toBe(false);
    expect(() => opencodeAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });
});
