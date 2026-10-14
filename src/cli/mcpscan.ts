import { existsSync, readFileSync } from 'node:fs';

import { mcpTargetPath, TOOL_PATHS, type McpTargetStyle } from '../agents/paths.js';
import type { McpServerDef } from '../core/types.js';

/**
 * 本机各工具 MCP 落点的只读扫描（push --mcp 反向采集、list mcp --source local、status 用）。
 *
 * 两条红线：
 * 1. **只读**（设计文档 §10 第 2 条：push 对工具目录只读）。
 * 2. 这些文件里可能写着明文 token，所以任何 note / error 文案**只许出现 server 名、工具 id、文件路径、
 *    字段名**，连解析器的原始报错都不回显（V8 的 JSON.parse 文案会带上输入片段 —— 那正是密钥所在地）。
 *
 * 反向采集只覆盖 JSON 形态的落点（M6 命令面决定 1）：TOML（codex `config.toml`）我们投递时只做
 * 受控的行级表块拼接，故意没写完整解析器；为 push 补一个解析器就是把它请回来。
 * TOML 里的条目**只列名字**（表头 `[mcp_servers.<name>]` 一行一个，不解析值），供 list/status 点名。
 */

export interface LocalMcpEntry {
  agent: string;
  label: string;
  style: McpTargetStyle;
  format: 'json' | 'toml';
  /** 该工具的 MCP 落点绝对路径 */
  file: string;
  name: string;
  /** true = JSON 形态，能反向采集出条目内容 */
  collectable: boolean;
  /** JSON 条目的原始值（含明文凭据）。只在本模块内流到 defFromLocalEntry，绝不进任何输出 */
  value?: unknown;
}

export interface LocalMcpScan {
  entries: LocalMcpEntry[];
  /** 落点文件不存在 / 解析不了 / 形状认不出 —— 只含路径与名字 */
  notes: string[];
  /** 选定工具里没有用户级 MCP 落点的（doctor mcp:target / status 用） */
  unsupported: string[];
}

/** 表头路径允许点号（`[mcp_servers.be-metrics]`），但不允许引号 / 方括号 —— 那些是异形，不猜。 */
const POINTER_TOML_NAME_RE = /^\[([A-Za-z0-9_.-]+)\]$/;

function pointerPrefix(pointer: string[]): string {
  return pointer.join('.');
}

/** TOML 里只认我们投递时用的那种裸键表头 `[<pointer>.<name>]`；带引号/内联表/`[[` 一律不猜。 */
function tomlServerNames(text: string, pointer: string[]): string[] {
  const prefix = `${pointerPrefix(pointer)}.`;
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = POINTER_TOML_NAME_RE.exec(line.trim());
    const path = match?.[1];
    if (!path || !path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (name === '' || name.includes('.')) continue; // 子表（`[mcp_servers.x.env]`）不是 server
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function navigate(root: unknown, pointer: string[]): unknown {
  let node = root;
  for (const key of pointer) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
    if (node === undefined) return undefined;
  }
  return node;
}

function scanJsonTarget(
  entry: Omit<LocalMcpEntry, 'name' | 'value' | 'collectable'>,
  pointer: string[],
  text: string,
  push: (e: LocalMcpEntry) => void,
  notes: string[],
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不带上解析器原文：它的报错会截取文件片段，而片段里可能就是明文 token
    notes.push(`${entry.label} 的 ${entry.file} 不是合法 JSON，本次跳过（不打印内容以免回显凭据）`);
    return;
  }
  const table = navigate(parsed, pointer);
  if (table === undefined || table === null) {
    notes.push(`${entry.file} 里找不到条目表 ${pointerPrefix(pointer)}，本次跳过`);
    return;
  }
  if (typeof table !== 'object' || Array.isArray(table)) {
    notes.push(`${entry.file} 里的 ${pointerPrefix(pointer)} 不是映射，认不出条目表，本次跳过`);
    return;
  }
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    push({ ...entry, name, value, collectable: true });
  }
}

/** 扫选定工具的 MCP 落点。目录不存在/文件不存在不算异常（成员还没配过），只默默不列。 */
export function scanLocalMcp(home: string, env: NodeJS.ProcessEnv, agents: string[]): LocalMcpScan {
  const entries: LocalMcpEntry[] = [];
  const notes: string[] = [];
  const unsupported: string[] = [];

  for (const id of agents) {
    const spec = TOOL_PATHS[id];
    if (!spec) {
      notes.push(`未知的工具 id「${id}」，本次跳过`);
      continue;
    }
    const target = mcpTargetPath(id, home, env);
    if (!target) {
      unsupported.push(id);
      continue;
    }
    if (!existsSync(target.path)) continue;
    let text: string;
    try {
      text = readFileSync(target.path, 'utf8');
    } catch {
      notes.push(`读不到 ${target.path}，本次跳过`);
      continue;
    }
    const base = {
      agent: id,
      label: spec.label,
      style: target.style,
      format: target.format,
      file: target.path,
    };
    if (target.format === 'toml') {
      for (const name of tomlServerNames(text, target.pointer)) {
        entries.push({ ...base, name, collectable: false });
      }
      continue;
    }
    scanJsonTarget(base, target.pointer, text, (e) => entries.push(e), notes);
  }

  return { entries, notes, unsupported };
}

// ------------------------------------------------------------- 条目值 → def

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return undefined;
    out[k] = v;
  }
  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/** 把 copilot 的单条命令行字符串拆回 command + args（与 mcpfmt 的写出规则互为逆运算）。 */
function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === undefined) continue;
    if (quoted) {
      if (ch === '\\' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current !== '') tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current !== '') tokens.push(current);
  return tokens;
}

export interface DefResult {
  def?: McpServerDef;
  /** 面向人的原因，只含字段名与形状描述 */
  error?: string;
  /** 本地条目里我们没搬进仓库的字段名（让成员知道入库会少什么） */
  dropped?: string[];
}

const CLAUDE_COMPAT_KEYS = new Set(['command', 'args', 'env', 'type', 'url', 'headers', 'timeout', 'description']);
const OPENCODE_KEYS = new Set(['type', 'command', 'environment', 'url', 'headers', 'description']);
const COPILOT_KEYS = new Set(['type', 'command', 'tools', 'url', 'headers', 'description']);

function unmappedKeys(value: Record<string, unknown>, known: Set<string>): string[] {
  return Object.keys(value).filter((k) => !known.has(k));
}

/** 本地条目里的 description 直接进仓库（我们的 schema 认这个字段）。 */
function descriptionOf(obj: Record<string, unknown>): string | undefined {
  return typeof obj.description === 'string' && obj.description.trim() !== '' ? obj.description : undefined;
}

function withDescription(def: McpServerDef, obj: Record<string, unknown>): McpServerDef {
  const description = descriptionOf(obj);
  if (description === undefined) return def;
  return { ...def, description };
}

function stdioFromObject(obj: Record<string, unknown>): McpServerDef | string {
  const command = obj.command;
  if (typeof command !== 'string' || command.trim() === '') return 'stdio 条目缺 command 字段（或它不是字符串）';
  const def: McpServerDef = { transport: 'stdio', command };
  if (obj.args !== undefined) {
    const args = stringArray(obj.args);
    if (!args) return 'args 不是字符串数组';
    if (args.length > 0) def.args = args;
  }
  if (obj.env !== undefined) {
    const envMap = stringRecord(obj.env);
    if (!envMap) return 'env 不是「变量名 → 值」的映射';
    if (Object.keys(envMap).length > 0) def.env = envMap;
  }
  if (typeof obj.timeout === 'number' && Number.isInteger(obj.timeout) && obj.timeout >= 0) {
    def.timeoutMs = obj.timeout;
  }
  return def;
}

function remoteFromObject(obj: Record<string, unknown>, transport: 'http' | 'sse'): McpServerDef | string {
  const url = obj.url;
  if (typeof url !== 'string' || url.trim() === '') return `${transport} 条目缺 url 字段（或它不是字符串）`;
  const def: McpServerDef = { transport, url };
  if (obj.headers !== undefined) {
    const headers = stringRecord(obj.headers);
    if (!headers) return 'headers 不是「名字 → 值」的映射';
    if (Object.keys(headers).length > 0) def.headers = headers;
  }
  if (typeof obj.timeout === 'number' && Number.isInteger(obj.timeout) && obj.timeout >= 0) {
    def.timeoutMs = obj.timeout;
  }
  return def;
}

function result(def: McpServerDef, dropped: string[]): DefResult {
  return dropped.length > 0 ? { def, dropped } : { def };
}

/** Claude 兼容形：stdio 不写 type（历史形状），远程写 type: http|sse。 */
function fromClaudeCompat(obj: Record<string, unknown>): DefResult {
  const dropped = [...unmappedKeys(obj, CLAUDE_COMPAT_KEYS)];
  if ('disabled' in obj) dropped.push('disabled');
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  if (typeof obj.command === 'string') {
    if (type !== undefined && type !== 'stdio') return { error: `type「${type}」却带 command，形状矛盾` };
    const def = stdioFromObject(obj);
    if (typeof def === 'string') return { error: def };
    return result(withDescription(def, obj), dropped);
  }
  if (type === 'http' || type === 'sse') {
    const def = remoteFromObject(obj, type);
    if (typeof def === 'string') return { error: def };
    return result(withDescription(def, obj), dropped);
  }
  if (typeof obj.url === 'string') {
    return { error: '远程条目没有 type 字段，无法判断是 http 还是 sse（不猜）' };
  }
  return { error: '认不出条目形状：既没有 command 也没有带 type 的 url' };
}

/** opencode：stdio 是 `type: local` + command 数组 + environment（只列变量名）。 */
function fromOpencode(obj: Record<string, unknown>): DefResult {
  const dropped = [...unmappedKeys(obj, OPENCODE_KEYS)];
  if ('disabled' in obj) dropped.push('disabled');
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  if (type === 'local' || (type === undefined && Array.isArray(obj.command))) {
    const command = stringArray(obj.command);
    if (!command || command.length === 0 || !command[0]) return { error: 'type: local 的 command 必须是数组（本条目不是）' };
    const def: McpServerDef = { transport: 'stdio', command: command[0] };
    const args = command.slice(1);
    if (args.length > 0) def.args = args;
    const names = stringArray(obj.environment);
    if (Array.isArray(obj.environment) && !names) return { error: 'environment 必须是变量名数组' };
    if (names && names.length > 0) {
      // opencode 的模型是"值留在进程环境里"，逆回来正好就是仓库的 `${VAR}` 写法
      def.env = Object.fromEntries(names.map((n) => [n, `\${${n}}`]));
    }
    return result(withDescription(def, obj), dropped);
  }
  if (type === 'remote') {
    const def = remoteFromObject(obj, 'http');
    if (typeof def === 'string') return { error: def };
    return result(withDescription(def, obj), dropped);
  }
  return { error: `opencode 条目只认 type: local / remote，收到${typeText(type)}` };
}

/** copilot：stdio 是 `type: local` + 单条命令行字符串；它的 tools 是 MCP 工具允许列表，不是我们的 tools。 */
function fromCopilot(obj: Record<string, unknown>): DefResult {
  const dropped = unmappedKeys(obj, COPILOT_KEYS);
  const type = typeof obj.type === 'string' ? obj.type : undefined;
  if (type === 'local') {
    if (typeof obj.command !== 'string') return { error: 'type: local 的 command 必须是字符串（Copilot 的形状）' };
    const parts = splitCommandLine(obj.command);
    if (parts.length === 0 || !parts[0]) return { error: 'command 拆不出可执行文件名' };
    const def: McpServerDef = { transport: 'stdio', command: parts[0] as string };
    const args = parts.slice(1);
    if (args.length > 0) def.args = args;
    return result(withDescription(def, obj), [...dropped, 'tools']);
  }
  if (type === 'http' || type === 'sse') {
    const def = remoteFromObject(obj, type);
    if (typeof def === 'string') return { error: def };
    return result(withDescription(def, obj), [...dropped, 'tools']);
  }
  return { error: `copilot 条目只认 type: local / http / sse，收到${typeText(type)}` };
}

/** 点名 type 字段：只出 type 的名字（值本身来自该工具的固定枚举，不含凭据）。 */
function typeText(type: string | undefined): string {
  return type === undefined ? '没有 type 字段' : `「${type}」`;
}

/** 把本地条目值逆回仓库的 McpServerDef。分派只看 paths.ts 的 style，不按工具 id 猜。 */
export function defFromLocalEntry(entry: LocalMcpEntry): DefResult {
  if (!entry.collectable) {
    return { error: '该工具的 MCP 落点不是 JSON 形态，不能反向采集（请手写进仓库文件）' };
  }
  const value = entry.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '条目值不是映射，认不出形状' };
  }
  const obj = value as Record<string, unknown>;
  switch (entry.style) {
    case 'json-mcpServers':
      return fromClaudeCompat(obj);
    case 'json-opencode':
      return fromOpencode(obj);
    case 'json-copilot':
      return fromCopilot(obj);
    case 'toml-codex':
      return { error: 'TOML 落点不做反向解析（请手写进仓库文件）' };
  }
}
