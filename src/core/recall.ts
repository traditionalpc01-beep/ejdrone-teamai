import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { knowledgeDocsDir, knowledgeLearningsDir } from '../state.js';

/**
 * `ejdrone recall` 的扫描与打分（M8 / T8.1）。这里只有**读**与**算**，一个字节都不写。
 *
 * 三条冻结的形态（父计划 §2 范围表第 4 行、§3.5、§7.1），先说清为什么是这个形状：
 *
 * 1. **无索引**。15-25 人团队的 docs + learnings 在数百文件量级，全量扫描 <100ms；
 *    teamai 的 `SEARCH_INDEX_VERSION=7` / 域乘子 / hotness / vote / 去重键是为这个量级**以上**
 *    与采纳统计准备的，我们加了只会多一处会和磁盘打架的持久状态。所以本模块没有落盘缓存、
 *    没有 run id、没有投票计数 —— 想加的时候先回去看 §2 的「不做」表。
 * 2. **只读投递镜像** `~/.ejdrone/knowledge/{docs,learnings}`。namespace 过滤不在这里做第二遍：
 *    镜像里有什么，就是 `pull` 按角色裁决后该有什么。在这里再问一遍 `activeNamespaces` 等于造第二套
 *    真相源（角色改了但还没 pull 时，两边会给出不一样的答案）。
 * 3. **打分权重**：标题命中 ×3、frontmatter `tags` 命中 ×2、正文命中 ×1，取前 5 条。
 *    每条 term 对每个字段**最多计一次**（布尔命中），所以"正文里出现二十次"不会盖过"标题里出现一次" ——
 *    权重表达的是字段的可信度，不是出现频次。
 *
 * 匹配用**子串**而不是分词：中英文都工作，CJK 不需要词边界（`灰度发布` 命中 `灰度发布流程`），
 * 也不用为此带一个分词器。大小写不敏感。
 */

/** 字段权重（§7.1 冻结的三个乘子）。 */
export const WEIGHT_TITLE = 3;
export const WEIGHT_TAGS = 2;
export const WEIGHT_BODY = 1;

/** 一次最多返回几条（§2 范围表：输出前 5 条）。 */
export const RESULT_LIMIT = 5;

/**
 * `--check` 的相关度门槛。**2 = 至少命中一个 tag，或同一词在正文里出现于两个不同字段之外**。
 * 取 2 而不是 3 的理由：预检的目的是"别让人凭空开工"，正文级证据在数百文档的语料里已经足够指向一份
 * 具体文件；设成 3 会让只有正文提到的经验（learnings 的常态）永远判成 NOT_RELEVANT。
 * 不开放成命令行开关：门槛是这套打分的属性，不是用户的现场偏好（加了就等于承认打分不可信）。
 */
export const RELEVANCE_THRESHOLD = 2;

/** 命中片段上下取几行（输出形态在任务里冻结：路径 + 命中行 ±2 行）。 */
export const CONTEXT_LINES = 2;

export type MirrorKind = 'docs' | 'learnings';

/** 一份被读进内存的镜像文档。 */
export interface RecallDoc {
  kind: MirrorKind;
  /** 镜像里的绝对路径（报给成员的就是它，不回报仓库路径：成员看得到的是自己磁盘上的东西） */
  path: string;
  /** frontmatter `title` → 正文首个 `# ` 标题 → 文件名，逐级回退 */
  title: string;
  tags: string[];
  /** 去掉 frontmatter 的正文（打分用；片段仍按整文件行号取，成员能对着编辑器跳行） */
  body: string;
  /** 整文件按行切开（含 frontmatter 行） */
  lines: string[];
  /** 正文在 `lines` 里的起始下标：frontmatter 占掉的那几行行数（没有 frontmatter 就是 0） */
  contentOffset: number;
}

export interface RecallMatch {
  kind: MirrorKind;
  path: string;
  title: string;
  score: number;
  /** 片段中心行（1 基）：正文里的命中行；只在标题/tags 命中时是正文第一行（预览） */
  line: number;
  /** 片段第一行对应的行号（1 基）：文件开头不足 ±2 行时它小于 line-CONTEXT_LINES */
  contextStart: number;
  context: string[];
  /** 命中的词（按 query 里的顺序） */
  terms: string[];
}

export interface MirrorScan {
  docs: RecallDoc[];
  /** 根本不存在的镜像根（一个都没有 = 还没 pull 过） */
  missingRoots: string[];
}

export interface RecallOptions {
  limit?: number;
  threshold?: number;
}

export interface RecallOutcome {
  query: string;
  terms: string[];
  /** 参与打分的文档数 */
  scanned: number;
  results: RecallMatch[];
  /** 全场最高分（无命中为 0）—— `--check` 判的就是它 */
  score: number;
  threshold: number;
  relevant: boolean;
  missingRoots: string[];
}

// ------------------------------------------------------------------ query

/** 把 query 拆成检索词：空白分隔、转小写、去重，保序（保序让片段选行可复现）。 */
export function splitTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const term = raw.trim();
    if (term === '' || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

// ------------------------------------------------------------- frontmatter

const FM_OPEN_RE = /^---[ \t]*\r?\n/;

interface Frontmatter {
  title: string;
  tags: string[];
  body: string;
  /** 正文起始行下标（frontmatter 连同两围栏占掉的行数；没有 frontmatter 时是 0） */
  contentOffset: number;
}

/**
 * 取 frontmatter 的 title/tags 与正文。
 * 坏 YAML **不报错也不丢正文**：recall 是给人找资料的，一份 frontmatter 写坏的文档仍然应该被
 * 正文命中 —— 它缺的只是 tags 这一路加权。（对比：投递侧对解析失败要停发，那是另一条链路。）
 */
export function parseDoc(path: string, content: string, kind: MirrorKind): RecallDoc {
  const lines = content.split(/\r?\n/);
  const { title, tags, body, contentOffset } = readFrontmatter(content);
  return {
    kind,
    path,
    // title 逐级回退：frontmatter → 首个 `# ` 标题 → 文件名。第三条很重要，
    // 因为 `push --doc` 补出来的 frontmatter 用的是 name/description，不是 title。
    title: firstNonEmpty(title, firstHeading(lines), stripMd(basename(path))),
    tags,
    body,
    lines,
    contentOffset,
  };
}

function readFrontmatter(content: string): Frontmatter {
  const empty = { title: '', tags: [], body: content, contentOffset: 0 };
  const open = FM_OPEN_RE.exec(content);
  if (!open) return empty;
  const after = content.slice(open[0].length);
  const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(after);
  // 只有起始围栏没有结束围栏 = 不是 frontmatter（可能正文开头就想写一条 --- 分隔线），整篇当正文。
  if (!close) return empty;
  const fmText = after.slice(0, close.index);
  const body = after.slice(close.index + close[0].length);
  // 正文起始行 = 围栏区（开围栏 + frontmatter 文本 + 闭围栏）里的换行数
  const contentOffset = countNewlines(open[0] + fmText + close[0]);
  let doc: unknown;
  try {
    doc = fmText.trim() === '' ? {} : parseYaml(fmText);
  } catch {
    return { title: '', tags: [], body, contentOffset };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { title: '', tags: [], body, contentOffset };
  }
  const map = doc as Record<string, unknown>;
  return {
    title: typeof map.title === 'string' ? map.title.trim() : '',
    tags: readTags(map.tags),
    body,
    contentOffset,
  };
}

function countNewlines(text: string): number {
  return text.split('\n').length - 1;
}

/** tags 支持 `tags: [a, b]`、`tags: a, b`（标量按逗号拆）与 YAML 块列表；其余形状当没有。 */
function readTags(value: unknown): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    for (const piece of raw.split(',')) {
      const tag = piece.trim();
      if (tag !== '') out.push(tag);
    }
  };
  if (Array.isArray(value)) for (const item of value) push(item);
  else push(value);
  return out;
}

function firstHeading(lines: string[]): string {
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return '';
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) if (value.trim() !== '') return value;
  return '';
}

function stripMd(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

// ------------------------------------------------------------------ scoring

export interface DocScore {
  score: number;
  terms: string[];
}

/** 一条文档对 query 的得分：每条 term 在标题/tags/正文各布尔计一次，按权重累加。 */
export function scoreDoc(doc: RecallDoc, terms: string[]): DocScore {
  const title = doc.title.toLowerCase();
  const tags = doc.tags.map((t) => t.toLowerCase());
  const body = doc.body.toLowerCase();
  let score = 0;
  const hit: string[] = [];
  for (const term of terms) {
    let gained = 0;
    if (title.includes(term)) gained += WEIGHT_TITLE;
    if (tags.some((tag) => tag.includes(term))) gained += WEIGHT_TAGS;
    if (body.includes(term)) gained += WEIGHT_BODY;
    if (gained > 0) {
      score += gained;
      hit.push(term);
    }
  }
  return { score, terms: hit };
}

/**
 * 片段的中心行：**只在正文里找**第一个含任一命中词的行。
 * 为什么不去 frontmatter 里找：命中来自 title/tags 时，`title: Kafka 运维手册` 那一行本身就是
 * 结果里已经印出来的信息，把它当"上下文"等于给成员看了一行他自己刚搜到的词；这时更有用的是
 * 正文开头 —— 所以找不到正文命中行就退回正文第一行（预览），让成员判断"这份是不是我要的"。
 */
function pickLine(doc: RecallDoc, terms: string[]): number {
  for (let i = doc.contentOffset; i < doc.lines.length; i += 1) {
    const line = (doc.lines[i] ?? '').toLowerCase();
    if (terms.some((term) => line.includes(term))) return i;
  }
  return doc.contentOffset;
}

/** 以 center（0 基）为中心取 ±CONTEXT_LINES 行（靠近文件头/尾时自然截短）。 */
export function contextLines(lines: string[], center: number): string[] {
  if (lines.length === 0) return [];
  const from = Math.max(0, center - CONTEXT_LINES);
  const to = Math.min(lines.length - 1, center + CONTEXT_LINES);
  return lines.slice(from, to + 1);
}

/**
 * 打分并排序。同分时按路径字典序：并列名次必须有确定解，否则同一个镜像在两台机器上
 * 会给出不同顺序，`--check` 的分数一样但 --json 的逐条对比会漂。
 */
export function rankDocs(docs: RecallDoc[], query: string, limit = RESULT_LIMIT): RecallMatch[] {
  const terms = splitTerms(query);
  if (terms.length === 0) return [];
  const scored = docs
    .map((doc) => ({ doc, ...scoreDoc(doc, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.doc.path < b.doc.path ? -1 : 1));
  const top = scored.slice(0, Math.max(0, limit));
  return top.map(({ doc, score, terms: hit }) => {
    const center = pickLine(doc, hit);
    return {
      kind: doc.kind,
      path: doc.path,
      title: doc.title,
      score,
      line: center + 1,
      contextStart: Math.max(0, center - CONTEXT_LINES) + 1,
      context: contextLines(doc.lines, center),
      terms: hit,
    };
  });
}

/** 全场最高分（含未进前 5 的那些）：`--check` 问的是"有没有相关的"，不是"第一条是什么"。 */
export function topScore(docs: RecallDoc[], query: string): number {
  const terms = splitTerms(query);
  if (terms.length === 0) return 0;
  let best = 0;
  for (const doc of docs) {
    const { score } = scoreDoc(doc, terms);
    if (score > best) best = score;
  }
  return best;
}

// ------------------------------------------------------------------- 扫描

/** 只收 `.md` 普通文件，**符号链接一律不跟随**：镜像目录里出现软链就不是我们投的东西，
 * 跟着它能把检索范围跳到 `~/.ejdrone/knowledge` 之外（§10：写入/读取范围都得有据）。 */
function walk(dir: string, kind: MirrorKind, out: RecallDoc[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 再确认一次没跳出镜像根：正常写入不会产生这种形状，但镜像目录是成员磁盘上的东西，
      // 一个指向目录外的相对软链就足以让它跳出我们的读取范围。
      const rel = relative(dir, abs);
      if (rel.startsWith('..') || (rel !== '' && rel.startsWith(sep))) continue;
      walk(abs, kind, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === '.md') continue;
    let content: string;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // 读不出来的文件（权限/坏链接）跳过：recall 是查资料，不是体检
    }
    out.push(parseDoc(abs, content, kind));
  }
}

/** 两个镜像根目录（顺序固定：docs 在前，learnings 在后）。 */
export function mirrorRoots(env: NodeJS.ProcessEnv): Array<{ kind: MirrorKind; dir: string }> {
  return [
    { kind: 'docs', dir: knowledgeDocsDir(env) },
    { kind: 'learnings', dir: knowledgeLearningsDir(env) },
  ];
}

/** 把镜像里的文档全部读进内存（一次调用读一遍，没有缓存）。 */
export function scanMirror(env: NodeJS.ProcessEnv): MirrorScan {
  const docs: RecallDoc[] = [];
  const missingRoots: string[] = [];
  for (const { kind, dir } of mirrorRoots(env)) {
    if (!existsSync(dir)) {
      missingRoots.push(dir);
      continue;
    }
    walk(dir, kind, docs);
  }
  return { docs, missingRoots };
}

/**
 * 一次检索的全部工作：扫镜像 → 打分 → 取前 N。
 * 与 `rankDocs` 一样是**只读**函数（除 fs 读以外没有副作用），退出码与文案都留给 CLI 层。
 */
export function recallDocs(env: NodeJS.ProcessEnv, query: string, options: RecallOptions = {}): RecallOutcome {
  const limit = options.limit ?? RESULT_LIMIT;
  const threshold = options.threshold ?? RELEVANCE_THRESHOLD;
  const { docs, missingRoots } = scanMirror(env);
  const results = rankDocs(docs, query, limit);
  const score = topScore(docs, query);
  return {
    query,
    terms: splitTerms(query),
    scanned: docs.length,
    results,
    score,
    threshold,
    relevant: score >= threshold,
    missingRoots,
  };
}
