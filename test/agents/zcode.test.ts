import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { zcodeAdapter } from '../../src/agents/zcode.js';
import type { HookInstallOutcome, Resource } from '../../src/core/types.js';
import { describeAdapter, ruleFixture } from './suite.js';

/** 公共六项（含「无 hookFile → installHook 降级」与 rulesMode=none 两条表驱动断言）。 */
describeAdapter(zcodeAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

/**
 * 特例：
 * - zcode 表里没有 hookFile/hookEvent —— ~/.zcode/v2/* 是 ZCode 内部应用状态
 *   （与 credentials.json 混放），无公开的用户级 JSON hook 载点，
 *   宁可不装也不能抛错中断 pull。
 * - rulesMode: 'none' —— ZCode 读的是工作区级 AGENTS.md（项目 scope），
 *   用户级没有 markdown rules 载体，规则不下发给它。
 */
describe('zcode: 无用户级 hook 落点 + rules 不下发', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-adapter-zcode-special-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installHook：不抛错，installed:false，原因非空且指向手动 ejdrone pull', () => {
    mkdirSync(join(home, '.zcode'), { recursive: true }); // 即便根目录真实存在，也无 hook 可装
    const call = (): HookInstallOutcome => zcodeAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    expect(call).not.toThrow();

    const outcome = call();
    expect(outcome.installed).toBe(false);
    expect(typeof outcome.reason).toBe('string');
    expect((outcome.reason ?? '').length).toBeGreaterThan(0);
    expect(outcome.reason).toContain('ejdrone pull');
  });

  it('uninstallHook：落点不存在时静默返回（根目录不存在 / 根目录存在都抛不出错）', () => {
    expect(() => zcodeAdapter.uninstallHook(join(home, 'no-such-home'), HOME_ENV)).not.toThrow();
    mkdirSync(join(home, '.zcode'), { recursive: true });
    expect(() => zcodeAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });

  it('rulesMode=none：planRules 对任意多条规则都返回空数组', () => {
    const second: Resource = { ...ruleFixture(), name: 'another-rule' };
    expect(zcodeAdapter.planRules([ruleFixture(), second], home, HOME_ENV)).toEqual([]);
    expect(zcodeAdapter.planRules([], home, HOME_ENV)).toEqual([]);
  });

  it('ownsPath：只管 skills 与 agents 子树，绝不管 ~\\.zcode 根或内部状态文件（v2/credentials.json）', () => {
    const root = join(home, '.zcode');
    expect(zcodeAdapter.ownsPath(root, home, HOME_ENV)).toBe(false);
    expect(zcodeAdapter.ownsPath(join(root, 'v2', 'credentials.json'), home, HOME_ENV)).toBe(false);
    expect(zcodeAdapter.ownsPath(join(root, 'skills', 'demo-skill', 'SKILL.md'), home, HOME_ENV)).toBe(true);
    expect(zcodeAdapter.ownsPath(join(root, 'agents', 'reviewer.md'), home, HOME_ENV)).toBe(true);
  });
});
