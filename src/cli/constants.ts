import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { findGitBash } from '../platform.js';

/**
 * hook 里执行的命令：绝对路径的 node + cli 入口，而不是裸 `ejdrone`。
 * GUI 启动的 agent 常常不带 npm 全局 bin 的 PATH，裸命令会让"会话自动 pull"静默失效。
 * 前缀的 `EJDRONE_HOOK=1` 是 hooks.ts 识别自家条目的标记，删掉会导致 removeHook 认不出来。
 *
 * Windows 形态（M10 / T10.2）：`"<git-bash>" -lc "EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent"`。
 * 两个「为什么」钉在这里，改引号形状前先读：
 *  1. 内层必须保持单引号：hooks.ts 的 HOOK_COMMAND_MARKER 识别、parseHookPaths 的单引号提取、
 *     doctor 的绝对路径核对全都依赖 `EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent` 这个形状，
 *     动内层引号 = 三处连锁改，不是局部改动。
 *  2. 外层用双引号是对计划文本的有意偏差：Git for Windows 的 bash 路径常含空格
 *     （C:\Program Files\Git\bin\bash.exe），cmd.exe 不认单引号包裹，双引号才是
 *     cmd 与 `bash -lc` 都友好的形态；单引号只在 bash 内部世界通用。
 *
 * 返回 null 的唯一场景：win32 且找不到 Git for Windows（hook 装不了，调用方转人工指引）。
 */
export function hookCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const node = nonEmpty(env.EJDRONE_NODE) ?? process.execPath;
  const cli = nonEmpty(env.EJDRONE_CLI) ?? cliEntry();
  const inner = `EJDRONE_HOOK=1 ${shellQuote(node)} ${shellQuote(cli)} pull --silent`;
  if (platform !== 'win32') return inner;
  const bash = findGitBash(env, platform);
  if (bash === null) return null;
  return `"${bash}" -lc "${inner}"`;
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

/** 从已安装的 hook 命令里取回 node 与 cli 入口两个绝对路径。 */
export function parseHookPaths(cmd: string): { node: string; cli: string } | null {
  const quoted = [...cmd.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
  if (quoted.length < 2) return null;
  return { node: quoted[0] ?? '', cli: quoted[1] ?? '' };
}

/**
 * 从 hook 命令里提取 Windows 形态的 bash 路径（doctor 的 win:hookbash 检查用）。
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
