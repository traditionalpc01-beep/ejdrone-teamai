import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * hook 里执行的命令：绝对路径的 node + cli 入口，而不是裸 `ejdrone`。
 * GUI 启动的 agent 常常不带 npm 全局 bin 的 PATH，裸命令会让"会话自动 pull"静默失效。
 * 前缀的 `EJDRONE_HOOK=1` 是 hooks.ts 识别自家条目的标记，删掉会导致 removeHook 认不出来。
 */
export function hookCommand(env: NodeJS.ProcessEnv = process.env): string {
  const node = nonEmpty(env.EJDRONE_NODE) ?? process.execPath;
  const cli = nonEmpty(env.EJDRONE_CLI) ?? cliEntry();
  return `EJDRONE_HOOK=1 ${shellQuote(node)} ${shellQuote(cli)} pull --silent`;
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

/** 当前这个正在运行的 ejdrone 的入口路径，用于比对 hook 是否已指向旧安装。 */
export function currentCliEntry(env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(env.EJDRONE_CLI) ?? cliEntry();
}

/** 资源名 / namespace 白名单字符（设计文档 §10 第 6 条），与 core/manifest.ts 的 ID_RE 同形。 */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function isValidResourceName(value: string): boolean {
  return value.length > 0 && value.length <= 120 && !value.includes('/') && NAME_RE.test(value);
}
