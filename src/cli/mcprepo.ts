import { Document, YAMLSeq, isMap, isScalar, isSeq, parseDocument } from 'yaml';

import type { McpServerDef } from '../core/types.js';

/**
 * 仓库侧 `mcp/mcp.yaml` / `mcp/<ns>/mcp.yaml` 的编辑层（push --mcp / remove mcp 共用）。
 *
 * 为什么用 Document API 而不是 `stringify(parse(text))`：这两个文件是**成员手写的**，
 * 注释（"这条 server 是给谁用的"）与条目顺序是他们唯一的可读线索，整文件重排会把注释
 * 甩到别处甚至丢掉。`parseDocument` + 只动要动的那个节点，其余字节原样回吐。
 *
 * 认不出形状（顶层不是 mapping、`servers:` 缺失或不是列表、YAML 有错）时**一律拒绝改写并报错**，
 * 绝不"顺手修好"—— 那种文件交给 core/mcp.ts 的文件级失败语义（mcp 整体停发）比被工具重写安全。
 */

/** 仓库条目允许的键（与 core/mcp.ts 的 strict schema 同一套；键序即书写序）。 */
const ENTRY_KEYS = [
  'name',
  'description',
  'transport',
  'url',
  'headers',
  'timeout',
  'command',
  'args',
  'env',
  'requires',
  'tools',
  'tags',
] as const;

/** 一个 server 的条目在仓库文件里的书写形状（`def` → YAML 映射的键值表）。 */
export function defToEntry(name: string, def: McpServerDef): Record<string, unknown> {
  // 键序按 ENTRY_KEYS 的阅读习惯排：name → description → transport → 该 transport 的字段 → 公共字段。
  // 空数组 / 空映射不写（`args: []` 在评审里只是噪音）。
  const out: Record<string, unknown> = { name };
  if (def.description !== undefined) out.description = def.description;
  out.transport = def.transport;
  if (def.transport === 'stdio') {
    if (def.command !== undefined) out.command = def.command;
    if (def.args && def.args.length > 0) out.args = [...def.args];
    if (def.env && Object.keys(def.env).length > 0) out.env = { ...def.env };
  } else {
    if (def.url !== undefined) out.url = def.url;
    if (def.headers && Object.keys(def.headers).length > 0) out.headers = { ...def.headers };
  }
  if (def.timeoutMs !== undefined) out.timeout = def.timeoutMs;
  if (def.requires && def.requires.length > 0) out.requires = [...def.requires];
  if (def.tools && def.tools.length > 0) out.tools = [...def.tools];
  if (def.tags && def.tags.length > 0) out.tags = [...def.tags];
  return out;
}

export function mcpRepoFile(namespace: string): string {
  return namespace === '' ? 'mcp/mcp.yaml' : `mcp/${namespace}/mcp.yaml`;
}

/** 手写入库时的条目示例（错误文案里给，成员照着抄就行；不含任何真实值）。 */
export function entryShapeExample(name = 'my-server'): string {
  return [
    'servers:',
    `  - name: ${name}`,
    '    description: 一句话说明它干什么',
    '    transport: stdio            # stdio | http | sse',
    '    command: npx                # stdio 用',
    "    args: ['-y', '@acme/my-mcp']",
    '    env:',
    '      MY_TOKEN: ${MY_TOKEN}     # 凭据一律写成 ${VAR}，值只待在成员的环境变量里',
  ].join('\n');
}

export interface RepoEdit {
  ok: boolean;
  error?: string;
  text?: string;
  /** 只有 upsert 会填：区分"新增条目"与"就地更新已有条目"（MR 标题与文案要用） */
  action?: 'added' | 'updated';
}

interface Parsed {
  doc: Document;
  seq: YAMLSeq;
}

/** 解析并拿到 `servers` 序列；任何认不出的形状都拒绝（error 面向人，且点名文件）。 */
function openServers(text: string, file: string): Parsed | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { error: `${file} 不是合法 YAML：${doc.errors[0]?.message}` };
  }
  if (!isMap(doc.contents)) {
    return { error: `${file} 顶层必须是带 "servers:" 的映射，本工具不改写它` };
  }
  const seq = doc.get('servers', true);
  if (!isSeq(seq)) {
    return { error: `${file} 缺 "servers:" 列表（或它不是列表），本工具不改写这种文件` };
  }
  return { doc, seq };
}

function entryName(item: unknown): string | null {
  if (!isMap(item)) return null;
  const name = item.get('name', true);
  return isScalar(name) && typeof name.value === 'string' ? name.value : null;
}

function indexOfName(seq: YAMLSeq, name: string): number {
  for (let i = 0; i < seq.items.length; i++) {
    if (entryName(seq.items[i]) === name) return i;
  }
  return -1;
}

function newFileDoc(): Parsed {
  const doc = new Document();
  doc.commentBefore =
    ' 团队 MCP server：全员共享的放这个文件，只给某个角色的放 mcp/<namespace>/mcp.yaml。\n' +
    ' 凭据不要写明文，写成 ${变量名} —— pull 时从成员的环境变量里取。';
  const seq = new YAMLSeq();
  seq.flow = false;
  doc.set('servers', seq);
  return { doc, seq };
}

/**
 * 追加或就地更新一条 server（同名 = 就地更新，保留它原来的位置与注释）。
 * `text` 为 null = 文件还不存在 → 生成带头注释的新文件。
 *
 * `keep`：就地更新时**不要因为新条目没有就删掉**的键。反向采集只能还原本机文件里有的字段，
 * 而 `tools:` / `requires:` 是仓库侧的下发过滤器（各工具的 MCP 配置文件里根本没有这两个概念）——
 * 没有 keep 的话，成员重新 push 一条已在库的 server 会顺手把团队的过滤条件抹掉。
 */
export function upsertMcpServer(
  file: string,
  text: string | null,
  entry: Record<string, unknown>,
  keep: string[] = [],
): RepoEdit {
  let target: Parsed;
  if (text === null) {
    target = newFileDoc();
  } else {
    const opened = openServers(text, file);
    if ('error' in opened) return { ok: false, error: opened.error };
    target = opened;
  }
  const { doc, seq } = target;
  const name = entry.name;
  if (typeof name !== 'string' || name === '') return { ok: false, error: `${file}: 内部错误，条目缺 name` };

  const index = indexOfName(seq, name);
  if (index < 0) {
    seq.add(doc.createNode(entry));
  } else {
    const node = seq.items[index];
    if (!isMap(node)) return { ok: false, error: `${file} 里 servers[${index}] 不是映射，本工具不改写它` };
    for (const stale of ENTRY_KEYS) {
      if (stale in entry || keep.includes(stale)) continue;
      node.delete(stale);
    }
    for (const [key, value] of Object.entries(entry)) node.set(key, doc.createNode(value));
  }
  return { ok: true, text: doc.toString({ lineWidth: 0, indentSeq: true }), action: index < 0 ? 'added' : 'updated' };
}

export interface RemoveEdit extends RepoEdit {
  removed: string[];
  notFound: string[];
  /** 删完 servers 空了：调用方应把整个文件走删除（照 remove.ts 删文件的写法） */
  emptied: boolean;
}

export interface TagEdit extends RepoEdit {
  /** 编辑前的标签（新条目上是空数组）；文案层用来报「加了什么、删了什么」 */
  before: string[];
  /** false = 目标状态与现状一致，无需提交 */
  changed: boolean;
}

/**
 * 就地改一条 server 的 tags 字段（管理员 `tags add/remove` 用），其余键与注释字节不动。
 * tags 为 null 或空数组 = 删除该键。条目不存在或值不是字符串数组 → 拒绝改写。
 */
export function setMcpEntryTags(file: string, text: string, name: string, tags: string[] | null): TagEdit {
  const fail = (error: string): TagEdit => ({ ok: false, error, before: [], changed: false });
  const opened = openServers(text, file);
  if ('error' in opened) return fail(opened.error);
  const index = indexOfName(opened.seq, name);
  if (index < 0) return fail(`${file} 里没有 server「${name}」`);
  const node = opened.seq.items[index];
  if (!isMap(node)) return fail(`${file} 里 servers[${index}] 不是映射，本工具不改写它`);
  const current = node.get('tags', true);
  const before = isSeq(current)
    ? current.items
        .map((item) => (isScalar(item) && typeof item.value === 'string' ? (item.value as string) : null))
        .filter((v): v is string => v !== null)
    : current === undefined || current === null
      ? []
      : null;
  if (before === null) return fail(`${file} 里 server「${name}」的 tags 不是字符串数组，请先手工修正`);
  const wanted = tags !== null && tags.length > 0 ? tags : null;
  const same =
    (wanted === null && before.length === 0) ||
    (wanted !== null && wanted.length === before.length && wanted.every((t, i) => t === before[i]));
  if (same) return { ok: true, text, before, changed: false };
  if (wanted === null) node.delete('tags');
  else node.set('tags', opened.doc.createNode(wanted));
  return {
    ok: true,
    text: opened.doc.toString({ lineWidth: 0, indentSeq: true }),
    before,
    changed: true,
  };
}

/** 从文件里删掉若干条目（按 name）。一次编辑多个名字，避免逐条重解析。 */
export function deleteMcpServers(file: string, text: string, names: string[]): RemoveEdit {
  const opened = openServers(text, file);
  if ('error' in opened) {
    return { ok: false, error: opened.error, removed: [], notFound: names, emptied: false };
  }
  const { doc, seq } = opened;
  const removed: string[] = [];
  const notFound: string[] = [];
  for (const name of names) {
    const index = indexOfName(seq, name);
    if (index < 0) {
      notFound.push(name);
      continue;
    }
    seq.delete(index);
    removed.push(name);
  }
  const emptied = seq.items.length === 0;
  return {
    ok: true,
    text: doc.toString({ lineWidth: 0, indentSeq: true }),
    removed,
    notFound,
    emptied,
  };
}

// ------------------------------------------------------------ 疑似密钥改写

/** 键名判据（计划定的那条）：以 TOKEN / KEY / SECRET / PASSWORD 结尾。 */
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD)$/i;
/** 值形状判据的补充：这两类 header 按定义就是凭据，键名却不以它们结尾。 */
const CREDENTIAL_HEADER_RE = /^(proxy-)?authorization$/i;
/** 一眼像 token 的值（用于 command / args / url 的兜底，以及键名不成立的 env/headers 值）。 */
const CREDENTIAL_VALUE_RE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\bBasic\s+\S|(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{16,}|github_pat_[0-9A-Za-z_]{20,}|glpat-[0-9A-Za-z_-]{10,}|\bsk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|\bxox[baprs]-[0-9A-Za-z-]{10,})/;
/** url 的 query 里带凭据参数：整条命令/URL 我们不改写（改成 ${VAR} 会把地址一起吞掉），要求手写。 */
const SECRET_QUERY_RE = /[?&](?:key|token|secret|password)=/i;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 已经是占位符的值不用再改写（`${VAR}` 形式）。 */
const PLACEHOLDER_RE = /\$\{[^}]*\}/;

export interface SecretRewrite {
  /** env / headers */
  field: 'env' | 'headers';
  key: string;
  varName: string;
  /** true = 成员环境里已有同名变量，仓库直接引用它；false = 新造的名字，成员需要自己 export */
  reused: boolean;
}

export interface SecretBlockedField {
  /** command / args / url */
  field: 'command' | 'args' | 'url';
  reason: string;
}

export interface SecretScan {
  def: McpServerDef;
  rewrites: SecretRewrite[];
  /** 非空 = 这条 server 不能自动入库（不能把凭据写成命令行参数或 URL 查询串） */
  blocked: SecretBlockedField[];
}

function toIdentifier(value: string): string {
  const upper = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return /^[0-9]/.test(upper) ? `_${upper}` : upper;
}

function varNameFor(serverName: string, key: string, env: NodeJS.ProcessEnv): { name: string; reused: boolean } {
  // 计划定的顺序：成员环境里正好有同名变量就用它（round-trip 不用重新 export），否则造一个可读的新名
  const direct = key.trim();
  if (IDENT_RE.test(direct) && nonEmpty(env[direct])) return { name: direct, reused: true };
  const generated = `${toIdentifier(serverName)}_${toIdentifier(key)}`;
  if (nonEmpty(env[generated])) return { name: generated, reused: true };
  return { name: generated, reused: false };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '';
}

function externalizeRecord(
  record: Record<string, string> | undefined,
  field: 'env' | 'headers',
  serverName: string,
  env: NodeJS.ProcessEnv,
  rewrites: SecretRewrite[],
): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const looksSecret = SECRET_KEY_RE.test(key) || CREDENTIAL_HEADER_RE.test(key) || CREDENTIAL_VALUE_RE.test(value);
    if (!looksSecret || PLACEHOLDER_RE.test(value) || value === '') {
      out[key] = value;
      continue;
    }
    const { name, reused } = varNameFor(serverName, key, env);
    out[key] = `\${${name}}`;
    rewrites.push({ field, key, varName: name, reused });
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 疑似密钥值 → `${VAR}`，**不拒绝、也不静默提交明文**（M6 命令面决定 2）。
 * 判据除键名白名单外还补两条：`Authorization` 这类 header 按定义是凭据、值长得像 token 的一律算。
 * command / args / url 里的凭据不做改写（把整条命令换成 ${VAR} 会吞掉地址本身），
 * 交回成员手写：`blocked` 非空时调用方必须拒绝入库。
 * 已解析的值**永不进返回结构**，文案层只能拿到变量名与字段名。
 */
export function externalizeSecrets(def: McpServerDef, serverName: string, env: NodeJS.ProcessEnv): SecretScan {
  const rewrites: SecretRewrite[] = [];
  const blocked: SecretBlockedField[] = [];
  const out: McpServerDef = { ...def };

  if (out.command !== undefined && (CREDENTIAL_VALUE_RE.test(out.command) || SECRET_QUERY_RE.test(out.command))) {
    blocked.push({ field: 'command', reason: '命令里像带了凭据（token 参数或 URL 查询串）' });
  }
  (out.args ?? []).forEach((arg, index) => {
    if (CREDENTIAL_VALUE_RE.test(arg) || SECRET_QUERY_RE.test(arg)) {
      blocked.push({ field: 'args', reason: `args 第 ${index + 1} 个像带了凭据` });
    }
  });
  if (out.url !== undefined) {
    if (SECRET_QUERY_RE.test(out.url)) blocked.push({ field: 'url', reason: 'url 的查询串里像带了凭据参数' });
    else if (CREDENTIAL_VALUE_RE.test(out.url)) blocked.push({ field: 'url', reason: 'url 里像直接写了 token' });
  }

  const envOut = externalizeRecord(out.env, 'env', serverName, env, rewrites);
  if (envOut === undefined) delete out.env;
  else out.env = envOut;

  const headersOut = externalizeRecord(out.headers, 'headers', serverName, env, rewrites);
  if (headersOut === undefined) delete out.headers;
  else out.headers = headersOut;

  // 拒绝入库时把可疑字段整个摘掉：调用方的错误文案只许出现字段名，
  // 而返回结构会被 JSON.stringify 进调试输出/测试断言 —— 值留在里面迟早会漏出去。
  for (const b of blocked) {
    if (b.field === 'url') delete out.url;
    if (b.field === 'command') delete out.command;
    if (b.field === 'args') delete out.args;
  }
  return { def: out, rewrites, blocked };
}
