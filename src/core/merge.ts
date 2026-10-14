/**
 * 受管条目合并（2.0 计划 §3.3，M6 最大设计点）—— 纯函数模块：不读写文件系统、无运行时依赖。
 *
 * MCP 落点是成员在用的共享配置文件（~/.claude.json、~/.codex/config.toml、~/.qoder-cn/settings.json），
 * 整文件覆写不可接受。本模块只认领 pointer 指到的那一层里的"我方条目"，逐条执行 §3.3 六规则：
 *  1. 我方条目集合 = desired 的 keys；previous 来自账本 managedKeys（调用方注入）。
 *  2. 本次有、上次也有：文件里该条目的规范化文本与上次投递哈希相符 → 覆写；不相符 → 成员改过
 *     → kept(modified-locally)，不动。JSON 规范化 = 键排序后 stringify（格式化抖动不算"成员改过"）；
 *     TOML 按块原文逐字节（只归一尾随空行）。
 *  3. 本次没有、上次有：相符 → 删除该条目；不相符 → kept。
 *  4. 文件里有、两次都没有的键 → 成员的，永不触碰、永不重排（TOML 侧连注释和表顺序都逐字节不变）。
 *  5. current === null → 新建（内容只含我们的条目；权限收紧由 apply 层负责）。
 *     解析失败 / 结构对不上 / TOML 异形 → {ok:false,error}，调用方必须整体跳过且不落盘。
 *  6. previous 里没有、但 desired 的 key 在文件里已存在（成员自己写的同名条目）→ kept(foreign-entry)，
 *     不覆盖，除非 force（预留口子，force 命令未实现）。
 *
 * 红线（§10 / §3.3 规则 6）：error 文案里可以出现 key 与结构性描述，**永不**出现条目值或文件内容
 * （已解析的 ${VAR} 密钥就躺在里面）；JSON.parse 的异常原文也可能带内容片段，一律吞掉。
 *
 * 条目文本约定（T6.5 的 mcpfmt 必须照此产出）：
 *  - json：条目值的完整 JSON 文本（如 `{"command":"npx","args":[...]}`）。
 *  - toml：完整块，首个非空行必须是 `[<pointer 用 . 连接>.<key>]` 表头，块内其余表头只能是它的子表。
 */

import { createHash } from 'node:crypto';

export interface MergeInput {
  format: 'json' | 'toml';
  /** JSON 键路径，如 ['mcpServers']；TOML 时 pointer 用 '.' 拼成表名前缀 */
  pointer: string[];
  /** 磁盘现状，null = 文件不存在 */
  current: string | null;
  /** 上次我们投递的条目 key → 当时文本（按各自规范化口径）的哈希，来自 ledger.managedKeys */
  previous: Record<string, string>;
  /** 本次要投递的 key → 条目文本（已完成 ${VAR} 解析） */
  desired: Record<string, string>;
  /** 规则 6 的安全阀口子：true 时同名成员条目被我们的 desired 覆盖。apply 层目前永不设置；force 命令未实现。 */
  force?: boolean;
}

export interface MergeOutcome {
  ok: boolean;
  /** 只含 key 与结构性描述，绝不含条目值/文件内容 */
  error?: string;
  /** 写回整份文件的新内容；ok:false 或无实际增删改时不产出 */
  text?: string;
  changed?: boolean;
  /** key → 本次投递文本的哈希，写回 ledger.managedKeys */
  delivered?: Record<string, string>;
  written?: string[];
  removed?: string[];
  kept?: Array<{ key: string; reason: 'modified-locally' | 'foreign-entry' }>;
}

export type KeptEntry = { key: string; reason: 'modified-locally' | 'foreign-entry' };

// ------------------------------------------------------------------ 基础设施

function digest(s: string): string {
  // 与 core/ledger.ts 的 hashContent 同格式（那边带 fs 依赖，这边保持零 IO，各自一份五行实现）。
  return `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;
}

function fail(error: string): MergeOutcome {
  return { ok: false, error };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function okOutcome(
  text: string | undefined,
  changed: boolean,
  delivered: Record<string, string>,
  written: string[],
  removed: string[],
  kept: KeptEntry[],
): MergeOutcome {
  return { ok: true, text, changed, delivered, written, removed, kept };
}

/** JSON 条目的规范化文本：对象键递归排序后紧凑 stringify；数组保序。 */
function canonicalJsonValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonValue(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonValue(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

// -------------------------------------------------------------------- JSON

interface JsonFormat {
  indent: number;
  trailingNewline: boolean;
  /** 行尾跟原文件走：CRLF 文件每次 pull 被整体翻成 LF = 成员字节被动，卸载还原也不成立。 */
  crlf: boolean;
}

/** 行尾探测：CRLF 行数不少于孤立 LF 行数才算 CRLF 文件（混合文件取多数，纯 LF 永远是 LF）。 */
function usesCrlf(raw: string): boolean {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const loneLf = (raw.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > 0 && crlf >= loneLf;
}

/** 与 hooks.ts 同一思路：缩进、结尾换行、行尾都跟着原文件走，卸载/重写后能回到成员原来的样子。 */
function detectJsonFormat(raw: string): JsonFormat {
  const firstIndent = /^ {2,}/m.exec(raw)?.[0].length;
  return { indent: firstIndent ?? 2, trailingNewline: raw.endsWith('\n'), crlf: usesCrlf(raw) };
}

function renderJson(doc: unknown, format: JsonFormat): string {
  const text = JSON.stringify(doc, null, format.indent);
  const withEnd = format.trailingNewline ? `${text}\n` : text;
  // JSON.stringify 的字符串值里不会有裸换行（都被转义成 \n 两个字符），这里的 \n 全是
  // 结构性换行，整体替换不会误伤值内容；对已经 CRLF 的输入 replace 幂等。
  return format.crlf ? withEnd.replace(/\n/g, '\r\n') : withEnd;
}

function mergeJson(input: MergeInput): MergeOutcome {
  const pointer = input.pointer;
  if (pointer.length === 0) return fail('json pointer must not be empty');

  let doc: Record<string, unknown>;
  let format: JsonFormat;
  if (input.current === null) {
    doc = {};
    format = { indent: 2, trailingNewline: true, crlf: false };
  } else {
    format = detectJsonFormat(input.current);
    if (input.current.trim() === '') {
      doc = {};
      // 空文件没有格式可继承：按我们新建文件的约定（2 空格 + 结尾换行）
      format = { indent: 2, trailingNewline: true, crlf: false };
    } else {
      let parsed: unknown;
      try {
        // 吞掉异常原文：V8 报错会带内容片段，里面可能有已解析的密钥。
        parsed = JSON.parse(input.current);
      } catch {
        return fail('file is not valid JSON');
      }
      if (!isPlainObject(parsed)) return fail('file root is not a JSON object');
      doc = parsed;
    }
  }

  const desired = input.desired;
  const previous = input.previous;
  const desiredKeys = Object.keys(desired);
  const previousKeys = Object.keys(previous);

  // 本次没有条目要投、账本上也没有旧账：一个字都不写（连 pointer 层都不新建）。
  if (desiredKeys.length === 0 && previousKeys.length === 0) {
    return okOutcome(undefined, false, {}, [], [], []);
  }

  // 走到这里才把 pointer 层建/取出来（中途结构对不上就 ok:false）。
  let layer = doc;
  let parent: Record<string, unknown> = doc;
  for (let i = 0; i < pointer.length; i += 1) {
    const seg = pointer[i] as string;
    if (i === pointer.length - 1) {
      const raw = parent[seg];
      if (raw === undefined) {
        layer = {};
        parent[seg] = layer;
      } else if (isPlainObject(raw)) {
        layer = raw;
      } else {
        return fail(`entry layer "${pointer.join('.')}" is not a JSON object`);
      }
      break;
    }
    const next = parent[seg];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      parent[seg] = fresh;
      parent = fresh;
      continue;
    }
    if (!isPlainObject(next)) return fail(`pointer segment "${seg}" is not a JSON object`);
    parent = next;
  }

  const parsedDesired: Record<string, unknown> = {};
  const desiredHash: Record<string, string> = {};
  for (const key of desiredKeys) {
    let value: unknown;
    try {
      value = JSON.parse(desired[key] as string);
    } catch {
      // 只点名 key：条目文本里可能有已解析的 ${VAR} 值。
      return fail(`entry "${key}" is not valid JSON`);
    }
    parsedDesired[key] = value;
    desiredHash[key] = digest(canonicalJsonValue(value));
  }

  const delivered: Record<string, string> = {};
  const written: string[] = [];
  const removed: string[] = [];
  const kept: KeptEntry[] = [];

  // 规则 3：上次有、本次没有。
  for (const key of previousKeys) {
    if (has(desired, key)) continue;
    if (!has(layer, key)) continue; // 成员已经删掉了：忘掉这笔账即可
    const currentHash = digest(canonicalJsonValue(layer[key]));
    if (currentHash === previous[key]) {
      delete layer[key];
      removed.push(key);
    } else {
      kept.push({ key, reason: 'modified-locally' });
      delivered[key] = previous[key] as string; // 仍是我们的条目，只是成员改过：保留旧哈希继续追踪
    }
  }

  // 规则 2 / 6。
  for (const key of desiredKeys) {
    const inLayer = has(layer, key);
    const inPrevious = has(previous, key);
    if (!inPrevious && inLayer && !input.force) {
      kept.push({ key, reason: 'foreign-entry' });
      continue;
    }
    if (inPrevious && inLayer) {
      const currentHash = digest(canonicalJsonValue(layer[key]));
      if (currentHash !== previous[key]) {
        kept.push({ key, reason: 'modified-locally' });
        delivered[key] = previous[key] as string;
        continue;
      }
    }
    layer[key] = parsedDesired[key];
    written.push(key);
    delivered[key] = desiredHash[key] as string;
  }

  if (written.length === 0 && removed.length === 0) {
    // 没有任何增删改：整份文件逐字节保持（成员的格式也不做归一）。
    return okOutcome(undefined, false, delivered, [], [], kept);
  }
  const text = renderJson(doc, format);
  const changed = input.current === null || text !== input.current;
  return okOutcome(text, changed, delivered, written, removed, kept);
}

// -------------------------------------------------------------------- TOML

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;
const TOML_QUOTED_BASIC = /^"([^"]*)"$/;
const TOML_QUOTED_LITERAL = /^'([^']*)'$/;

/**
 * 逐行状态机：识别表头/赋值/注释/空行，并检查字符串与括号平衡。
 * 行尾仍有未闭合的引号或括号 → 异形（多行字符串、多行内联表、跨行数组我们都不处理）。
 * 返回值里 reject 非空 = 认不出，宁可不投。
 */
interface TomlLineInfo {
  kind: 'blank' | 'comment' | 'header' | 'assign';
  headerPath?: string; // 表头原文路径（段保留引号形态，仅用于展示/唯一性）
  headerSegs?: string[]; // 去引号段，供归属比对
  assignSegs?: string[]; // 赋值键去引号段
  reject?: string;
}

function parseKeySegment(seg: string): string | null {
  const t = seg.trim();
  if (t === '') return null;
  if (TOML_BARE_KEY.test(t)) return t;
  const bq = TOML_QUOTED_BASIC.exec(t);
  if (bq && !(bq[1] ?? '').includes('\\')) return bq[1] as string;
  const lq = TOML_QUOTED_LITERAL.exec(t);
  if (lq) return lq[1] as string;
  return null;
}

/** 点分键路径切分：引号内的点不是分隔符（`"gpt-3.5" = …` 是真机 codex 里存在的成员写法）。 */
function splitKeyPath(text: string): string[] | null {
  const segs: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '.') {
      const parsed = parseKeySegment(current);
      if (parsed === null) return null;
      segs.push(parsed);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  const parsed = parseKeySegment(current);
  if (parsed === null) return null;
  segs.push(parsed);
  return segs;
}

function classifyTomlLine(line: string): TomlLineInfo {
  const trimmedAll = line.trim();
  if (trimmedAll === '') return { kind: 'blank' };
  if (trimmedAll.startsWith('#')) return { kind: 'comment' };

  let significant = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depthSquare = 0;
  let depthCurly = 0;
  let assignEq = -1;
  for (const ch of line) {
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quote = null;
      significant += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      significant += ch;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      significant += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      significant += ch;
      continue;
    }
    if (ch === '#') break; // 注释：后面全丢
    if (ch === '[') depthSquare += 1;
    if (ch === ']') depthSquare -= 1;
    if (ch === '{') depthCurly += 1;
    if (ch === '}') depthCurly -= 1;
    if (depthSquare < 0 || depthCurly < 0) return { kind: 'assign', reject: 'unbalanced brackets' };
    if (ch === '=' && depthSquare === 0 && depthCurly === 0 && assignEq < 0) assignEq = significant.length;
    significant += ch;
  }
  if (quote !== null || escaped) {
    return { kind: 'assign', reject: 'unbalanced quotes' };
  }
  if (depthSquare !== 0 || depthCurly !== 0) {
    return { kind: 'assign', reject: 'unbalanced brackets' };
  }

  const sig = significant.trim();
  if (sig === '') return { kind: 'comment' }; // 只剩注释

  if (sig.startsWith('[[')) return { kind: 'header', reject: 'array-of-tables ([[...]]) is not supported' };
  if (sig.startsWith('[')) {
    const m = /^\[([^\[\]]*)\](.*)$/.exec(sig);
    if (!m || (m[2] ?? '').trim() !== '') return { kind: 'header', reject: 'unknown table header shape' };
    const segs = splitKeyPath((m[1] ?? '').trim());
    if (!segs || segs.length === 0) return { kind: 'header', reject: 'unknown table header shape' };
    return { kind: 'header', headerPath: segs.join('.'), headerSegs: segs };
  }

  if (assignEq < 0) return { kind: 'assign', reject: 'line is neither a header nor an assignment' };
  const left = sig.slice(0, assignEq).trim();
  const right = sig.slice(assignEq + 1).trim();
  if (right === '') return { kind: 'assign', reject: 'assignment without a value' };
  const assignSegs = splitKeyPath(left);
  if (!assignSegs || assignSegs.length === 0) return { kind: 'assign', reject: 'unknown key shape' };
  return { kind: 'assign', assignSegs };
}

interface TomlBlock {
  /** 表头行下标 */
  start: number;
  /** 下一个"非子表"表头的行下标（exclusive） */
  end: number;
  /** 块体最后一行（含）的下标：尾随空行不计入 */
  contentEnd: number;
  /** 表头去引号段 */
  segs: string[];
}

interface TomlScan {
  ok: boolean;
  error?: string;
  lines: string[];
  /** 全部表头行下标（升序） */
  headers: number[];
  /** 前缀下我方可认领的条目块（prefix === null 时为空，仅供审计另查） */
  blocks: Map<string, TomlBlock>;
}

function isDescendantOf(path: string[], base: string[]): boolean {
  if (path.length <= base.length) return false;
  return base.every((seg, i) => path[i] === seg);
}

function lastContentLine(lines: string[], from: number, to: number): number {
  let e = Math.min(to, lines.length - 1);
  while (e > from && (lines[e] ?? '').trim() === '') e -= 1;
  return e;
}

function blockCanonical(lines: string[], block: TomlBlock): string {
  let e = block.contentEnd;
  while (e > block.start && (lines[e] ?? '').trim() === '') e -= 1;
  // 行尾的 \r 剥掉：CRLF 成员文件里"我们投的那份"的规范化文本必须与行尾无关，
  // 否则 CRLF 文件每次 pull 都被判 modified-locally（永远无法幂等），账本核对（tomlEntryHashes
  // 复用本函数）也会误报。行尾归一行尾的账（渲染出口的 CRLF 还原）由 mergeToml 的输出归一负责。
  return `${lines
    .slice(block.start, e + 1)
    .map((l) => l.replace(/\r$/, ''))
    .join('\n')}\n`;
}

/**
 * 全文扫描。异形清单（任何一条命中都 ok:false，宁可不投）：
 *  - `[[数组表]]`；
 *  - 内联表/普通键住在条目命名空间：根级点键 `mcp_servers.x = …`、`[mcp_servers]` 本体下有任何赋值
 *    （含 `mcp_servers = {…}` 整表内联）；
 *  - 引号/括号不平衡（多行字符串、跨行数组、多行内联表）；
 *  - 认不出的表头或键形态（转义引号键等）；既非表头也非赋值的行；
 *  - 同一表重复声明、同一 `前缀.<key>` 条目块重复出现。
 */
function tomlScan(text: string, prefixSegs: string[] | null): TomlScan {
  const lines = text.split('\n');
  const headers: number[] = [];
  const blocks = new Map<string, TomlBlock>();
  const bad = (error: string): TomlScan => ({ ok: false, error, lines, headers, blocks });
  const prefixStr = prefixSegs ? prefixSegs.join('.') : null;

  let currentTable: string[] = [];
  let inPrefixTable = false;
  let open: { key: string; start: number; segs: string[] } | null = null;
  const seenTables = new Set<string>();

  const closeOpen = (endIdx: number): void => {
    if (!open) return;
    blocks.set(open.key, {
      start: open.start,
      end: endIdx,
      contentEnd: lastContentLine(lines, open.start, endIdx - 1),
      segs: open.segs,
    });
    open = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const info = classifyTomlLine(lines[i] as string);
    if (info.reject) return bad(`file is not in the expected TOML shape: ${info.reject}`);
    if (info.kind === 'blank' || info.kind === 'comment') continue;

    if (info.kind === 'header') {
      const path = info.headerSegs as string[];
      const pathStr = path.join('.');
      if (seenTables.has(pathStr)) return bad('a table is declared more than once');
      seenTables.add(pathStr);
      headers.push(i);
      // 子表头先归因：还挂在未关闭的条目块上就不关闭它（`[mcp_servers.x.env]` 属于 x 的块）。
      if (open && isDescendantOf(path, open.segs)) {
        currentTable = path;
        continue;
      }
      closeOpen(i);
      inPrefixTable = false;
      currentTable = path;
      if (prefixStr && pathStr === prefixStr) {
        inPrefixTable = true;
        continue;
      }
      if (prefixStr && pathStr.startsWith(`${prefixStr}.`)) {
        const rest = path.slice((prefixSegs as string[]).length);
        const topKey = rest[0] as string;
        if (rest.length > 1) {
          const known = blocks.get(topKey);
          if (known && isDescendantOf(path, known.segs)) continue; // 已关闭块后又写子表：TOML 本来就非法，保守放行不认领
          return bad('a subtable appears without its parent entry table');
        }
        if (!TOML_BARE_KEY.test(topKey)) return bad('entry table name is not a bare key');
        if (blocks.has(topKey)) return bad('entry table is declared more than once');
        open = { key: topKey, start: i, segs: path };
      }
      continue;
    }

    // 赋值行
    if (inPrefixTable) return bad('mcp entries appear as plain keys or inline tables under the prefix table');
    const segs = info.assignSegs as string[];
    if (prefixStr && currentTable.length === 0) {
      const touches = segs.length >= (prefixSegs as string[]).length && (prefixSegs as string[]).every((s, j) => segs[j] === s);
      if (touches) return bad('mcp entries appear as root dotted keys instead of [prefix.name] tables');
    }
  }
  closeOpen(lines.length);
  return { ok: true, lines, headers, blocks };
}

/** 校验并规范化一个 desired 条目块；返回块行数组（不含尾随空行）。 */
function tomlBlockLines(key: string, prefixStr: string, text: string): string[] | { error: string } {
  const raw = text.split('\n');
  let s = 0;
  let e = raw.length - 1;
  while (s <= e && (raw[s] ?? '').trim() === '') s += 1;
  while (e >= s && (raw[e] ?? '').trim() === '') e -= 1;
  const lines = raw.slice(s, e + 1);
  if (lines.length === 0) return { error: `block for "${key}" is empty` };
  for (let idx = 0; idx < lines.length; idx += 1) {
    const info = classifyTomlLine(lines[idx] as string);
    if (info.reject) return { error: `block for "${key}" is not in the expected TOML shape: ${info.reject}` };
    if (info.kind === 'header') {
      const path = (info.headerSegs as string[]).join('.');
      if (idx === 0) {
        if (path !== `${prefixStr}.${key}`) return { error: `block for "${key}" must start with table header [${prefixStr}.${key}]` };
      } else if (!path.startsWith(`${prefixStr}.${key}.`)) {
        return { error: `block for "${key}" contains a table that does not belong to it` };
      }
    }
  }
  return lines;
}

function canonicalTomlBlockText(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function mergeToml(input: MergeInput): MergeOutcome {
  const pointer = input.pointer;
  if (pointer.length === 0 || !pointer.every((seg) => TOML_BARE_KEY.test(seg))) {
    return fail('toml pointer must be non-empty bare table path segments');
  }
  const prefixStr = pointer.join('.');
  const desired = input.desired;
  const previous = input.previous;
  const desiredKeys = Object.keys(desired);
  const previousKeys = Object.keys(previous);
  for (const key of [...desiredKeys, ...previousKeys]) {
    if (!TOML_BARE_KEY.test(key)) return fail(`entry key "${key}" is not a bare TOML table name`);
  }

  if (desiredKeys.length === 0 && previousKeys.length === 0) {
    return okOutcome(undefined, false, {}, [], [], []);
  }

  // desired 块先全部验完再动任何字节（写前算完整原则）。
  const desiredLines = new Map<string, string[]>();
  const desiredHash: Record<string, string> = {};
  for (const key of desiredKeys) {
    const block = tomlBlockLines(key, prefixStr, desired[key] as string);
    if (!Array.isArray(block)) return fail(block.error);
    desiredLines.set(key, block);
    desiredHash[key] = digest(canonicalTomlBlockText(block));
  }

  const delivered: Record<string, string> = {};
  const written: string[] = [];
  const removed: string[] = [];
  const kept: KeptEntry[] = [];

  // 新建（规则 5）：内容只含我们的条目，块序 = desired 键序，空行分隔，结尾带换行。
  // 存在但全空的文件同样按新建处理（成员没写过任何字节）。
  if (input.current === null || input.current.trim() === '') {
    if (desiredKeys.length === 0) {
      // 没有要投的、也没文件：上次的键已无处可删，直接 forget。
      return okOutcome(undefined, false, {}, [], [], []);
    }
    const chunks: string[] = [];
    for (const key of desiredKeys) {
      chunks.push(canonicalTomlBlockText(desiredLines.get(key) as string[]));
      delivered[key] = desiredHash[key] as string;
      written.push(key);
    }
    return okOutcome(chunks.join('\n'), true, delivered, written, [], kept);
  }

  const scan = tomlScan(input.current, pointer);
  if (!scan.ok) return fail(scan.error as string);
  const lines = scan.lines;
  const blocks = scan.blocks;

  const removeRanges: Array<{ start: number; end: number }> = [];
  const replaceMap = new Map<string, string[]>();
  const insertKeys: string[] = [];

  // 规则 3。
  for (const key of previousKeys) {
    if (has(desired, key)) continue;
    const block = blocks.get(key);
    if (!block) continue; // 成员已经删了：记完账即可
    if (digest(blockCanonical(lines, block)) === previous[key]) {
      removeRanges.push({ start: block.start, end: block.contentEnd + 1 });
      removed.push(key);
    } else {
      kept.push({ key, reason: 'modified-locally' });
      delivered[key] = previous[key] as string;
    }
  }

  // 规则 2 / 6。
  for (const key of desiredKeys) {
    const block = blocks.get(key);
    const inPrevious = has(previous, key);
    if (block && !inPrevious && !input.force) {
      kept.push({ key, reason: 'foreign-entry' });
      continue;
    }
    if (block && inPrevious) {
      if (digest(blockCanonical(lines, block)) !== previous[key]) {
        kept.push({ key, reason: 'modified-locally' });
        delivered[key] = previous[key] as string;
        continue;
      }
      replaceMap.set(key, desiredLines.get(key) as string[]);
      delivered[key] = desiredHash[key] as string;
      written.push(key);
      continue;
    }
    insertKeys.push(key);
    delivered[key] = desiredHash[key] as string;
    written.push(key);
  }

  if (written.length === 0 && removed.length === 0) {
    return okOutcome(undefined, false, delivered, [], [], kept);
  }

  // 插入点：最后一个"未被删除的前缀块"的下一行（即其后第一个非前缀表头行）；
  // 没有前缀块就落在文件末尾（结尾换行的空标记之前）。
  const removedStarts = new Set(removeRanges.map((r) => r.start));
  let insertAt = -1;
  for (const block of blocks.values()) {
    if (removedStarts.has(block.start)) continue;
    if (insertAt < 0 || block.end > insertAt) insertAt = block.end;
  }
  if (insertAt < 0) {
    const trailingMarker = lines.length > 1 && (lines[lines.length - 1] ?? '') === '';
    insertAt = trailingMarker ? lines.length - 1 : lines.length;
  } else if (insertAt >= lines.length) {
    // 最后一个块到 EOF：插进结尾换行的空标记之前，保住成员文件的结尾换行
    if (lines.length > 1 && (lines[lines.length - 1] ?? '') === '') insertAt = lines.length - 1;
  }

  const blockByStart = new Map<number, { key: string; block: TomlBlock }>();
  for (const [key, block] of blocks) blockByStart.set(block.start, { key, block });
  const removeByStart = new Map<number, number>();
  for (const r of removeRanges) removeByStart.set(r.start, r.end);

  const out: string[] = [];
  const ensureBlankBefore = (): void => {
    if (out.length > 0 && (out[out.length - 1] ?? '').trim() !== '') out.push('');
  };
  let inserted = false;
  const emitInserts = (nextLine: string | undefined): void => {
    if (inserted || insertKeys.length === 0) return;
    inserted = true;
    for (const key of insertKeys) {
      ensureBlankBefore();
      out.push(...(desiredLines.get(key) as string[]));
    }
    // 我们的块和紧随其后的非空行隔一个空行；原本就有空行则不重复加
    if (nextLine !== undefined && nextLine.trim() !== '') out.push('');
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (i === insertAt) emitInserts(lines[i]);
    const entry = blockByStart.get(i);
    if (entry) {
      const delEnd = removeByStart.get(i);
      if (delEnd !== undefined) {
        i = delEnd;
        // 被删块前后的空行会叠成两个：尾随空行吃掉一个
        if ((out[out.length - 1] ?? '').trim() === '' && (lines[i] ?? '').trim() === '' && i < n) i += 1;
        continue;
      }
      const replacement = replaceMap.get(entry.key);
      if (replacement) {
        out.push(...replacement);
        i = entry.block.contentEnd + 1;
        continue;
      }
    }
    out.push(lines[i] as string);
    i += 1;
  }
  emitInserts(undefined);

  const joined = out.join('\n');
  // 行尾跟原文件走：成员 CRLF 文件里我们插入/替换的块（LF 行）也要还原成 CRLF，
  // 否则成员字节被改、二次 pull 不幂等。split('\n') 保留的成员行 \r 对 replace 幂等；
  // 纯 LF 文件不动。usesCrlf 取多数行尾，混合文件以多数为准（与 detectJsonFormat 同口径）。
  const text = usesCrlf(input.current) ? joined.replace(/\r?\n/g, '\r\n') : joined;
  const changed = text !== input.current;
  return okOutcome(text, changed, delivered, written, removed, kept);
}

// ------------------------------------------------------------------ 入口

export function mergeEntries(input: MergeInput): MergeOutcome {
  if (input.format === 'json') return mergeJson(input);
  if (input.format === 'toml') return mergeToml(input);
  throw new TypeError(`mergeEntries: unknown format "${String(input.format)}"`);
}

// ------------------------------------------------- 账本核对（ledgercheck 用）

/**
 * 只读地取回各条目"现在在文件里的规范化文本哈希"；取不到/认不出 → null（核对侧记为本地改过）。
 * 与 mergeEntries 共用同一套解析与规范化 —— "是不是我们投的那份"在两处必须是同一个结论。
 * 账本不存 format/pointer，调用方按文件扩展名给出 format；条目键本身够定位。
 */
export function currentEntryHashes(
  format: 'json' | 'toml',
  text: string | null,
  keys: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = null;
  if (text === null || keys.length === 0) return out;
  if (format === 'json') return jsonEntryHashes(text, keys, out);
  return tomlEntryHashes(text, keys, out);
}

/** 前缀未知：按"包含最多我方键的对象层"定位（浅者优先）；层里没有的键记 null。 */
function jsonEntryHashes(text: string, keys: string[], out: Record<string, string | null>): Record<string, string | null> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  let best: Record<string, unknown> | null = null;
  let bestCount = 0;
  const queue: unknown[] = [doc];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!isPlainObject(node)) continue;
    let count = 0;
    for (const key of keys) {
      if (has(node, key)) count += 1;
    }
    if (count > bestCount) {
      best = node;
      bestCount = count;
    }
    for (const value of Object.values(node)) {
      if (isPlainObject(value)) queue.push(value);
    }
  }
  if (!best) return out;
  for (const key of keys) {
    if (has(best, key)) out[key] = digest(canonicalJsonValue(best[key]));
  }
  return out;
}

/** 前缀未知：按表头最后一段认条目键；任何键有多个同名候选或全文异形 → 全部记 null。 */
function tomlEntryHashes(text: string, keys: string[], out: Record<string, string | null>): Record<string, string | null> {
  const scan = tomlScan(text, null); // 全文异形检查照做
  if (!scan.ok) return out;
  const keySet = new Set(keys);
  const candidates = new Map<string, number[]>(); // key → 表头行下标列表
  for (const lineIdx of scan.headers) {
    const info = classifyTomlLine(scan.lines[lineIdx] as string);
    if (info.kind !== 'header' || !info.headerSegs || info.headerSegs.length < 2) continue; // 只认 [x.<name>]，裸 [<name>] 不是条目
    const last = info.headerSegs[info.headerSegs.length - 1] as string;
    if (!keySet.has(last)) continue;
    const list = candidates.get(last) ?? [];
    list.push(lineIdx);
    candidates.set(last, list);
  }
  for (const list of candidates.values()) {
    if (list.length !== 1) return out; // 同名多处理解不了：整条记改过
  }
  for (const [key, list] of candidates) {
    const start = list[0] as number;
    const info = classifyTomlLine(scan.lines[start] as string);
    const segs = info.headerSegs as string[];
    let end = scan.lines.length;
    for (const lineIdx of scan.headers) {
      if (lineIdx <= start) continue;
      const nextInfo = classifyTomlLine(scan.lines[lineIdx] as string);
      if (nextInfo.kind !== 'header' || !nextInfo.headerSegs) continue;
      if (!isDescendantOf(nextInfo.headerSegs, segs)) {
        end = lineIdx;
        break;
      }
    }
    const contentEnd = lastContentLine(scan.lines, start, end - 1);
    out[key] = digest(blockCanonical(scan.lines, { start, end, contentEnd, segs }));
  }
  return out;
}
