import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findGitBash, isWindows, samePath, whichWithPathext } from '../src/platform.js';

/**
 * T10.1 的平台收口层。win32 行为全部经注入 platform/env 的纯函数路径覆盖——
 * 开发机是 macOS，没有 Windows 真机，不依赖任何真实 Windows 环境。
 */

const HOME_ENV: NodeJS.ProcessEnv = {};

// ------------------------------------------------------------------- isWindows

describe('isWindows', () => {
  it('win32 → true；darwin/linux → false', () => {
    expect(isWindows('win32')).toBe(true);
    expect(isWindows('darwin')).toBe(false);
    expect(isWindows('linux')).toBe(false);
  });
});

// ----------------------------------------------------------------- findGitBash

describe('findGitBash（Git for Windows 的 bash.exe 定位）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ejdrone-gitbash-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function plantBash(root: string): string {
    const bash = join(root, 'Git', 'bin', 'bash.exe');
    mkdirSync(join(root, 'Git', 'bin'), { recursive: true });
    writeFileSync(bash, 'MZ fake', 'utf8');
    return bash;
  }

  it('%ProgramFiles% 候选命中 → 返回 Git\\bin\\bash.exe 绝对路径', () => {
    const bash = plantBash(dir);
    expect(findGitBash({ ProgramFiles: dir }, 'win32')).toBe(bash);
  });

  it('env 键大小写不敏感：programfiles 小写同样命中', () => {
    const bash = plantBash(dir);
    expect(findGitBash({ programfiles: dir }, 'win32')).toBe(bash);
  });

  it('per-user 安装：%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe 命中（非管理员安装器默认位置）', () => {
    const bash = join(dir, 'Programs', 'Git', 'bin', 'bash.exe');
    mkdirSync(join(dir, 'Programs', 'Git', 'bin'), { recursive: true });
    writeFileSync(bash, 'MZ fake', 'utf8');
    expect(findGitBash({ LOCALAPPDATA: dir }, 'win32')).toBe(bash);
  });

  it('候选顺序：ProgramFiles 在 LOCALAPPDATA 之前命中（系统级安装优先）', () => {
    const systemBash = plantBash(dir);
    const userRoot = join(dir, 'user');
    const userBash = join(userRoot, 'Programs', 'Git', 'bin', 'bash.exe');
    mkdirSync(join(userRoot, 'Programs', 'Git', 'bin'), { recursive: true });
    writeFileSync(userBash, 'MZ fake', 'utf8');
    expect(findGitBash({ ProgramFiles: dir, LOCALAPPDATA: userRoot }, 'win32')).toBe(systemBash);
  });

  it('候选全没有、reg 也没有（macOS 上 reg 必然失败）→ null', () => {
    expect(findGitBash(HOME_ENV, 'win32')).toBeNull();
  });

  it('非 win32：无视 env 直接 null（不碰 env、不跑 reg）', () => {
    plantBash(dir);
    expect(findGitBash({ ProgramFiles: dir }, 'darwin')).toBeNull();
  });
});

// -------------------------------------------------------------- whichWithPathext

describe('whichWithPathext（win32 分支：PATHEXT 查找）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ejdrone-pathext-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("PATHEXT='.EXE;.CMD'：fake 命中 fake.exe（后缀大小写不敏感：PATHEXT 大写、文件小写）", () => {
    writeFileSync(join(dir, 'fake.exe'), 'MZ', 'utf8');
    writeFileSync(join(dir, 'fake.cmd'), '@echo off', 'utf8');
    expect(whichWithPathext('fake', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(join(dir, 'fake.exe'));
  });

  it("PATHEXT='.CMD'：只命中 fake.cmd（.exe 不在后缀表里）", () => {
    writeFileSync(join(dir, 'fake.exe'), 'MZ', 'utf8');
    writeFileSync(join(dir, 'fake.cmd'), '@echo off', 'utf8');
    expect(whichWithPathext('fake', { PATH: dir, PATHEXT: '.CMD' }, 'win32')).toBe(join(dir, 'fake.cmd'));
  });

  it('name 带不存在后缀（fake.bat）→ null', () => {
    writeFileSync(join(dir, 'fake.exe'), 'MZ', 'utf8');
    expect(whichWithPathext('fake.bat', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBeNull();
  });

  it('PATHEXT 缺省：按 .COM;.EXE;.BAT;.CMD 命中 fake.exe', () => {
    writeFileSync(join(dir, 'fake.exe'), 'MZ', 'utf8');
    expect(whichWithPathext('fake', { PATH: dir }, 'win32')).toBe(join(dir, 'fake.exe'));
  });

  it('PATHEXT 键大小写不敏感读取（pathext 小写）', () => {
    writeFileSync(join(dir, 'fake.cmd'), '@echo off', 'utf8');
    expect(whichWithPathext('fake', { PATH: dir, pathext: '.CMD' }, 'win32')).toBe(join(dir, 'fake.cmd'));
  });

  it('绝对路径直探：文件在就直接返回；裸名不在则拼 PATHEXT 后缀再试', () => {
    writeFileSync(join(dir, 'fake.exe'), 'MZ', 'utf8');
    const exe = join(dir, 'fake.exe');
    const bare = join(dir, 'fake');
    expect(whichWithPathext(exe, { PATH: dir }, 'win32')).toBe(exe);
    expect(whichWithPathext(bare, { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBe(exe);
  });

  it('目录同名不算可执行文件', () => {
    mkdirSync(join(dir, 'a-dir.exe'), { recursive: true });
    expect(whichWithPathext('a-dir', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBeNull();
  });

  it('空 name → null', () => {
    expect(whichWithPathext('', { PATH: dir }, 'win32')).toBeNull();
  });
});

describe('whichWithPathext（POSIX 退化分支：语义同 whichOn）', () => {
  let dirA: string;
  let dirB: string;
  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'ejdrone-posix-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'ejdrone-posix-b-'));
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  function makeBin(root: string, name: string, mode: number): string {
    const p = join(root, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(p, mode);
    return p;
  }

  it("PATH 用 ':' 分隔两目录：第一个目录的 X_OK 文件命中", () => {
    makeBin(dirA, 'fake-tool', 0o755);
    makeBin(dirB, 'fake-tool', 0o755);
    expect(whichWithPathext('fake-tool', { PATH: `${dirA}:${dirB}` }, 'linux')).toBe(join(dirA, 'fake-tool'));
  });

  it('第一个目录没有 → 落到第二个目录', () => {
    makeBin(dirB, 'only-b', 0o755);
    expect(whichWithPathext('only-b', { PATH: `${dirA}:${dirB}` }, 'linux')).toBe(join(dirB, 'only-b'));
  });

  it('非可执行（0o644）/ 目录同名 / 不存在 / PATH 缺席 → null', () => {
    makeBin(dirA, 'no-exec', 0o644);
    mkdirSync(join(dirA, 'a-dir'), { recursive: true });
    expect(whichWithPathext('no-exec', { PATH: dirA }, 'linux')).toBeNull();
    expect(whichWithPathext('a-dir', { PATH: dirA }, 'linux')).toBeNull();
    expect(whichWithPathext('no-such-tool-xyz', { PATH: dirA }, 'linux')).toBeNull();
    expect(whichWithPathext('no-exec', HOME_ENV, 'linux')).toBeNull();
  });

  it('不加后缀：只有 fake.exe 没有 fake 时，win32 的 PATHEXT 逻辑不生效', () => {
    writeFileSync(join(dirA, 'fake.exe'), 'MZ', 'utf8');
    chmodSync(join(dirA, 'fake.exe'), 0o755);
    expect(whichWithPathext('fake', { PATH: dirA, PATHEXT: '.EXE' }, 'linux')).toBeNull();
  });

  it("含 '/'：绝对路径直探，相对路径判不存在", () => {
    const p = makeBin(dirA, 'abs-tool', 0o755);
    expect(whichWithPathext(p, HOME_ENV, 'linux')).toBe(p);
    expect(whichWithPathext('./fake', { PATH: dirA }, 'linux')).toBeNull();
  });
});

// --------------------------------------------------------------------- samePath

describe('samePath', () => {
  it('win32：大小写不敏感 + 斜杠归一', () => {
    expect(samePath('C:\\Users\\A', 'c:/users/a', 'win32')).toBe(true);
    expect(samePath('C:\\a\\b', 'C:/a/b', 'win32')).toBe(true);
    expect(samePath('C:\\a\\b', 'C:\\a\\c', 'win32')).toBe(false);
  });

  it('posix：严格 ===', () => {
    expect(samePath('C:\\Users\\A', 'c:/users/a', 'linux')).toBe(false);
    expect(samePath('/a/b', '/a/b', 'linux')).toBe(true);
    expect(samePath('/a/b', '/a/B', 'linux')).toBe(false);
  });
});
