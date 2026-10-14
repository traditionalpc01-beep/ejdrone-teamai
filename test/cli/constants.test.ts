import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hookCommand, isDegradedHookCommand, parseHookBash, parseHookPaths, parseHookWrapper, win32Hook } from '../../src/cli/constants.js';
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

  it.skipIf(process.platform === 'win32')('不传 platform（默认 process.platform）：POSIX 主机上形状不变', () => {
    // Windows 真机上默认值就是 win32，那条形状由下面的 wrapper 用例负责
    expect(hookCommand(env)).toBe(posix);
  });
});

// ------------------------------------------------------- hookCommand：win32 分支

describe('hookCommand：win32 形态（命令指向 wrapper，payload 在文件里）', () => {
  // 状态目录用 EJDRONE_HOME 固定在无空格的临时目录里，钩住「裸正斜杠路径」那条主分支
  const env: NodeJS.ProcessEnv = { EJDRONE_NODE: 'C:\\node.exe', EJDRONE_CLI: 'C:\\cli.js' };
  const payload = `EJDRONE_HOOK=1 'C:\\node.exe' 'C:\\cli.js' pull --silent`;

  /** 注入一个「注册表里没有 Git」的读取器：真 Windows 上 reg 会命中本机安装，不能靠它制造缺失。 */
  const noRegistry = () => null;

  it('ProgramFiles 命中 → 命令是 <wrapper 正斜杠裸路径> EJDRONE_HOOK=1，不含任何引号', () => {
    const bash = plantBash(dir);
    const home = join(dir, 'state');
    const got = hookCommand({ ...env, ProgramFiles: dir, EJDRONE_HOME: home }, 'win32', noRegistry);
    expect(got).toBe(`${join(home, 'hooks', 'session-start.cmd').split('\\').join('/')} EJDRONE_HOOK=1`);
  });

  it('wrapper 正文保住内层单引号与原外层双引号形状', () => {
    const bash = plantBash(dir);
    const home = join(dir, 'state');
    const win = win32Hook({ ...env, ProgramFiles: dir, EJDRONE_HOME: home }, 'win32', noRegistry);
    expect(win?.wrapperBody).toBe(`@echo off\r\n"${bash}" -lc "${payload}"\r\n`);
    expect(win?.degraded).toBe(false);
  });

  it('env 键大小写不敏感：programfiles 小写同样命中', () => {
    const bash = plantBash(dir);
    const home = join(dir, 'state');
    const got = hookCommand({ ...env, programfiles: dir, EJDRONE_HOME: home }, 'win32', noRegistry);
    expect(got).toContain('session-start.cmd EJDRONE_HOOK=1');
  });

  it('win32 但找不到 Git Bash（候选全没有 + 注册表也没有）→ null', () => {
    expect(hookCommand(HOME_ENV, 'win32', noRegistry)).toBeNull();
    expect(win32Hook(HOME_ENV, 'win32', noRegistry)).toBeNull();
  });

  it('状态目录含空格 → 退到 cmd.exe /c 包装形态并标 degraded（Git Bash 那一路会断，由 doctor 点名）', () => {
    const bash = plantBash(dir);
    const home = join(dir, 'a space');
    const win = win32Hook({ ...env, ProgramFiles: dir, EJDRONE_HOME: home }, 'win32', noRegistry);
    expect(win?.degraded).toBe(true);
    expect(win?.command).toBe(`cmd.exe /c "${join(home, 'hooks', 'session-start.cmd').split('\\').join('/')}" EJDRONE_HOOK=1`);
  });
});

// ------------------------------------------------- parseHookWrapper / degraded 识别

describe('parseHookWrapper（doctor 靠它把 payload 读出来）', () => {
  it('裸正斜杠形态 → wrapper 路径', () => {
    expect(parseHookWrapper('C:/Users/ej/.ejdrone/hooks/session-start.cmd EJDRONE_HOOK=1')).toBe(
      'C:/Users/ej/.ejdrone/hooks/session-start.cmd',
    );
  });

  it('cmd.exe /c 包装形态 → 取双引号段', () => {
    expect(parseHookWrapper('cmd.exe /c "C:/Users/John Smith/.ejdrone/hooks/session-start.cmd" EJDRONE_HOOK=1')).toBe(
      'C:/Users/John Smith/.ejdrone/hooks/session-start.cmd',
    );
  });

  it('POSIX 形态没有 wrapper → null（payload 就是命令本身）', () => {
    expect(parseHookWrapper(`EJDRONE_HOOK=1 '/n' '/c.js' pull --silent`)).toBeNull();
  });

  it('isDegradedHookCommand 只认 cmd.exe /c 包装形态', () => {
    expect(isDegradedHookCommand('cmd.exe /c "C:/a b/x.cmd" EJDRONE_HOOK=1')).toBe(true);
    expect(isDegradedHookCommand('C:/a/x.cmd EJDRONE_HOOK=1')).toBe(false);
    expect(isDegradedHookCommand(`EJDRONE_HOOK=1 '/n' '/c.js' pull --silent`)).toBe(false);
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
  it.skipIf(process.platform === 'win32')('POSIX 形状', () => {
    expect(expectedHookCommand({ EJDRONE_NODE: '/n', EJDRONE_CLI: '/c.js' })).toBe(
      `EJDRONE_HOOK=1 '/n' '/c.js' pull --silent`,
    );
  });

  it('win32：与 hookCommand(env, "win32") 逐字节一致（形态只有一份来源，测试不再复刻）', () => {
    const bash = plantBash(dir);
    const home = join(dir, 'state');
    const env: NodeJS.ProcessEnv = { EJDRONE_NODE: 'C:\\node.exe', EJDRONE_CLI: 'C:\\cli.js', ProgramFiles: dir, EJDRONE_HOME: home };
    const expected = withPlatform('win32', () => expectedHookCommand(env));
    expect(expected).toBe(hookCommand(env, 'win32'));
    expect(expected).toContain('session-start.cmd EJDRONE_HOOK=1');
  });
});
