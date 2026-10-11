import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { qoderIntlAdapter } from '../../src/agents/qoder.js';
import { qoderAdapter } from '../../src/agents/qoder-cn.js';
import { HOOK_COMMAND_MARKER } from '../../src/hooks.js';
import type { PlannedWrite } from '../../src/core/types.js';
import { RULE_NAME, SKILL_NAME, describeAdapter, ruleFixture, skillFixture } from './suite.js';

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

describeAdapter(qoderIntlAdapter);

/**
 * qoder（国际版，rootRel .qoder）与 qoder-cn（rootRel .qoder-cn）是两个独立工具。
 * 目录名只差一个后缀，under() 按 relative 判断本不会误判，但这两条是本轮最容易出的
 * 越界事故（把国际版的账记到 CN 头上 / 反之），必须各测各向钉死。
 */
describe('qoder 与 qoder-cn 边界隔离', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-qoder-intl-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('qoder 管 .qoder，绝不管 .qoder-cn', () => {
    expect(qoderIntlAdapter.ownsPath(join(home, '.qoder', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
    expect(qoderIntlAdapter.ownsPath(join(home, '.qoder-cn', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(false);
    expect(qoderIntlAdapter.ownsPath(join(home, '.qoder-cn', 'rules', 'x.md'), home, HOME_ENV)).toBe(false);
  });

  it('qoder-cn 管 .qoder-cn，绝不管 .qoder（反向）', () => {
    expect(qoderAdapter.ownsPath(join(home, '.qoder-cn', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
    expect(qoderAdapter.ownsPath(join(home, '.qoder', 'skills', 'a', 'SKILL.md'), home, HOME_ENV)).toBe(false);
    expect(qoderAdapter.ownsPath(join(home, '.qoder', 'rules', 'x.md'), home, HOME_ENV)).toBe(false);
  });

  it('落点与 detect 互不串门：skills 各写各目录，只建一边则另一边 detect=false', () => {
    const intl = qoderIntlAdapter.planSkills([skillFixture()], home, HOME_ENV);
    const cn = qoderAdapter.planSkills([skillFixture()], home, HOME_ENV);
    for (const w of intl) expect(w.path.startsWith(join(home, '.qoder', 'skills', SKILL_NAME))).toBe(true);
    for (const w of cn) expect(w.path.startsWith(join(home, '.qoder-cn', 'skills', SKILL_NAME))).toBe(true);
    expect(intl.some((w) => w.path.startsWith(join(home, '.qoder-cn')))).toBe(false);

    mkdirSync(join(home, '.qoder-cn'), { recursive: true });
    expect(qoderIntlAdapter.detect(home, HOME_ENV)).toBe(false);
    expect(qoderAdapter.detect(home, HOME_ENV)).toBe(true);
  });
});

describe('qoder rulesdir 逐字节落点', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-qoder-rules-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('rules 原文（frontmatter 原样保留）落 <home>/.qoder/rules/<name>.md', () => {
    const rule = ruleFixture();
    const writes = qoderIntlAdapter.planRules([rule], home, HOME_ENV);
    expect(writes).toHaveLength(1);
    const w = writes[0] as PlannedWrite;
    expect(w.path).toBe(join(home, '.qoder', 'rules', `${RULE_NAME}.md`));
    expect(w.content).toBe(rule.files['content']);
    expect(w.content.startsWith('---\ndescription: Style guide')).toBe(true);
    expect(w.resource).toBe(`rules:${RULE_NAME}`);
    expect(w.region).toBeUndefined();
  });
});

describe('qoder installHook（<home>/.qoder/settings.json，Claude 兼容形 SessionStart）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-qoder-hook-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('已有用户 hooks.SessionStart 条目时只追加自己一条、幂等，theme 等其他键原样保留', () => {
    mkdirSync(join(home, '.qoder'), { recursive: true });
    const settingsPath = join(home, '.qoder', 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: 'dark',
          model: 'qoder-pro',
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
    expect(qoderIntlAdapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });
    expect(qoderIntlAdapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true }); // 幂等

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme: string;
      model: string;
      hooks: { SessionStart: Array<{ matcher?: string; hooks?: Array<{ command: string }> }> };
    };
    expect(settings.theme).toBe('dark'); // 其他键原样保留
    expect(settings.model).toBe('qoder-pro');
    const list = settings.hooks.SessionStart;
    const ours = list.filter((e) => (e.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)));
    const user = list.filter((e) => (e.hooks ?? []).some((h) => h.command === 'echo mine'));
    expect(ours).toHaveLength(1); // 两次 install 只留一条
    expect(user).toHaveLength(1); // 用户条目没被动
    expect(ours[0]?.matcher).toBe('*');
    expect(ours[0]?.hooks?.[0]?.command).toBe(cmd);
  });
});
