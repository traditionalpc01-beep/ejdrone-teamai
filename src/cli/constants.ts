import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { findGitBash, type GitInstallPathReader } from '../platform.js';
import { HOOK_COMMAND_MARKER } from '../hooks.js';
import { hookWrapperPath } from '../state.js';

/**
 * Windows 形态（M10 / T10.2，2026-10-12 真机实测后改定）：工具侧的命令是
 * `<wrapper.cmd 正斜杠裸路径> EJDRONE_HOOK=1`，真正的 `"<git-bash>" -lc "…"` 收在 wrapper 里。
 *
 * 为什么必须这么改（实测矩阵见试验记录，六种启动方式 = node shell:true / cmd /c /
 * cmd /d /s /c / powershell -Command / pwsh -Command / git bash -c）：
 *  - `"<bash>" -lc "…"`：cmd 与 Git Bash 能跑，**PowerShell/pwsh 报 ParserError** ——
 *    PowerShell 里「首 token 是带引号的路径」必须前置 `&`，而 `&` 在 cmd 与 bash 里是语法符号，
 *    所以不存在一个既带引号首 token 又三 shell 通吃的命令串。
 *  - 裸路径（不带引号）在 cmd / PowerShell / pwsh 里都是合法命令，于是把引号需求搬进 wrapper 文件；
 *    代价是 wrapper 路径不能含空格，含空格时退到 `cmd.exe /c "<wrapper>"`（实测 PowerShell 通、
 *    Git Bash 因 MSYS 把 `/c` 当路径转换而断），由 doctor 点名，不静默。
 *  - 正斜杠：Git Bash 会把裸反斜杠路径里的 `\t`、`\e` 当转义吃掉（实测 `F:tmpejdrone…`），
 *    而 cmd 与 PowerShell 都接受正斜杠，所以统一用正斜杠。
 *  - `EJDRONE_HOOK=1` 作为尾随参数保留在命令串里：hooks.ts 靠 `.includes(marker)` 认领自家条目，
 *    batch 会把它当 `%1` 忽略掉，识别链路一处都不用改。
 *
 * 返回 null 的唯一场景：win32 且找不到 Git for Windows（wrapper 里没有可执行的宿主，hook 装不了）。
 */
export function hookCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readRegistry?: GitInstallPathReader,
): string | null {
  if (platform !== 'win32') return hookPayload(env);
  const win = win32Hook(env, platform, readRegistry);
  return win === null ? null : win.command;
}

/** hook payload 的正文形状：POSIX 直接就是它，Windows 把它写进 wrapper 文件。 */
function hookPayload(env: NodeJS.ProcessEnv): string {
  const node = nonEmpty(env.EJDRONE_NODE) ?? process.execPath;
  const cli = nonEmpty(env.EJDRONE_CLI) ?? cliEntry();
  return `EJDRONE_HOOK=1 ${shellQuote(node)} ${shellQuote(cli)} pull --silent`;
}

/** Windows 下 hook 的两个产物：写进工具配置的命令串 + wrapper 文件正文。 */
export interface Win32Hook {
  command: string;
  wrapperPath: string;
  wrapperBody: string;
  /** wrapper 路径含空格 → 走了 cmd.exe 包装，Git Bash 那一路会断，doctor 据此点名 */
  degraded: boolean;
}

export function win32Hook(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readRegistry?: GitInstallPathReader,
): Win32Hook | null {
  if (platform !== 'win32') return null;
  const bash = findGitBash(env, platform, readRegistry);
  if (bash === null) return null;
  const body = `@echo off\r\n"${bash}" -lc "${hookPayload(env)}"\r\n`;
  const wrapper = toForwardSlash(hookWrapperPath(env));
  const degraded = wrapper.includes(' ');
  const command = degraded ? `cmd.exe /c "${wrapper}" ${HOOK_COMMAND_MARKER}` : `${wrapper} ${HOOK_COMMAND_MARKER}`;
  return { command, wrapperPath: hookWrapperPath(env), wrapperBody: body, degraded };
}

/** 工具配置里那条命令指向的 wrapper 路径；非 Windows 形态（没有 wrapper）返回 null。 */
export function parseHookWrapper(cmd: string): string | null {
  const bare = /^(\S+\.cmd) /i.exec(cmd)?.[1];
  if (bare !== undefined) return bare;
  const quoted = /cmd\.exe \/c "([^"]+)"/i.exec(cmd)?.[1];
  return quoted === undefined ? null : quoted;
}

/** 这条 hook 命令是不是「路径含空格 → cmd.exe /c 包装」的降级形态。 */
export function isDegradedHookCommand(cmd: string): boolean {
  return /^cmd\.exe\s+\/c\s+"/i.test(cmd);
}

function toForwardSlash(p: string): string {
  return p.split('\\').join('/');
}


function nonEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function cliEntry(): string {
  const argv1 = process.argv[1];
  if (!argv1) return 'ejdrone';
  try {
    return realpathSync(argv1);
  } catch {
    return resolve(argv1);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 从 hook payload 正文里取回 node 与 cli 两个绝对路径。
 *
 * 取的是 payload 而不是工具配置里那一行命令：POSIX 下两者同一份，Windows 下命令只指向 wrapper，
 * 单引号形状在 wrapper 正文里（调用方先用 parseHookWrapper 把正文读出来）。
 * 绝对路径的 node + cli 入口而不是裸 `ejdrone`：GUI 启动的 agent 常常不带 npm 全局 bin 的 PATH，
 * 裸命令会让「会话自动 pull」静默失效。
 */
export function parseHookPaths(cmd: string): { node: string; cli: string } | null {
  const quoted = [...cmd.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
  if (quoted.length < 2) return null;
  return { node: quoted[0] ?? '', cli: quoted[1] ?? '' };
}

/**
 * 从 hook payload 正文里提取 Windows 形态的 bash 路径（doctor 的 win:hookbash 检查用）。
 * 取第一个双引号段，非空且以 bash.exe 结尾（大小写不敏感）才认；
 * POSIX 形态没有双引号段 → null，双引号段不是 bash.exe（比如某工具自带的 wrapper）也 → null。
 */
export function parseHookBash(cmd: string): string | null {
  const m = /"([^"]*)"/.exec(cmd);
  const bash = m?.[1] ?? '';
  if (bash === '') return null;
  return /bash\.exe$/i.test(bash) ? bash : null;
}

/** 当前这个正在运行的 ejdrone 的入口路径，用于比对 hook 是否已指向旧安装。 */
export function currentCliEntry(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.EJDRONE_CLI) ?? cliEntry();
}

/** 资源名 / namespace 白名单字符（设计文档 §10 第 6 条），与 core/manifest.ts 的 ID_RE 同形。 */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidResourceName(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !value.includes('/') && NAME_RE.test(value);
}

/**
 * 内置 skill 的保留名（M8/M9）。两条都由本工具随 `ejdrone readme` 一起提交进团队仓库：
 * `ejdrone-recall` 教 agent 动手前先做一次知识检索预检，`ejdrone-share` 教它把踩坑沉淀成 learning。
 *
 * 它们出现在 `BUILTIN_SKILLS` 之外还有一层作用：`push` 侧拒绝同名条目（照 teamai 把 `teamai-recall`
 * 设为永不 push 的做法）。允许 push 就等于允许「成员本地那份」绕过评审覆盖全员的引导技能。
 * 想改这两条内容仍然可以 —— 在团队仓库里直接改并走 MR，那才是有兜底的那条路。
 */
export const BUILTIN_SKILL_NAMES: readonly string[] = ['ejdrone-recall', 'ejdrone-share'];
