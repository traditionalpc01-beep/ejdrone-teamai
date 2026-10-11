import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasHook, HookSettingsError, installedHookCommand, removeHook, upsertHook } from '../src/hooks.js';

const SPEC = { event: 'SessionStart', cmd: 'EJDRONE_HOOK=1 /node /cli.js pull --silent' };

let dir: string;
let settings: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ejdrone-hooks-'));
  settings = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('upsertHook', () => {
  it('文件不存在时创建，并把 hooks 写成 Claude 兼容形状', () => {
    upsertHook(settings, SPEC);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    const hooks = parsed.hooks as { SessionStart: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0]?.hooks[0]?.command).toBe(SPEC.cmd);
  });

  it('幂等：重复调用只留一条我们的，且别人注入的条目保持不动', () => {
    writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool.sh' }] }] } }), 'utf8');
    upsertHook(settings, SPEC);
    upsertHook(settings, SPEC);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      theme: string;
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    const commands = parsed.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands.filter((c) => c.includes('EJDRONE_HOOK'))).toHaveLength(1);
    expect(commands).toContain('other-tool.sh');
  });

  it('该事件已被写成非数组形状时拒绝覆盖，而不是丢掉别人的配置', () => {
    writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: 'managed-elsewhere' } }), 'utf8');
    expect(() => upsertHook(settings, SPEC)).toThrow(HookSettingsError);
    expect(readFileSync(settings, 'utf8')).toContain('managed-elsewhere');
  });

  it('坏 JSON 抛错且错误信息含文件路径', () => {
    writeFileSync(settings, '{ not json', 'utf8');
    expect(() => upsertHook(settings, SPEC)).toThrow(/settings\.json/);
  });
});

describe('removeHook / hasHook / installedHookCommand', () => {
  it('里面根本没有我们的条目时，不重写文件', () => {
    const original = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } });
    writeFileSync(settings, original, 'utf8');
    removeHook(settings, 'SessionStart');
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });

  it('只摘掉我们的条目，其他键与条目留下', () => {
    writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } }), 'utf8');
    upsertHook(settings, SPEC);
    expect(hasHook(settings, 'SessionStart')).toBe(true);
    expect(installedHookCommand(settings, 'SessionStart')).toBe(SPEC.cmd);

    removeHook(settings, 'SessionStart');
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      theme: string;
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(parsed.theme).toBe('dark');
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionStart[0]?.hooks[0]?.command).toBe('other.sh');
    expect(hasHook(settings, 'SessionStart')).toBe(false);
    expect(installedHookCommand(settings, 'SessionStart')).toBeNull();
  });

  it('事件全空且整个文件是我们造的 → 连文件一起删，不留孤儿', () => {
    upsertHook(settings, SPEC);
    removeHook(settings);
    expect(existsSync(settings)).toBe(false);
  });

  it('摘掉我们的条目后还剩别人的内容 → 只删我们那条，文件与别人的键都在', () => {
    const original = JSON.stringify(
      { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'someone-else.sh' }] }] } },
      null,
      2,
    );
    writeFileSync(settings, `${original}\n`, 'utf8');
    upsertHook(settings, SPEC);
    removeHook(settings, 'SessionStart');
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(parsed.theme).toBe('dark');
    const bag = parsed.hooks as Record<string, unknown>;
    expect(bag.Stop).toBeDefined();
    expect('SessionStart' in bag).toBe(false);
  });

  it('文件不存在时全部静默', () => {
    expect(existsSync(settings)).toBe(false);
    expect(hasHook(settings, 'SessionStart')).toBe(false);
    expect(installedHookCommand(settings, 'SessionStart')).toBeNull();
    expect(() => removeHook(settings, 'SessionStart')).not.toThrow();
  });
});

/**
 * 真机试验（2026-10-11 M5）暴露：卸载后 ~/.claude/settings.json 与备份差一个字节 ——
 * 原文件是 4 空格缩进、结尾无换行，而实现硬写 2 空格 + '\n'。
 * 承诺是"只动我们那一条"，那装完再卸就该逐字节回到原样。
 */
describe('格式回环', () => {
  it('4 空格缩进 + 无结尾换行：装完再卸，文件逐字节回到原样', () => {
    const original =
      '{\n    "hooks": {\n        "Stop": [\n            {\n                "hooks": [\n                    {\n                        "type": "command",\n                        "command": "someone-else.sh"\n                    }\n                ]\n            }\n        ]\n    },\n    "model": "opus"\n}';
    writeFileSync(settings, original, 'utf8');

    upsertHook(settings, SPEC);
    const installed = readFileSync(settings, 'utf8');
    expect(installed).not.toBe(original);
    expect(installed.endsWith('\n')).toBe(false);
    expect(installed).toContain('\n    "hooks": {');
    expect(installed).not.toContain('\n  "hooks"');
    expect(installed).toContain('"model": "opus"');

    removeHook(settings, 'SessionStart');
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });

  it('2 空格缩进 + 有结尾换行：同样逐字节回环', () => {
    const original = '{\n  "hooks": {\n    "Stop": []\n  }\n}\n';
    writeFileSync(settings, original, 'utf8');
    upsertHook(settings, SPEC);
    removeHook(settings, 'SessionStart');
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });

  it('摘完后文档只剩空对象 → 那是我们造出来的孤儿，删掉；有任何用户内容则绝不删', () => {
    writeFileSync(settings, '{}', 'utf8'); // 成员自己建的空 settings
    upsertHook(settings, SPEC);
    removeHook(settings, 'SessionStart');
    // 空对象不承载任何用户信息，留着只会让人问"这是谁写的"；工具下次自己会重建。
    expect(existsSync(settings)).toBe(false);

    writeFileSync(settings, '{"model":"opus"}', 'utf8');
    upsertHook(settings, SPEC);
    removeHook(settings, 'SessionStart');
    expect(existsSync(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ model: 'opus' });
  });
});
