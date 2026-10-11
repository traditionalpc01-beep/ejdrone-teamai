import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { copilotAdapter } from '../../src/agents/copilot.js';
import { describeAdapter, SKILL_NAME, skillFixture } from './suite.js';

/** 公共六项（id/label、detect、planSkills、planRules block、ownsPath、无 hook 降级）。 */
describeAdapter(copilotAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {};

/**
 * 特例：根目录受 COPILOT_HOME 覆盖，且只接受绝对路径。
 * 相对值若被接受，投递会落到 <cwd>/relative-copilot —— GUI 启动的 agent 的
 * cwd 不可预测，那会写出孤儿文件（同 DSH_HOME 的取舍，见设计文档 §14）。
 */
describe('copilot: COPILOT_HOME 覆盖（只认绝对路径）', () => {
  let home: string;
  let copilotHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-copilot-home-'));
    copilotHome = mkdtempSync(join(tmpdir(), 'ejdrone-copilot-override-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(copilotHome, { recursive: true, force: true });
  });

  it('绝对 COPILOT_HOME：detect 与 skills 落点都在该目录，忽略 <home>/.copilot', () => {
    // <home>/.copilot 不存在：无覆盖时 detect 应为 false
    expect(copilotAdapter.detect(home, HOME_ENV)).toBe(false);
    // 设了绝对覆盖：detect 看的是覆盖目录
    const env = { COPILOT_HOME: copilotHome };
    expect(copilotAdapter.detect(home, env)).toBe(true);

    const writes = copilotAdapter.planSkills([skillFixture()], home, env);
    expect(writes).toHaveLength(2);
    const paths = writes.map((w) => w.path);
    expect(paths).toContain(join(copilotHome, 'skills', SKILL_NAME, 'SKILL.md'));
    expect(paths).toContain(join(copilotHome, 'skills', SKILL_NAME, 'scripts', 'run.sh'));
    for (const w of writes) {
      expect(w.path.startsWith(join(copilotHome, 'skills'))).toBe(true);
      expect(w.path.startsWith(join(home, '.copilot'))).toBe(false);
    }
  });

  it('相对 COPILOT_HOME：回落到 <home>/.copilot，绝不落到 <cwd>/relative-copilot', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    const env = { COPILOT_HOME: 'relative-copilot' };

    // detect 也走回落：看的是 <home>/.copilot 是否存在
    expect(copilotAdapter.detect(home, env)).toBe(true);
    expect(copilotAdapter.detect(join(home, 'elsewhere'), env)).toBe(false);

    const writes = copilotAdapter.planSkills([skillFixture()], home, env);
    const cwdOverride = resolve('relative-copilot'); // <cwd>/relative-copilot 的绝对形状
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.path.startsWith(join(home, '.copilot', 'skills'))).toBe(true);
      expect(w.path).not.toContain(cwdOverride);
      expect(w.path).not.toContain('relative-copilot');
    }
    expect(writes.map((w) => w.path)).toContain(join(home, '.copilot', 'skills', SKILL_NAME, 'SKILL.md'));
  });

  it('纯空白 COPILOT_HOME 同样回落（trim 后为空不构成覆盖）', () => {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    const writes = copilotAdapter.planSkills([skillFixture()], home, { COPILOT_HOME: '   ' });
    expect(writes.map((w) => w.path)).toContain(join(home, '.copilot', 'skills', SKILL_NAME, 'SKILL.md'));
  });
});
