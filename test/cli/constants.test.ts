import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hookCommand, parseHookBash, parseHookPaths } from '../../src/cli/constants.js';
import { expectedHookCommand } from '../integration/helpers.js';

/**
 * T10.2 的 hook 命令形态钉子。win32 行为全部经注入 platform / env 覆盖——
 * 开发机是 macOS，没有 Windows 真机。
 *
 * 引号形状是跨模块契约，改形前先读 constants.ts 顶部注释：
 * 内层单引号服务 hooks.ts 的 marker 识别、parseHookPaths 提取、doctor 路径核对；
 * 外层双引号是对计划文本的有意偏差（Git 路径常含空格，cmd.exe 不认单引号包裹）。
 */

const HOME_ENV: NodeJS.ProcessEnv = {};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ejdrone-hookcmd-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 在伪造的 ProgramFiles 下种一个 bash.exe，返回它的绝对路径（macOS 上 join 产出 POSIX 斜杠）。 */
function plantBash(root: string): string {
  const bash = join(root, 'Git', 'bin', 'bash.exe');
  mkdirSync(join(root, 'Git', 'bin'), { recursive: true });
  writeFileSync(bash, 'MZ fake', 'utf8');
  return bash;
}

/** 临时把 process.platform 换成 value，跑完还原（expectedHookCommand 只读当前平台，没留注入口）。 */
function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

// ------------------------------------------------------- hookCommand：POSIX 分支

describe('hookCommand：POSIX 形态（行为零变化）', () => {
  const env: NodeJS.ProcessEnv = { EJDRONE_NODE: '/n', EJDRONE_CLI: '/c.js' };
  const posix = `EJDRONE_HOOK=1 '/n' '/c.js' pull --silent`;

  it("darwin：精确等于 EJDRONE_HOOK=1 '/n' '/c.js' pull --silent", () => {
    expect(hookCommand(env, 'darwin')).toBe(posix);
  });

  it('linux 同样走 POSIX 分支', () => {
    expect(hookCommand(env, 'linux')).toBe(posix);
  });

  it('不传 platform（默认 process.platform，真机 macOS 即 POSIX 分支）：形状不变', () => {
    // 真 Windows 上这一条要按 win32 形态重验——已登记为遗留项（无真机）
    expect(hookCommand(env)).toBe(posix);
  });
});

// ------------------------------------------------------- hookCommand：win32 分支

describe('hookCommand：win32 形态（外层双引号 bash -lc，内层单引号不变）', () => {
  const env: NodeJS.ProcessEnv = { EJDRONE_NODE: 'C:\\node.exe', EJDRONE_CLI: 'C:\\cli.js' };

  it('ProgramFiles 命中 → "<bash>" -lc "EJDRONE_HOOK=1 \'C:\\node.exe\' \'C:\\cli.js\' pull --silent"', () => {
    const bash = plantBash(dir);
    expect(hookCommand({ ...env, ProgramFiles: dir }, 'win32')).toBe(
      `"${bash}" -lc "EJDRONE_HOOK=1 'C:\\node.exe' 'C:\\cli.js' pull --silent"`,
    );
  });

  it('env 键大小写不敏感：programfiles 小写同样命中', () => {
    const bash = plantBash(dir);
    expect(hookCommand({ ...env, programfiles: dir }, 'win32')).toBe(
      `"${bash}" -lc "EJDRONE_HOOK=1 'C:\\node.exe' 'C:\\cli.js' pull --silent"`,
    );
  });

  it('win32 但找不到 Git Bash（空 env，reg 在 macOS 上必然失败）→ null', () => {
    expect(hookCommand(HOME_ENV, 'win32')).toBeNull();
  });
});

// ------------------------------------------------------------------ parseHookBash

describe('parseHookBash（doctor 的 win:hookbash 检查用）', () => {
  it('win32 形态 → bash 路径（含空格的 Program Files 路径原样取回）', () => {
    const cmd = `"C:\\Program Files\\Git\\bin\\bash.exe" -lc "EJDRONE_HOOK=1 'C:\\node.exe' 'C:\\cli.js' pull --silent"`;
    expect(parseHookBash(cmd)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('后缀大小写不敏感：BASH.EXE 也认', () => {
    expect(parseHookBash('"C:\\Git\\BASH.EXE" -lc "EJDRONE_HOOK=1 pull --silent"')).toBe('C:\\Git\\BASH.EXE');
  });

  it('POSIX 形态（没有双引号段）→ null', () => {
    expect(parseHookBash(`EJDRONE_HOOK=1 '/n' '/c.js' pull --silent`)).toBeNull();
  });

  it('命令里一个双引号都没有 → null', () => {
    expect(parseHookBash('EJDRONE_HOOK=1 /n /c.js pull --silent')).toBeNull();
  });

  it('双引号段不是 bash.exe（cmd.exe 一类 wrapper）→ null', () => {
    expect(parseHookBash('"C:\\Windows\\System32\\cmd.exe" /c "EJDRONE_HOOK=1 pull --silent"')).toBeNull();
  });
});

// -------------------------------------------------- parseHookPaths：win32 回归保护

describe('parseHookPaths：win32 形态仍取到 node/cli', () => {
  it('外层双引号不干扰内层单引号提取（回归保护：内层引号形状不许动）', () => {
    const cmd = `"C:\\Program Files\\Git\\bin\\bash.exe" -lc "EJDRONE_HOOK=1 'C:\\node.exe' 'C:\\cli.js' pull --silent"`;
    expect(parseHookPaths(cmd)).toEqual({ node: 'C:\\node.exe', cli: 'C:\\cli.js' });
  });
});

// ------------------------------------------------------------- expectedHookCommand

describe('expectedHookCommand（helpers.ts：按当前平台推导期望命令）', () => {
  it('POSIX 形状', () => {
    expect(expectedHookCommand({ EJDRONE_NODE: '/n', EJDRONE_CLI: '/c.js' })).toBe(
      `EJDRONE_HOOK=1 '/n' '/c.js' pull --silent`,
    );
  });

  it('win32 无 Git Bash → null（那种机器上 init 不装 hook，只打印指引）', () => {
    expect(withPlatform('win32', () => expectedHookCommand(HOME_ENV))).toBeNull();
  });

  it('win32 有 Git Bash → 与 hookCommand(env, "win32") 逐字节一致', () => {
    const bash = plantBash(dir);
    const env: NodeJS.ProcessEnv = { EJDRONE_NODE: 'C:\\node.exe', EJDRONE_CLI: 'C:\\cli.js', ProgramFiles: dir };
    const expected = withPlatform('win32', () => expectedHookCommand(env));
    expect(expected).toBe(hookCommand(env, 'win32'));
    expect(expected).toBe(`"${bash}" -lc "EJDRONE_HOOK=1 'C:\\node.exe' 'C:\\cli.js' pull --silent"`);
  });
});
