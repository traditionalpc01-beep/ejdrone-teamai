import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { traeAdapter } from '../../src/agents/trae.js';
import { traeCnAdapter } from '../../src/agents/trae-cn.js';
import type { PlannedWrite } from '../../src/core/types.js';
import { RULE_NAME, describeAdapter, ruleFixture } from './suite.js';

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

describeAdapter(traeAdapter);

/**
 * trae（rootRel .trae）与 trae-cn（rootRel .trae-cn）目录名相邻。
 * ownsPath 走 under()→relative()，前缀相邻不该误判成自己管的 —— 双向各钉一条。
 */
describe('trae 与 trae-cn 边界隔离', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-trae-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('trae 不管 .trae-cn 的 rules（前缀相邻不误判）', () => {
    expect(traeAdapter.ownsPath(join(home, '.trae-cn', 'rules', 'x.md'), home, HOME_ENV)).toBe(false);
    expect(traeAdapter.ownsPath(join(home, '.trae-cn', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(false);
    expect(traeAdapter.ownsPath(join(home, '.trae', 'rules', 'x.md'), home, HOME_ENV)).toBe(true);
  });

  it('trae-cn 不管 .trae 的 rules（反向）', () => {
    expect(traeCnAdapter.ownsPath(join(home, '.trae', 'rules', 'x.md'), home, HOME_ENV)).toBe(false);
    expect(traeCnAdapter.ownsPath(join(home, '.trae', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(false);
    expect(traeCnAdapter.ownsPath(join(home, '.trae-cn', 'user_rules', 'x.md'), home, HOME_ENV)).toBe(true);
  });
});

describe('trae rulesdir 逐字节落点（真机核对：~/.trae/rules/*.md 是原生 markdown 规则目录）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-trae-rules-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('rules 原文（frontmatter 原样保留）落 <home>/.trae/rules/<name>.md', () => {
    const rule = ruleFixture();
    const writes = traeAdapter.planRules([rule], home, HOME_ENV);
    expect(writes).toHaveLength(1);
    const w = writes[0] as PlannedWrite;
    expect(w.path).toBe(join(home, '.trae', 'rules', `${RULE_NAME}.md`));
    expect(w.content).toBe(rule.files['content']);
    expect(w.content.startsWith('---\ndescription: Style guide')).toBe(true);
    expect(w.resource).toBe(`rules:${RULE_NAME}`);
    expect(w.region).toBeUndefined();
  });
});

describe('trae 无 hookFile：装不上就明说，绝不硬写', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-trae-hook-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('installHook 返回 installed:false + 非空原因；uninstallHook 静默不抛', () => {
    const r = traeAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    expect(r.installed).toBe(false);
    expect(typeof r.reason).toBe('string');
    expect((r.reason ?? '').length).toBeGreaterThan(0);
    expect(() => traeAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });
});
