import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { piAdapter } from '../../src/agents/pi.js';
import type { Resource } from '../../src/core/types.js';
import { describeAdapter } from './suite.js';

// 公共六项表驱动断言（detect / planSkills / planRules / ownsPath / hook / 注册信息）。
describeAdapter(piAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

/**
 * 特例：paths.ts 全表唯一的多级 skillsSubdir（'agent/skills'）。
 * 若哪天有人把表项改回 'skills'，公共套件察觉不到中间层 .pi/agent 的归属语义，
 * 这里把「落到多级路径 + ownsPath 对中间层 false」钉死。
 */
describe('pi 特例：多级 skills 路径 agent/skills', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-pi-multi-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('planSkills 的 SKILL.md 真落到 <home>/.pi/agent/skills/<name>/SKILL.md，内容逐字节一致', () => {
    const content = '# Demo\nskill body\n';
    const skill: Resource = { kind: 'skills', namespace: '', name: 'demo-skill', files: { 'SKILL.md': content } };
    const writes = piAdapter.planSkills([skill], home, HOME_ENV);
    expect(writes).toHaveLength(1);
    const w = writes[0] as (typeof writes)[number];
    const expectedPath = join(home, '.pi', 'agent', 'skills', 'demo-skill', 'SKILL.md');
    expect(w.path).toBe(expectedPath);

    // 模拟 apply 落盘，再读回来逐字节比对（Buffer 级相等，不留行尾/编码侥幸）
    mkdirSync(join(home, '.pi', 'agent', 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(w.path, w.content, 'utf8');
    const onDisk = readFileSync(expectedPath);
    expect(Buffer.compare(onDisk, Buffer.from(content, 'utf8'))).toBe(0);
  });

  it('ownsPath：中间层 <home>/.pi/agent/ 本身不归我们管，skills 子树归', () => {
    expect(piAdapter.ownsPath(join(home, '.pi', 'agent'), home, HOME_ENV)).toBe(false);
    expect(piAdapter.ownsPath(join(home, '.pi', 'agent') + '/', home, HOME_ENV)).toBe(false);
    // common.ts 的 under() 语义：skillsRoot 本身不含（rel === ''），其下才算子树
    expect(piAdapter.ownsPath(join(home, '.pi', 'agent', 'skills'), home, HOME_ENV)).toBe(false);
    expect(piAdapter.ownsPath(join(home, '.pi', 'agent', 'skills', 'demo-skill'), home, HOME_ENV)).toBe(true);
    expect(piAdapter.ownsPath(join(home, '.pi', 'agent', 'skills', 'demo-skill', 'SKILL.md'), home, HOME_ENV)).toBe(true);
    // 根目录与同级别人的目录仍不管
    expect(piAdapter.ownsPath(join(home, '.pi'), home, HOME_ENV)).toBe(false);
    expect(piAdapter.ownsPath(join(home, '.pi', 'agent', 'other'), home, HOME_ENV)).toBe(false);
  });
});
