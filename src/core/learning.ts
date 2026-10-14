import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Resource } from './types.js';

/**
 * learning 文件的规范化（M9 / T9.1）：frontmatter 补全、slug 与仓库内文件名生成、撞名判据。
 * 这里只有**读与算**——一个字节都不写，落库（MR）由 `cli/contribute.ts` 复用 push 管线完成。
 *
 * 两条与 teamai 的有意偏差（父计划 §7.1，别再改回去）：
 *
 * 1. **缺 tags 不拒绝**。teamai 必填 title/author/date/tags 且 tags 须 2–5 个，硬校验会让第一次
 *    贡献卡在格式上；我们靠 MR 评审补，这里只做「能补则补」：title 从 --title / frontmatter /
 *    正文首个 `# ` 标题 / 文件名逐级回退，date 从 frontmatter / 文件名日期前缀 / 当天回退。
 * 2. **不加 rand6**。teamai 的 `<slug>-<date>-<rand6>` 是为免评审孤儿分支的追加写准备的；我们走 MR，
 *    撞名会在评审里现形——所以目标路径已存在时**拒绝并提示改名**，文件名保持可引用。
 */

/** slug 长度上限（字符数）；中英文一视同仁，避免文件名失控。 */
export const SLUG_MAX_LENGTH = 48;

/** learnings/ 下禁止使用的 namespace 名（与 resources.ts 的 docs 保留名同名同因：给 2.1 留保险）。 */
export const RESERVED_LEARNINGS_NAMESPACE = 'team-codebase';

export interface LearningInput {
  /** 成员文件的完整原文 */
  raw: string;
  /** 成员文件名（basename，含扩展名）：title/date 的回退来源 */
  fileName?: string;
  /** --title 显式覆盖，优先级最高 */
  titleOverride?: string;
  /** 注入时钟（测试用）；缺省 new Date() */
  now?: () => Date;
}

export interface NormalizedLearning {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  tags: string[];
  /** 落库全文：规范化 frontmatter + 原正文 */
  content: string;
  /** 非致命问题的告警文案（坏 YAML 等），由命令层点名 */
  warning?: string;
}

// ------------------------------------------------------------------ frontmatter

const FM_OPEN_RE = /^---[ \t]*\r?\n/;

interface Split {
  frontmatterText: string;
  body: string;
}

/**
 * 与 resources.ts 的 splitFrontmatter 同形但不导出——那边的实现是模块私有且返回结构不同
 * （它要把关闭围栏原样留回去）。这里只需要「frontmatter 文本 + 正文」两段。
 */
function splitFrontmatter(content: string): Split | null {
  const open = FM_OPEN_RE.exec(content);
  if (!open) return null;
  const after = content.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(after);
  if (!close) return null;
  const frontmatterText = after.slice(0, close.index);
  const body = after.slice(close.index + close[0].length);
  return { frontmatterText, body };
}

function isFilledString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 本地日期的 YYYY-MM-DD（不是 UTC：成员说的「今天」是墙上时钟）。 */
function localDate(date: Date): string {
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** frontmatter 里的 date：YAML 可能给出字符串（yaml v2 默认不把 ISO 日期解析成 Date），也防一手 Date 对象。 */
function readFmDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return localDate(value);
  if (isFilledString(value)) {
    const trimmed = value.trim();
    if (DATE_RE.test(trimmed)) return trimmed;
    // YAML 里 `date: 2026-10-12` 若被解析成 Date 的兜底：字符串形态也接受 Date.toString 之外的 ISO
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime()) && localDate(parsed) === trimmed) return trimmed;
  }
  return null;
}

/** 正文里首个 `# ` 标题（`##` 及更深层级不算——那是小节，不是标题）。 */
function firstHeading(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return '';
}

/** tags：YAML 列表、逗号标量、单值三种写法都认；去重去空，保序。 */
function readTags(value: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    for (const piece of raw.split(',')) {
      const tag = piece.trim();
      if (tag === '' || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  };
  if (Array.isArray(value)) for (const item of value) push(item);
  else push(value);
  return out;
}

/** `2026-10-12-灰度踩坑.md` → { stem: '灰度踩坑', date: '2026-10-12' }；没有日期前缀则 date 为 null。 */
function parseFileName(fileName: string): { stem: string; date: string | null } {
  let base = fileName;
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(base);
  if (m && DATE_RE.test(m[1] ?? '')) return { stem: m[2] ?? base, date: m[1] ?? null };
  return { stem: base, date: null };
}

export function normalizeLearning(input: LearningInput): NormalizedLearning {
  const now = (input.now ?? (() => new Date()))();
  const split = splitFrontmatter(input.raw);

  let warning: string | undefined;
  let fm: Record<string, unknown> = {};
  let body = input.raw;

  if (split) {
    body = split.body;
    try {
      const parsed: unknown = split.frontmatterText.trim() === '' ? {} : parseYaml(split.frontmatterText);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warning = 'Frontmatter 不是键值映射，已丢弃原字段、按补全值重建';
      } else {
        fm = parsed as Record<string, unknown>;
      }
    } catch (e) {
      warning = `Frontmatter YAML 解析失败（${(e as Error).message}），已丢弃原字段、按补全值重建`;
    }
  }

  const fileNameInfo = input.fileName ? parseFileName(input.fileName) : null;
  const title =
    (input.titleOverride ?? '').trim() ||
    (isFilledString(fm.title) ? fm.title.trim() : '') ||
    firstHeading(body) ||
    (fileNameInfo?.stem ?? '') ||
    'learning';

  const date =
    readFmDate(fm.date) ||
    fileNameInfo?.date ||
    localDate(now);

  const tags = readTags(fm.tags);

  // 成员写的其他字段原样带过去（author 等）：contribute 不没收别人的元数据。
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (key === 'title' || key === 'date' || key === 'tags') continue;
    preserved[key] = value;
  }
  const map = { title, date, tags, ...preserved };
  // lineWidth: 0 —— 与 resources.ts 同一理由：默认折行会让 frontmatter 边界难认
  const text = stringifyYaml(map, { lineWidth: 0 }).replace(/\s+$/, '');
  const normalizedBody = body.replace(/\s+$/, '');
  const content = `---\n${text}\n---\n${normalizedBody === '' ? '' : `${normalizedBody}\n`}`;

  return warning === undefined ? { title, date, tags, content } : { title, date, tags, content, warning };
}

// ------------------------------------------------------------------------ slug

/**
 * 允许中文的 slug：小写化 ASCII、空白转 `-`、剔除路径与文件名不安全字符、首尾去 `-`/`.`、
 * 长度封顶。不做音译（那是另一套依赖），CJK 直接进文件名——投递与 git 都按 UTF-8 路径处理。
 */
export function slugify(title: string): string {
  let s = title.toLowerCase().trim();
  // 空白与路径分隔符一律压成 -
  s = s.replace(/[\s/\\]+/g, '-');
  // 文件系统/Windows 保留与 glob 字符；控制字符。点只在首尾剥（内部 v1.0 有意义）
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"*?|'`\u0000-\u001f]/g, '');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^[-.]+/, '').replace(/[-.]+$/, '');
  if (s.length > SLUG_MAX_LENGTH) {
    s = s.slice(0, SLUG_MAX_LENGTH).replace(/[-.]+$/, '');
  }
  return s;
}

/** `learnings/<YYYY-MM-DD>-<slug>.md` 的文件名部分；slug 空时兜底 'learning'。 */
export function learningFileName(title: string, date: string): string {
  const slug = slugify(title);
  return `${date}-${slug === '' ? 'learning' : slug}.md`;
}

export function learningRepoPath(namespace: string, fileName: string): string {
  return namespace === '' ? `learnings/${fileName}` : `learnings/${namespace}/${fileName}`;
}

/**
 * 目标是否已被占用。learnings 由 collectFlatMd(qualifiedName=true) 采集：
 * 根条目 name = 文件名去扩展名，ns 条目 name = `<ns>/<文件名>`——与镜像记账键同一形状。
 */
export function learningPathTaken(learnings: Resource[], namespace: string, fileName: string): boolean {
  const stem = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
  const wanted = namespace === '' ? stem : `${namespace}/${stem}`;
  return learnings.some((r) => r.name === wanted);
}
