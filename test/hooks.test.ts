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

  it('事件全空时把 hooks 键整个删掉，不留空壳', () => {
    upsertHook(settings, SPEC);
    removeHook(settings);
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect('hooks' in parsed).toBe(false);
  });

  it('文件不存在时全部静默', () => {
    expect(existsSync(settings)).toBe(false);
    expect(hasHook(settings, 'SessionStart')).toBe(false);
    expect(installedHookCommand(settings, 'SessionStart')).toBeNull();
    expect(() => removeHook(settings, 'SessionStart')).not.toThrow();
  });
});
