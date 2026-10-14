import { mcpPayload, resourceKey, type McpServerDef, type Resource, type ResourceKey } from '../core/types.js';
import { whichWithPathext } from '../platform.js';
import type { McpTargetStyle } from './paths.js';

/**
 * MCP 条目文本渲染（2.0 计划 T6.5）—— 四种目标形态收口在这一个文件。
 *
 * 条目文本必须满足 core/merge.ts 顶部的约定：
 *  - json：条目值的**完整 JSON 文本**（merge 侧 JSON.parse 后按规范化比较，键序/格式化抖动不算成员改过）；
 *  - toml：完整块，首个非空行必须正好是 `[<pointer 用 . 连接>.<key>]`，块内其余表头只能是它的子表。
 *
 * 传入的 def 必须是 `resolveMcpResources` 之后的已解析形状（`${VAR}` 已换成明文）；
 * 本文件的渲染函数只产出条目文本，**warnings 里只出现 server 名、变量名、可执行名，绝不含任何已解析值**。
 * format / pointer / style 一律来自 paths.ts 的 mcpTarget —— 这里没有按工具 id 的分派。
 */

export function mcpMergeResourceKey(id: string): ResourceKey {
  // 合成 key 惯例同 block.ts 的 `rules:team-rules-block`：恒发一条 merge write 由它进 activeResources，
  // 「冲突停发 ≠ 清空」这条既有不变量才对 mcp 成立。
  return resourceKey('mcp', `${id}-merge`);
}

// ------------------------------------------------------------------ requires 探测

/**
 * 在 PATH 上找可执行文件。整个实现收口在 src/platform.ts（T10.1），这里只是薄委派：
 * 不在本文件保留第二份实现 —— 平台逻辑写两份，改一处漏一处正是 AGENTS.md 收口规则想防的事。
 * 语义（POSIX：':' 分 PATH、只试裸名、要求 X_OK；win32：PATHEXT 后缀匹配）见 whichWithPathext。
 */
export function whichOn(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  return whichWithPathext(name, env, platform);
}

// ------------------------------------------------------------ json-mcpServers
// Claude 兼容形（claude / qoder / qoder-cn / cursor / codebuddy / workbuddy / kiro / pi）：
// stdio 不写 type（Claude 的经典形状），远程写 type: "http" | "sse"；timeout 毫秒原样传。

function claudeCompatEntry(def: McpServerDef): Record<string, unknown> {
  if (def.transport === 'stdio') {
    const obj: Record<string, unknown> = { command: def.command };
    if (def.args && def.args.length > 0) obj.args = def.args;
    if (def.env && Object.keys(def.env).length > 0) obj.env = def.env;
    if (def.timeoutMs !== undefined) obj.timeout = def.timeoutMs;
    return obj;
  }
  const obj: Record<string, unknown> = { type: def.transport, url: def.url };
  if (def.headers && Object.keys(def.headers).length > 0) obj.headers = def.headers;
  if (def.timeoutMs !== undefined) obj.timeout = def.timeoutMs;
  return obj;
}

// ---------------------------------------------------------------- toml-codex
// 真机形状：`[mcp_servers.<name>]` + 子表 `[mcp_servers.<name>.env]`。
// Codex 不支持 sse（协调者在 T6.5 定的：跳过 + warning）；没有文档化的 per-server timeout 字段，
// timeoutMs 不硬造键名，丢弃（比写一个它不读的键诚实）。

function tomlCodexEntry(key: string, def: McpServerDef, pointer: string[]): string | null {
  if (def.transport === 'sse') return null;
  const prefix = pointer.join('.');
  const lines: string[] = [`[${prefix}.${key}]`];
  if (def.transport === 'stdio') {
    lines.push(`command = ${tomlString(def.command as string)}`);
    if (def.args && def.args.length > 0) lines.push(`args = [${def.args.map(tomlString).join(', ')}]`);
    appendTomlSubtable(lines, `${prefix}.${key}`, 'env', def.env);
  } else {
    lines.push(`url = ${tomlString(def.url as string)}`);
    // headers 用子表而非内联表：与真机 codex 的 .env 子表同一形状，且 merge 侧对内联表键值的容忍度更低。
    appendTomlSubtable(lines, `${prefix}.${key}`, 'http_headers', def.headers);
  }
  return `${lines.join('\n')}\n`;
}

/** 与 merge.ts 的 TOML_BARE_KEY 同一口径：安全键裸写，其余用字串引号包裹。 */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `'${key.replace(/'/g, "''")}'`;
}

/** TOML basic string。JSON.stringify 的转义集（\" \\ \n \uXXXX…）是 TOML 合法子集。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function appendTomlSubtable(lines: string[], tablePath: string, sub: string, map: Record<string, string> | undefined): void {
  if (!map || Object.keys(map).length === 0) return;
  lines.push('', `[${tablePath}.${sub}]`);
  for (const [k, v] of Object.entries(map)) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
}

// -------------------------------------------------------------- json-opencode
// opencode.json 的 `mcp` 键：stdio → type:"local"（command 是含参数的数组）；远程 → type:"remote"。
// environment 只列变量**名**（opencode 的模型是运行时从进程环境取值），已解析的明文不进文件——
// 这与 Claude 形把值写进 env 相反，是 opencode 自己的形状，不是我们的选择。

function opencodeEntry(def: McpServerDef): Record<string, unknown> {
  if (def.transport === 'stdio') {
    const obj: Record<string, unknown> = { type: 'local', command: [def.command as string, ...(def.args ?? [])] };
    if (def.env && Object.keys(def.env).length > 0) obj.environment = Object.keys(def.env).sort();
    return obj;
  }
  const obj: Record<string, unknown> = { type: 'remote', url: def.url };
  if (def.headers && Object.keys(def.headers).length > 0) obj.headers = def.headers;
  return obj;
}

// --------------------------------------------------------------- json-copilot
// Copilot CLI：stdio → type:"local" 且 command 是单条命令行字符串；远程保留 http/sse。
// **必须有 tools 允许列表**（没有它 Copilot 不加载该 server），我们投的一律给全量 ["*"]。
// env/timeout 无文档化字段，不硬造键；含空白的参数按 shell 习惯双引号包裹。

function copilotEntry(def: McpServerDef): Record<string, unknown> {
  if (def.transport === 'stdio') {
    const parts = [def.command as string, ...(def.args ?? [])].map((p) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p));
    return { type: 'local', command: parts.join(' '), tools: ['*'] };
  }
  const obj: Record<string, unknown> = { type: def.transport, url: def.url };
  if (def.headers && Object.keys(def.headers).length > 0) obj.headers = def.headers;
  obj.tools = ['*'];
  return obj;
}

// -------------------------------------------------------------------- 分派一处

/** 渲染一个 server 的条目文本；null = 该形态不支持这种 transport（目前只有 codex 的 sse）。def 须已解析 ${VAR}。 */
export function renderMcpEntry(style: McpTargetStyle, key: string, def: McpServerDef, pointer: string[]): string | null {
  switch (style) {
    case 'json-mcpServers':
      return JSON.stringify(claudeCompatEntry(def));
    case 'toml-codex':
      return tomlCodexEntry(key, def, pointer);
    case 'json-opencode':
      return JSON.stringify(opencodeEntry(def));
    case 'json-copilot':
      return JSON.stringify(copilotEntry(def));
  }
}

export interface McpRenderInput {
  style: McpTargetStyle;
  pointer: string[];
  /** 已过滤 tools、已解析 ${VAR} 的 server 资源 */
  servers: Resource[];
  /** 供 whichOn 查 PATH */
  env: NodeJS.ProcessEnv;
  /** 人类可读点面前缀（工具 label，如「Claude Code」）；只进 warning，绝不含值 */
  toolLabel: string;
  warnings: string[];
  platform?: NodeJS.Platform;
}

/**
 * 渲染整张条目表（key = server 名 —— mcp.ts 的 `^[a-z0-9][a-z0-9_-]*$` 保证它同时是合法 JSON 键
 * 和合法 TOML 裸表名）。requires 缺失或 codex 遇 sse → 该 server 跳过 + 点名（server 名 + 可执行名 / transport，
 * 不含任何已解析值），其余条目照常。
 */
export function renderMcpEntries(input: McpRenderInput): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const server of input.servers) {
    const def = mcpPayload(server);
    let missingBin: string | null = null;
    for (const bin of def.requires ?? []) {
      if (whichOn(bin, input.env, input.platform) === null) {
        missingBin = bin;
        break;
      }
    }
    if (missingBin !== null) {
      input.warnings.push(`${input.toolLabel}：server "${server.name}" 需要的可执行文件「${missingBin}」不在 PATH 上，本次跳过`);
      continue;
    }
    const text = renderMcpEntry(input.style, server.name, def, input.pointer);
    if (text === null) {
      input.warnings.push(`${input.toolLabel}：不支持 ${def.transport} transport，server "${server.name}" 本次跳过`);
      continue;
    }
    entries[server.name] = text;
  }
  return entries;
}
