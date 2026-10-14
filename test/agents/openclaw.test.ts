import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openclawAdapter } from '../../src/agents/openclaw.js';
import type { Resource } from '../../src/core/types.js';
import { describeAdapter } from './suite.js';

// 公共六项表驱动断言。
describeAdapter(openclawAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

const ruleFixture: Resource = {
  kind: 'rules',
  namespace: '',
  name: 'code-style',
  files: { content: '---\ndescription: Style guide\npaths:\n  - "src/**"\n---\n\n# Code Style\nBody.\n' },
};

/**
 * 特例：OpenClaw 的 hook 是 workspace 级、还要在 openclaw.json 里启用条目，
 * 与本项目「只有 user scope」的前提冲突，故表里没给 hookFile（见 paths.ts 注释）。
 * 装不了就明说，并把「手动 ejdrone pull」的出路写进 reason。
 * rulesMode 'none'：没有可写的 markdown rules 载体，planRules 必须返回空数组。
 */
describe('openclaw 特例：无 hook 落点 + rules none', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-openclaw-none-'));
    mkdirSync(join(home, '.openclaw', 'skills'), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installHook：installed:false，reason 提到手动 ejdrone pull，且不抛错', () => {
    let outcome = { installed: true, reason: '' };
    expect(() => {
      const r = openclawAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
      outcome = { installed: r.installed, reason: r.reason ?? '' };
    }).not.toThrow();
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toContain('ejdrone pull');
    expect(() => openclawAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });

  it('rulesMode none：planRules 返回空数组（规则不下发给它）', () => {
    expect(openclawAdapter.planRules([ruleFixture], home, HOME_ENV)).toEqual([]);
    expect(openclawAdapter.planRules([], home, HOME_ENV)).toEqual([]);
  });
});
