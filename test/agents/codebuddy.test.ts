import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codebuddyAdapter } from '../../src/agents/codebuddy.js';
import { HOOK_COMMAND_MARKER } from '../../src/hooks.js';
import type { Resource } from '../../src/core/types.js';
import { describeAdapter, ruleFixture } from './suite.js';

/** 公共六项（含 hookFile=settings.json + SessionStart 的幂等注入、rulesMode=none 两条表驱动断言）。 */
describeAdapter(codebuddyAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {};

/**
 * 特例点名（与公共套件同源，但这里显式钉住 codebuddy 的两个约定）：
 * - rulesMode: 'none' → planRules 空数组，不产生任何写入；
 * - hookFile: 'settings.json' → 已有用户 hooks.SessionStart 条目时只追加自己一条、
 *   幂等、用户条目原样保留。
 */
describe('codebuddy: rules 不下发 + hook 与用户条目共存', () => {
  let home: string;
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-adapter-codebuddy-special-'));
    root = join(home, '.codebuddy');
    settingsPath = join(root, 'settings.json');
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('planRules：rulesMode=none，任何规则都不产生写入', () => {
    const rules: Resource[] = [ruleFixture(), { ...ruleFixture(), name: 'another-rule' }];
    expect(codebuddyAdapter.planRules(rules, home, HOME_ENV)).toEqual([]);
  });

  it('installHook：用户 SessionStart 条目原样保留，自己只追加一条且幂等', () => {
    const userEntry = { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] };
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', hooks: { SessionStart: [userEntry] } }, null, 2),
      'utf8',
    );
    const cmd = `${HOOK_COMMAND_MARKER} node /opt/ejdrone-skills/dist/cli.js pull --silent`;

    expect(codebuddyAdapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });
    expect(codebuddyAdapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme: string;
      hooks: { SessionStart: Array<{ matcher?: string; hooks?: Array<{ command: string }> }> };
    };
    expect(settings.theme).toBe('dark');
    const list = settings.hooks.SessionStart;
    const ours = list.filter((e) => (e.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)));
    expect(ours).toHaveLength(1); // 调了两次仍只有一条
    expect(ours[0]?.matcher).toBe('*');
    expect(ours[0]?.hooks?.[0]?.command).toBe(cmd);
    expect(list[0]).toEqual(userEntry); // 用户条目原样保留（深比较）

    // uninstall 只摘自己，用户条目回到初始形状
    codebuddyAdapter.uninstallHook(home, HOME_ENV);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings;
    expect(after.hooks.SessionStart).toEqual([userEntry]);
  });
});
