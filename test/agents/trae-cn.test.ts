import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { traeAdapter } from '../../src/agents/trae.js';
import { traeCnAdapter } from '../../src/agents/trae-cn.js';
import type { PlannedWrite } from '../../src/core/types.js';
import { RULE_NAME, describeAdapter, ruleFixture } from './suite.js';

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

describeAdapter(traeCnAdapter);

describe('trae-cn 与 trae 边界隔离', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-trae-cn-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('trae-cn 管 .trae-cn，绝不管 .trae（前缀相邻不误判）', () => {
    expect(traeCnAdapter.ownsPath(join(home, '.trae', 'rules', 'x.md'), home, HOME_ENV)).toBe(false);
    expect(traeCnAdapter.ownsPath(join(home, '.trae', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(false);
    expect(traeCnAdapter.ownsPath(join(home, '.trae-cn', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
  });

  it('trae 不管 .trae-cn（反向）', () => {
    expect(traeAdapter.ownsPath(join(home, '.trae-cn', 'user_rules', 'x.md'), home, HOME_ENV)).toBe(false);
    expect(traeAdapter.ownsPath(join(home, '.trae-cn', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(false);
  });
});

describe('trae-cn rulesdir 落点（表里 rulesSubdir=user_rules，真机该目录存在但内容级未证）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-trae-cn-rules-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('rules 原文落 <home>/.trae-cn/user_rules/<name>.md，frontmatter 逐字节保留', () => {
    const rule = ruleFixture();
    const writes = traeCnAdapter.planRules([rule], home, HOME_ENV);
    expect(writes).toHaveLength(1);
    const w = writes[0] as PlannedWrite;
    expect(w.path).toBe(join(home, '.trae-cn', 'user_rules', `${RULE_NAME}.md`));
    expect(w.content).toBe(rule.files['content']);
    expect(w.content.startsWith('---\ndescription: Style guide')).toBe(true);
    expect(w.resource).toBe(`rules:${RULE_NAME}`);
    expect(w.region).toBeUndefined();
  });

  it('不经 user_rules 的 .trae/rules 路径与它无关：planRules 从不写 .trae 目录', () => {
    const writes = traeCnAdapter.planRules([ruleFixture()], home, HOME_ENV);
    for (const w of writes) expect(w.path.startsWith(join(home, '.trae', 'rules'))).toBe(false);
  });
});

describe('trae-cn 无 hookFile：装不上就明说，绝不硬写', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-trae-cn-hook-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installHook 返回 installed:false + 非空原因；uninstallHook 静默不抛', () => {
    const r = traeCnAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    expect(r.installed).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect((r.reason ?? '').length).toBeGreaterThan(0);
    expect(() => traeCnAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });
});
