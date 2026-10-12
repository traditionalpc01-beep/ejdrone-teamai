import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { replaceFileSync } from './core/ledger.js';

/**
 * SessionStart 类 hook 的注入与移除。
 *
 * 采用 Claude 兼容的 settings 结构：
 *   { "hooks": { "<Event>": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 * Codex / Qoder / DSH 沿用同一形状（落点与事件名见 agents/paths.ts）。
 *
 * 契约要点（其他模块据此调用，勿改签名）：
 *  - 以命令中包含 HOOK_COMMAND_MARKER（一个只可能由本工具写进 hook 的环境变量前缀）
 *    识别"我们的"条目，不新增自定义字段（避免 schema 校验失败）
 *  - upsert 幂等：重复调用只保留一条
 *  - 除 hooks 之外的既有键保持不动
 *  - settings 文件存在但不是合法 JSON 时抛错，错误信息必须含文件路径（调用方降级为告警）
 */

export const HOOK_COMMAND_MARKER = 'EJDRONE_HOOK=1';

export interface HookSpec {
  /** 事件名，如 'SessionStart' */
  event: string;
  cmd: string;
}

export class HookSettingsError extends Error {
  constructor(
    message: string,
    readonly settingsPath: string,
  ) {
    super(`${message} (${settingsPath})`);
    this.name = 'HookSettingsError';
  }
}

type HookEntry = { matcher?: string; hooks?: unknown[] };

function readSettings(settingsPath: string): Record<string, unknown> {
  return load(settingsPath).doc;
}

interface Loaded {
  doc: Record<string, unknown>;
  /** 原文格式：缩进与结尾换行都跟着原文件走，卸载后才能逐字节还原 */
  format: { indent: number; trailingNewline: boolean };
  existed: boolean;
}

function load(settingsPath: string): Loaded {
  const format = { indent: 2, trailingNewline: true };
  if (!existsSync(settingsPath)) return { doc: {}, format, existed: false };
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    throw new HookSettingsError(`Cannot read settings: ${(e as Error).message}`, settingsPath);
  }
  format.trailingNewline = raw.endsWith('\n');
  const firstIndent = /^ {2,}/m.exec(raw)?.[0].length;
  if (firstIndent !== undefined) format.indent = firstIndent;
  if (raw.trim() === '') return { doc: {}, format, existed: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new HookSettingsError(`Settings is not valid JSON: ${(e as Error).message}`, settingsPath);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HookSettingsError('Settings must be a JSON object', settingsPath);
  }
  return { doc: parsed as Record<string, unknown>, format, existed: true };
}

/** 我们注入的条目：hooks[] 里任一 command 含 marker */
function isOurs(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const hooks = (entry as HookEntry).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h !== null &&
      typeof h === 'object' &&
      typeof (h as { command?: unknown }).command === 'string' &&
      (h as { command: string }).command.includes(HOOK_COMMAND_MARKER),
  );
}

function atomicWrite(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // 真机 ~/.qoder-cn/settings.json、~/.codex/config.toml 都是 0600：临时文件按目标原权限创建，
  // rename 后权限不因我们重写一次而放宽（新建文件维持 umask 默认，行为与旧版一致）。
  const prevMode = existsSync(filePath) ? statSync(filePath).mode & 0o777 : undefined;
  const tmp = `${filePath}.tmp-${process.pid}`;
  if (prevMode === undefined) writeFileSync(tmp, text, 'utf8');
  else writeFileSync(tmp, text, { encoding: 'utf8', mode: prevMode });
  replaceFileSync(tmp, filePath);
}

/** 按原文件的缩进与结尾换行渲染 —— 卸载后才能逐字节回到成员原来的样子。 */
function render(doc: unknown, format: { indent: number; trailingNewline: boolean }): string {
  const text = JSON.stringify(doc, null, format.indent);
  return format.trailingNewline ? `${text}\n` : text;
}

function hookList(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const list = (hooks as Record<string, unknown>)[event];
  return Array.isArray(list) ? list : [];
}

export function upsertHook(settingsPath: string, spec: HookSpec): void {
  const { doc: settings, format } = load(settingsPath);
  const raw = settingsHooks(settings)[spec.event];
  // 该事件已被别人写成非数组形状 —— 覆盖它会丢掉对方的配置，宁可不装也要说清楚。
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new HookSettingsError(`hooks.${spec.event} exists but is not an array; refusing to overwrite`, settingsPath);
  }
  const others = hookList(settings, spec.event).filter((entry) => !isOurs(entry));
  others.push({
    matcher: '*',
    hooks: [{ type: 'command', command: spec.cmd }],
  });

  const baseHooks =
    settings.hooks !== null && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};
  baseHooks[spec.event] = others;
  settings.hooks = baseHooks;

  atomicWrite(settingsPath, render(settings, format));
}

function settingsHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return {};
  return hooks as Record<string, unknown>;
}

/**
 * 移除我们注入的条目；其他内容保持不变，且缩进/结尾换行跟着原文件（卸载后要能逐字节还原）。
 * 文件不存在、或里面根本没有我们的条目时静默返回。
 * 摘完只剩空对象时删掉文件：空对象不承载任何用户信息，留着只会让人问"这是谁写的"。
 */
export function removeHook(settingsPath: string, event?: string): void {
  const loaded = load(settingsPath);
  if (!loaded.existed) return;
  const settings = loaded.doc;
  const hooks = settings.hooks;
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return;

  const bag = hooks as Record<string, unknown>;
  const events = event ? [event] : Object.keys(bag);
  let touched = false;
  for (const ev of events) {
    const list = Array.isArray(bag[ev]) ? (bag[ev] as unknown[]) : null;
    // 非数组值原样留着：那不是我们能解释的形状
    if (list === null) continue;
    const kept = list.filter((entry) => !isOurs(entry));
    if (kept.length === list.length) continue;
    touched = true;
    if (kept.length === 0) delete bag[ev];
    else bag[ev] = kept;
  }
  if (!touched) return;
  if (Object.keys(bag).length === 0) delete settings.hooks;

  if (Object.keys(settings).length === 0) {
    try {
      unlinkSync(settingsPath);
    } catch {
      /* 已被别人删掉或权限不允许：报告留给调用方，不在此抛出 */
    }
    return;
  }

  atomicWrite(settingsPath, render(settings, loaded.format));
}

export function hasHook(settingsPath: string, event: string): boolean {
  if (!existsSync(settingsPath)) return false;
  return hookList(readSettings(settingsPath), event).some(isOurs);
}

/** 我们装进去的命令原文；没有则 null。doctor 用它核对命令里的绝对路径是否还存在。 */
export function installedHookCommand(settingsPath: string, event: string): string | null {
  if (!existsSync(settingsPath)) return null;
  for (const entry of hookList(readSettings(settingsPath), event)) {
    if (!isOurs(entry)) continue;
    const hooks = (entry as HookEntry).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) {
      const command = (h as { command?: unknown })?.command;
      if (typeof command === 'string' && command.includes(HOOK_COMMAND_MARKER)) return command;
    }
  }
  return null;
}
