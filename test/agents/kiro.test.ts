import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { kiroAdapter } from '../../src/agents/kiro.js';
import type { HookInstallOutcome, Resource } from '../../src/core/types.js';
import { describeAdapter, ruleFixture } from './suite.js';

/** 公共六项（含「无 hookFile → installHook 降级」与 rulesMode=none 两条表驱动断言）。 */
describeAdapter(kiroAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {};

/**
 * 特例：
 * - kiro 表里没有 hookFile/hookEvent —— Kiro 的 SessionStart 由 agent 同步内嵌
 *   （hooks.agentSpawn），不存在用户级 JSON 落点，宁可不装也不能抛错中断 pull。
 * - rulesMode: 'none' —— 规则不下发给它。
 */
describe('kiro: 无用户级 hook 落点 + rules 不下发', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-adapter-kiro-special-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installHook：不抛错，installed:false，原因非空且指向手动 ejdrone pull', () => {
    mkdirSync(join(home, '.kiro'), { recursive: true }); // 即便根目录真实存在，也无 hook 可装
    const call = (): HookInstallOutcome => kiroAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    expect(call).not.toThrow();

    const outcome = call();
    expect(outcome.installed).toBe(false);
    expect(typeof outcome.reason).toBe('string');
    expect((outcome.reason ?? '').length).toBeGreaterThan(0);
    expect(outcome.reason).toContain('ejdrone pull');
  });

  it('uninstallHook：落点不存在时静默返回（根目录不存在 / 根目录存在但无 settings 文件都不抛错）', () => {
    expect(() => kiroAdapter.uninstallHook(join(home, 'no-such-home'), HOME_ENV)).not.toThrow();
    mkdirSync(join(home, '.kiro'), { recursive: true });
    expect(() => kiroAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });

  it('rulesMode=none：planRules 对任意多条规则都返回空数组', () => {
    const second: Resource = { ...ruleFixture(), name: 'another-rule' };
    expect(kiroAdapter.planRules([ruleFixture(), second], home, HOME_ENV)).toEqual([]);
    expect(kiroAdapter.planRules([], home, HOME_ENV)).toEqual([]);
  });
});
