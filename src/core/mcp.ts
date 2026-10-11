import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { mcpPayload, type McpServerDef, type Resource } from './types.js';

/**
 * mcp/ 列表文件解析（设计文档 2.0 §3.1 / §3.2）。
 *
 * 两类失败严格分层，对应两种处置：
 * - **文件级**（fileError）：读不到、坏 YAML、顶层形状不对（缺 `servers:`、有未知顶层 key、
 *   `servers` 不是数组）。teamai 的教训：把 `servers:` 拼成 `server:` 或清空 `servers:` 后面内容
 *   若被当成"空集合"，会把全员已装的 server 整体删掉。所以 fileError 非空时本模块一条 server 都不发，
 *   调用方据此让 mcp kind 整体停发、已装内容不动。
 * - **条目级**（warnings）：单条 server 校验失败（未知 key、缺 transport 对应字段等）。
 *   跳过该条并点名文件与 key，其余条目照常。
 *
 * `${VAR}` 在这里**不解析**：Resource.payload 保持原文，渲染条目文本前才由 resolveMcpResources
 * 过 env（缺变量的 server 整条跳过并点名，已解析值永不进人类可读输出）。
 */

const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const serverEntrySchema = z
  .object({
    name: z.string().regex(SERVER_NAME_RE, 'name must match ^[a-z0-9][a-z0-9_-]*$'),
    description: z.string().optional(),
    transport: z.enum(['stdio', 'http', 'sse']),
    url: z.string().min(1).optional(),
    headers: z.record(z.string()).optional(),
    // teamai 源格式写 `timeout`，冻结契约字段是 `timeoutMs`；两种拼法都收，toServerDef 里归一。
    timeout: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    requires: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.transport === 'stdio') {
      if (entry.command === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'stdio server requires command' });
      }
    } else if (entry.url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `${entry.transport} server requires url`,
      });
    }
  });

type ServerEntry = z.infer<typeof serverEntrySchema>;

function toServerDef(e: ServerEntry): McpServerDef {
  const def: McpServerDef = { transport: e.transport };
  if (e.description !== undefined) def.description = e.description;
  if (e.url !== undefined) def.url = e.url;
  if (e.headers !== undefined) def.headers = e.headers;
  const timeoutMs = e.timeout ?? e.timeoutMs;
  if (timeoutMs !== undefined) def.timeoutMs = timeoutMs;
  if (e.command !== undefined) def.command = e.command;
  if (e.args !== undefined) def.args = e.args;
  if (e.env !== undefined) def.env = e.env;
  if (e.requires !== undefined) def.requires = e.requires;
  if (e.tools !== undefined) def.tools = e.tools;
  return def;
}

export interface McpCollection {
  servers: Resource[];
  warnings: string[];
  /** 非空 = mcp kind 整体停发（servers 恒为空数组，防止消费方忘了检查就把部分列表当全量投递） */
  fileError: string | null;
}

/** 报错用的条目定位：`servers[0] "gpu-analysis"`，name 不可用时退回下标。 */
function entryLabel(raw: unknown, index: number): string {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const name = (raw as Record<string, unknown>).name;
    if (typeof name === 'string' && name !== '') return `servers[${index}] "${name}"`;
  }
  return `servers[${index}]`;
}

function parseMcpFile(absPath: string, relPath: string, namespace: string): McpCollection {
  const fail = (error: string): McpCollection => ({ servers: [], warnings: [], fileError: error });

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (e) {
    return fail(`Cannot read MCP file (${absPath}): ${(e as Error).message}`);
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    return fail(`Invalid YAML in MCP file (${absPath}): ${(e as Error).message}`);
  }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return fail(`MCP file root must be a mapping with a "servers:" list (${absPath})`);
  }

  const record = doc as Record<string, unknown>;
  const extraKeys = Object.keys(record).filter((k) => k !== 'servers');
  const shapeProblems: string[] = [];
  if (!('servers' in record)) shapeProblems.push('missing "servers:" key');
  if (extraKeys.length > 0) shapeProblems.push(`unknown top-level key(s): ${extraKeys.join(', ')}`);
  if (shapeProblems.length > 0) {
    return fail(`Invalid MCP file (${absPath}): ${shapeProblems.join('; ')}`);
  }
  if (!Array.isArray(record.servers)) {
    // 也覆盖 `servers:`（键在、值空）——YAML 解析成 null，这不是"没有 server"，是写坏了。
    return fail(`Invalid MCP file (${absPath}): "servers" must be a list`);
  }

  const servers: Resource[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < record.servers.length; i++) {
    const entry = record.servers[i];
    const parsed = serverEntrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        warnings.push(
          `${relPath}: ${entryLabel(entry, i)}${key ? ` ${key}` : ''}: ${issue.message}; entry skipped`,
        );
      }
      continue;
    }
    servers.push({
      kind: 'mcp',
      namespace,
      name: parsed.data.name,
      files: {},
      payload: toServerDef(parsed.data),
    });
  }

  // 同一文件内重名没有"后者覆盖前者"的依据，选哪条都是猜 → 按文件级失败停发。
  const counts = new Map<string, number>();
  for (const s of servers) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  const dups = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
  if (dups.length > 0) {
    return fail(
      `Invalid MCP file (${absPath}): duplicate server name(s): ${dups.map((d) => `"${d}"`).join(', ')}`,
    );
  }

  return { servers, warnings, fileError: null };
}

/**
 * 读 `mcp/mcp.yaml` 与各 `mcp/<ns>/mcp.yaml`。
 * ns 目录只认 manifest 声明过的（与 resources.ts 同一套做法）；未声明的点名跳过、不解析。
 */
export function collectMcp(checkoutRoot: string, manifestNs: Set<string>): McpCollection {
  const mcpRoot = join(checkoutRoot, 'mcp');
  if (!existsSync(mcpRoot)) return { servers: [], warnings: [], fileError: null };

  const servers: Resource[] = [];
  const warnings: string[] = [];
  const fileErrors: string[] = [];
  const absorb = (r: McpCollection): void => {
    servers.push(...r.servers);
    warnings.push(...r.warnings);
    if (r.fileError !== null) fileErrors.push(r.fileError);
  };

  const rootFile = join(mcpRoot, 'mcp.yaml');
  if (existsSync(rootFile)) absorb(parseMcpFile(rootFile, 'mcp/mcp.yaml', ''));

  const entries = readdirSync(mcpRoot, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      warnings.push(`mcp/${e.name} is a symlink; skipped`);
      continue;
    }
    if (e.isFile()) {
      if (e.name !== 'mcp.yaml') {
        warnings.push(`mcp/${e.name} ignored: only mcp/mcp.yaml and mcp/<ns>/mcp.yaml are read`);
      }
      continue;
    }
    if (!e.isDirectory()) continue;
    if (!manifestNs.has(e.name)) {
      warnings.push(`mcp/${e.name} is not a declared namespace; skipped`);
      continue;
    }
    const nsFile = join(mcpRoot, e.name, 'mcp.yaml');
    // manifest 声明了但文件缺席 = 该 ns 空集，不告警（新目录缺席 = 该 kind 空集，§3.2）
    if (existsSync(nsFile)) absorb(parseMcpFile(nsFile, `mcp/${e.name}/mcp.yaml`, e.name));
  }

  if (fileErrors.length > 0) {
    return { servers: [], warnings, fileError: fileErrors.join('; ') };
  }
  return { servers, warnings, fileError: null };
}

// ------------------------------------------------------------------ ${VAR} 解析

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface ResolvedText {
  value: string;
  missing: string[];
}

/**
 * `${VAR}` 只从传入的 env 取（测试注入假 env，不读 process.env）。
 * 未定义的变量保留 `${NAME}` 原文并收进 missing——调用方必须丢弃该值，绝不能把
 * 占位符或空串写进投递文件。替换值原样写入、不做二次展开。
 */
export function resolveVars(text: string, env: NodeJS.ProcessEnv): ResolvedText {
  const missing: string[] = [];
  const value = text.replace(VAR_RE, (whole, name: string) => {
    const fromEnv = env[name];
    if (fromEnv === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return fromEnv;
  });
  return { value, missing };
}

export interface ResolvedServerDef {
  resolved: McpServerDef;
  missing: string[];
}

/** 渲染条目文本前的必经一步：payload 的每个字符串字段过 resolveVars。 */
export function resolveServerDef(def: McpServerDef, env: NodeJS.ProcessEnv): ResolvedServerDef {
  const missing: string[] = [];
  const s = (text: string): string => {
    const r = resolveVars(text, env);
    for (const m of r.missing) {
      if (!missing.includes(m)) missing.push(m);
    }
    return r.value;
  };
  const record = (src: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) out[k] = s(v);
    return out;
  };

  const resolved: McpServerDef = { transport: def.transport };
  if (def.description !== undefined) resolved.description = s(def.description);
  if (def.url !== undefined) resolved.url = s(def.url);
  if (def.headers !== undefined) resolved.headers = record(def.headers);
  if (def.timeoutMs !== undefined) resolved.timeoutMs = def.timeoutMs;
  if (def.command !== undefined) resolved.command = s(def.command);
  if (def.args !== undefined) resolved.args = def.args.map(s);
  if (def.env !== undefined) resolved.env = record(def.env);
  if (def.requires !== undefined) resolved.requires = def.requires.map(s);
  if (def.tools !== undefined) resolved.tools = def.tools.map(s);
  return { resolved, missing };
}

export interface ResolvedMcp {
  /** 变量齐全的资源，payload 已替换成明文 */
  servers: Resource[];
  /** 缺变量的整条跳过；name + 变量名，供上层点名（值绝不出现在这里） */
  skipped: Array<{ name: string; missing: string[] }>;
}

/** delivery/adapter 层消费入口：先过这里，再进条目渲染。 */
export function resolveMcpResources(servers: Resource[], env: NodeJS.ProcessEnv): ResolvedMcp {
  const out: Resource[] = [];
  const skipped: Array<{ name: string; missing: string[] }> = [];
  for (const resource of servers) {
    const { resolved, missing } = resolveServerDef(mcpPayload(resource), env);
    if (missing.length > 0) {
      skipped.push({ name: resource.name, missing });
      continue;
    }
    out.push({ ...resource, payload: resolved });
  }
  return { servers: out, skipped };
}
