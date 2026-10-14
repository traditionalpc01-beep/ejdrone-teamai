import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { doctorCommand } from '../../src/cli/doctor.js';
import { createContext } from '../../src/cli/context.js';
import type { Config } from '../../src/core/types.js';
import { hookWrapperPath, saveConfig } from '../../src/state.js';
import { findGitBash } from '../../src/platform.js';

/**
 * M10 / T10.5：doctor 的 Windows 三项检查（win:gitbash / win:git / win:hookbash）。
 *
 * 开发机是 macOS，没有 Windows 真机：win32 行为全部靠 doctorCommand 的第三个参数
 * 注入 platform 覆盖；darwin 用例钉住「一条 win: 检查都不出现」的硬约束
 * （POSIX 下 --json 输出必须与改动前逐字节一致）。
 */

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-doctor-win-'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

interface DoctorCheck {
  id: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  hint?: string;
}

interface DoctorReport {
  ok: boolean;
  summary: { pass: number; warn: number; fail: number };
  checks: DoctorCheck[];
  notes: string[];
}

/** 造一套隔离的 HOME + EJDRONE_HOME；overrides 控制 ProgramFiles / PATH 等平台变量。 */
function makeEnv(tag: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = join(root, `home-${tag}`);
  const state = join(root, `state-${tag}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  return {
    HOME: home,
    EJDRONE_HOME: state,
    // 克隆必然失败的本地路径时绝不卡在凭据提示上
    GIT_TERMINAL_PROMPT: '0',
    ...overrides,
  };
}

async function runDoctor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  /** 注入 win:gitbash 的定位结果：真 Windows 上 reg 会命中本机 Git，不能靠主机环境制造「没装」 */
  gitBash: string | null = findGitBash(env, platform),
): Promise<{ code: number; report: DoctorReport }> {
  const lines: string[] = [];
  const ctx = createContext({
    env,
    home: env.HOME as string,
    out: (text) => lines.push(text),
    err: () => {},
    interactive: false,
  });
  const code = await doctorCommand(ctx, { json: true }, platform, gitBash);
  return { code, report: JSON.parse(lines.join('\n')) as DoctorReport };
}

function checkOf(report: DoctorReport, id: string): DoctorCheck {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`checks 里没有 id=${id}（现有：${report.checks.map((c) => c.id).join(', ')}）`);
  return found;
}

/** config 指向一个必然克隆失败的本地路径：repo 检查落 WARN，不影响下面的断言。 */
function seedConfig(env: NodeJS.ProcessEnv): void {
  const config: Config = {
    version: 1,
    repo: '/nonexistent-repo-xyz',
    provider: 'git',
    primaryRole: null,
    additionalRoles: [],
    agents: ['claude'],
  };
  saveConfig(config, env);
}

/** 伪造 HOME 下 claude 的 hook 落点（settings.json 的 SessionStart，见 agents/paths.ts）。 */
function seedClaudeSettings(env: NodeJS.ProcessEnv, command: string): void {
  const dir = join(env.HOME as string, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }),
    'utf8',
  );
}

/** 造一个真实存在的假 cli 入口，让 hook:claude 的路径核对不受无关因素干扰。 */
function fakeCli(): string {
  const path = join(root, `cli-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(path, '// 占位入口\n', 'utf8');
  return path;
}

/**
 * Windows 形态的 hook 命令原文（与 constants.ts hookCommand 的 win32 分支同形）：
 * 工具配置里只留 `<wrapper 正斜杠裸路径> EJDRONE_HOOK=1`，`"<bash>" -lc "…"` 那层写进
 * 状态目录下的 wrapper 文件 —— doctor 要先按命令找到 wrapper、再从正文里取 bash 段。
 */
function windowsHookCommand(env: NodeJS.ProcessEnv, bashPath: string): string {
  const wrapper = hookWrapperPath(env);
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, `@echo off\r\n"${bashPath}" -lc "EJDRONE_HOOK=1 '${process.execPath}' '${fakeCli()}' pull --silent"\r\n`, 'utf8');
  return `${wrapper.split('\\').join('/')} EJDRONE_HOOK=1`;
}

describe('win:gitbash', () => {
  it('找不到 Git for Windows 时报 FAIL，消息与指引都点到 Git for Windows', async () => {
    // 注入 null 而不是"指望主机上没有 reg"：Windows 真机上 reg 会命中本机 Git 安装，
    // 旧写法在这台机器上直接得到 PASS，恰好把这条 FAIL 路径漏掉。
    const env = makeEnv('gitbash-fail');
    const { report } = await runDoctor(env, 'win32', null);

    const check = checkOf(report, 'win:gitbash');
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('Git for Windows');
    expect(check.hint).toContain('https://git-scm.com/download/win');
    // 为什么不退而求其次用 PATH 上的裸 bash，必须写进指引
    expect(check.hint).toContain('WSL');
  });

  it('ProgramFiles 下存在 bash.exe 时报 PASS 且消息含找到的路径', async () => {
    const pf = join(root, 'pf');
    const bashExe = join(pf, 'Git', 'bin', 'bash.exe');
    mkdirSync(dirname(bashExe), { recursive: true });
    writeFileSync(bashExe, '#!/bin/sh\n', 'utf8');
    const env = makeEnv('gitbash-pass', { ProgramFiles: pf });

    const { report } = await runDoctor(env, 'win32');

    const check = checkOf(report, 'win:gitbash');
    expect(check.status).toBe('PASS');
    expect(check.message).toContain(bashExe);
  });
});

describe('win:git', () => {
  it('PATH 上没有 git 时报 FAIL', async () => {
    const emptyBin = join(root, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });
    const env = makeEnv('git-fail', { PATH: emptyBin });

    const { report } = await runDoctor(env, 'win32');

    const check = checkOf(report, 'win:git');
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('git 不在 PATH');
    expect(check.hint).toContain('Git for Windows');
  });

  it('PATH 上有 git.exe 时报 PASS 且消息含找到的路径', async () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git.exe'), 'MZ\n', 'utf8');
    const env = makeEnv('git-pass', { PATH: bin, PATHEXT: '.EXE' });

    const { report } = await runDoctor(env, 'win32');

    const check = checkOf(report, 'win:git');
    expect(check.status).toBe('PASS');
    expect(check.message).toContain(join(bin, 'git.exe'));
  });
});

describe('win:hookbash', () => {
  it('Windows 形态 hook 命令的 bash 存在时报 PASS（既有检查不受影响）', async () => {
    const bashExe = join(root, 'gitbin', 'bash.exe');
    mkdirSync(dirname(bashExe), { recursive: true });
    writeFileSync(bashExe, '#!/bin/sh\n', 'utf8');
    const env = makeEnv('hookbash-pass');
    seedConfig(env);
    seedClaudeSettings(env, windowsHookCommand(env, bashExe));

    const { report } = await runDoctor(env, 'win32');

    expect(checkOf(report, 'win:hookbash').status).toBe('PASS');
    // 既有检查照旧：config PASS、probe 项存在
    expect(checkOf(report, 'config').status).toBe('PASS');
    expect(report.checks.some((c) => c.id === 'probe')).toBe(true);
  });

  it('hook 命令指向不存在的 bash 时报 FAIL，消息点名工具与路径', async () => {
    const dead = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const env = makeEnv('hookbash-fail');
    seedConfig(env);
    seedClaudeSettings(env, windowsHookCommand(env, dead));

    const { report } = await runDoctor(env, 'win32');

    const check = checkOf(report, 'win:hookbash');
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('Claude Code');
    expect(check.message).toContain(dead);
    expect(check.hint).toContain('ejdrone init');
    expect(check.hint).toContain('--force');
  });

  it('POSIX 形态的旧 hook 命令出现在 Windows 上报 WARN', async () => {
    const env = makeEnv('hookbash-warn');
    seedConfig(env);
    seedClaudeSettings(env, `EJDRONE_HOOK=1 '${process.execPath}' '${fakeCli()}' pull --silent`);

    const { report } = await runDoctor(env, 'win32');

    const check = checkOf(report, 'win:hookbash');
    expect(check.status).toBe('WARN');
    expect(check.message).toContain('Claude Code');
    expect(check.hint).toContain('--force');
  });

  it('一条 hook 命令都没采集到（没装 hook）时不添加这条检查', async () => {
    const env = makeEnv('hookbash-none');
    seedConfig(env);
    // 不写 settings.json：hook:claude 会报 FAIL，但 win:hookbash 不该出现

    const { report } = await runDoctor(env, 'win32');

    expect(report.checks.some((c) => c.id === 'win:hookbash')).toBe(false);
    expect(checkOf(report, 'hook:claude').status).toBe('FAIL');
  });
});

describe('POSIX 零变化', () => {
  it('platform=darwin 时同夹具不产生任何 win: 检查，既有检查照旧', async () => {
    const bashExe = join(root, 'gitbin', 'bash.exe');
    mkdirSync(dirname(bashExe), { recursive: true });
    writeFileSync(bashExe, '#!/bin/sh\n', 'utf8');
    const env = makeEnv('posix', { ProgramFiles: join(root, 'pf'), PATH: join(root, 'bin') });
    seedConfig(env);
    seedClaudeSettings(env, windowsHookCommand(env, bashExe));

    const { report } = await runDoctor(env, 'darwin');

    expect(report.checks.filter((c) => c.id.startsWith('win:'))).toEqual([]);
    // 既有检查不受影响
    expect(checkOf(report, 'config').status).toBe('PASS');
    expect(report.checks.some((c) => c.id === 'probe')).toBe(true);
  });
});

// ------------------------------------------------------------------ D1：hook cli 归属核对走 samePath

describe('hook:xxx 的 cli 归属核对（M10：samePath 取代裸 ===）', () => {
  // 大小写变体用 root 下的真实文件名，不用字面 `c:\\users\\dev\\cli.js`：
  // 反斜杠在 macOS 上是合法文件名字符，在 Windows 上却让 writeFileSync 直接 ENOENT
  // （`...\c:` 不是有效目录段）。用真文件名的两个大小写写法，两种主机都能造出真实存在的路径，
  // 而 win32/POSIX 对「它们是不是同一个文件」的分歧正是要验的东西。
  const cliLower = (): string => join(root, 'cli.js');
  const cliUpper = (): string => join(root, 'CLI.js');

  function seedCaseVariantHook(env: NodeJS.ProcessEnv): void {
    writeFileSync(cliLower(), '// cli\n', 'utf8');
    writeFileSync(cliUpper(), '// cli\n', 'utf8');
    seedConfig(env);
    seedClaudeSettings(env, `EJDRONE_HOOK=1 '${process.execPath}' '${cliLower()}' pull --silent`);
  }

  it('win32：大小写不同的同一文件不误报"另一份安装"', async () => {
    const env = makeEnv('hookcli-win32', { EJDRONE_CLI: cliUpper() });
    seedCaseVariantHook(env);

    const { report } = await runDoctor(env, 'win32');

    expect(checkOf(report, 'hook:claude').status).toBe('PASS');
  });

  it('darwin：同输入按严格 === 判"另一份安装"（差异证明检查确实是平台相关的）', async () => {
    const env = makeEnv('hookcli-darwin', { EJDRONE_CLI: cliUpper() });
    seedCaseVariantHook(env);

    const { report } = await runDoctor(env, 'darwin');

    const check = checkOf(report, 'hook:claude');
    expect(check.status).toBe('WARN');
    expect(check.message).toContain('不是同一份');
  });
});

// ------------------------------------------------------------------ D2：账本 FAIL 的 hint 分化

describe('ledger FAIL 的 hint（账本损坏对 merge 记账的含义不同）', () => {
  it('账本里有受管条目时：hint 点名受管文件并警告"冻结"', async () => {
    const env = makeEnv('ledger-managed');
    seedConfig(env);
    // 结构非法但可 JSON.parse：loadLedger 判 FAIL，ledgerFailHint 从原文 best-effort 提取受管路径
    writeFileSync(
      join(env.EJDRONE_HOME as string, 'ledger.json'),
      JSON.stringify({ version: 1, entries: [{ path: 'C:\\Users\\dev\\.claude.json', managedKeys: { alpha: 'sha256:1' } }] }),
      'utf8',
    );

    const { report } = await runDoctor(env, 'darwin');

    const check = checkOf(report, 'ledger');
    expect(check.status).toBe('FAIL');
    expect(check.hint).toContain('C:\\Users\\dev\\.claude.json');
    expect(check.hint).toContain('冻结');
  });

  it('账本里没有受管条目时：hint 维护普通文案并补"改过的文件需先删除"', async () => {
    const env = makeEnv('ledger-plain');
    seedConfig(env);
    writeFileSync(
      join(env.EJDRONE_HOME as string, 'ledger.json'),
      JSON.stringify({ version: 1, entries: [{ path: '/x/SKILL.md' }] }),
      'utf8',
    );

    const { report } = await runDoctor(env, 'darwin');

    const check = checkOf(report, 'ledger');
    expect(check.status).toBe('FAIL');
    expect(check.hint).toContain('被你改过的文件需先删除');
    expect(check.hint).not.toContain('冻结');
  });
});

// ------------------------------------------------------------------ D3：doctor 缺失的两类检测

describe('roles:conflict / roles:unknown（doctor 的体检盲区补齐）', () => {
  /** 建一个本地 bare origin：manifest 声明 be/fe，且两个激活 namespace 有同名 skills 条目（冲突源）。 */
  function seedTeamOrigin(state: string): string {
    const gitHome = join(root, 'git-home');
    mkdirSync(gitHome, { recursive: true });
    writeFileSync(join(gitHome, 'gitconfig'), '', 'utf8');
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        // 与 repo.test.ts 同形：不传 PATH（libuv 回落父进程查找），只钉隔离配置
        env: { HOME: gitHome, GIT_CONFIG_GLOBAL: join(gitHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });

    const origin = join(state, 'origin.git');
    mkdirSync(origin, { recursive: true });
    git(state, 'init', '--bare', '--initial-branch', 'main', origin);
    const seed = join(state, 'seed');
    mkdirSync(join(seed, 'manifest'), { recursive: true });
    mkdirSync(join(seed, 'skills', 'root-note'), { recursive: true });
    mkdirSync(join(seed, 'skills', 'be', 'dup'), { recursive: true });
    mkdirSync(join(seed, 'skills', 'fe', 'dup'), { recursive: true });
    writeFileSync(join(seed, 'manifest', 'roles.yaml'), 'version: 1\nroles:\n  - id: be\n    description: 后端\n    namespaces:\n      - be\n  - id: fe\n    description: 前端\n    namespaces:\n      - fe\n', 'utf8');
    writeFileSync(join(seed, 'skills', 'root-note', 'SKILL.md'), '# root\n', 'utf8');
    writeFileSync(join(seed, 'skills', 'be', 'dup', 'SKILL.md'), '# be dup\n', 'utf8');
    writeFileSync(join(seed, 'skills', 'fe', 'dup', 'SKILL.md'), '# fe dup\n', 'utf8');
    git(seed, 'init', '--initial-branch', 'main', '.');
    git(seed, 'add', '-A');
    git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@local', 'commit', '-m', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', 'origin', 'main');
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    return origin;
  }

  function seedRolesConfig(env: NodeJS.ProcessEnv, repo: string): void {
    const config: Config = {
      version: 1,
      repo,
      provider: 'git',
      primaryRole: 'be',
      additionalRoles: ['fe', 'ghost'],
      agents: ['claude'],
    };
    saveConfig(config, env);
  }

  it('双 namespace 同名冲突 → roles:conflict WARN；订阅角色不在 manifest → roles:unknown WARN', async () => {
    const env = makeEnv('roles');
    seedTeamOrigin(env.EJDRONE_HOME as string);
    seedRolesConfig(env, join(env.EJDRONE_HOME as string, 'origin.git'));

    const { report } = await runDoctor(env, 'darwin');

    const conflict = checkOf(report, 'roles:conflict');
    expect(conflict.status).toBe('WARN');
    expect(conflict.message).toContain('skills');
    const unknown = checkOf(report, 'roles:unknown');
    expect(unknown.status).toBe('WARN');
    expect(unknown.message).toContain('ghost');
  });

  it('没有冲突、角色都在 manifest 时两条检查都不出现', async () => {
    const env = makeEnv('roles-clean');
    const origin = seedTeamOrigin(env.EJDRONE_HOME as string);
    const config: Config = {
      version: 1,
      repo: origin,
      provider: 'git',
      primaryRole: 'be',
      additionalRoles: [],
      agents: ['claude'],
    };
    saveConfig(config, env);

    const { report } = await runDoctor(env, 'darwin');

    expect(report.checks.some((c) => c.id === 'roles:conflict')).toBe(false);
    expect(report.checks.some((c) => c.id === 'roles:unknown')).toBe(false);
  });
});
