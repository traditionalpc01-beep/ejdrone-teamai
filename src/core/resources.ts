import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Dirent } from 'node:fs';
import { emptyKinds, type KindSet, type Resource, type ResourceKind, type RolesManifest } from './types.js';
import { collectMcp } from './mcp.js';

export interface CollectedResources {
  /** 按 kind 分组；mcp 由 core/mcp.ts 解析列表文件后在这里填进 kinds.mcp */
  kinds: KindSet;
  warnings: string[];
  /**
   * mcp 列表文件的文件级解析失败（非空时 kinds.mcp 为空集）。
   * 消费方（delivery 层）据此让 mcp kind 整体停发、已装内容不动 ——
   * 把失败当"空集合"会把全员已装的 server 整体删掉（teamai 教训）。
   */
  mcpFileError: string | null;
}

function listDir(dirPath: string): Dirent[] {
  return readdirSync(dirPath, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function hasDirectFile(dirPath: string, fileName: string): boolean {
  if (!existsSync(dirPath)) return false;
  for (const e of listDir(dirPath)) {
    if (e.isFile() && e.name === fileName) return true;
  }
  return false;
}

function anySubdirHasFile(dirPath: string, fileName: string): boolean {
  if (!existsSync(dirPath)) return false;
  for (const e of listDir(dirPath)) {
    if (!e.isDirectory()) continue;
    if (existsSync(join(dirPath, e.name, fileName))) return true;
  }
  return false;
}

function anyDirectMd(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false;
  for (const e of listDir(dirPath)) {
    if (e.isFile() && e.name.endsWith('.md') && e.name !== '.md') return true;
  }
  return false;
}

/** 递归收集目录下所有普通文件，key 为相对 base 的 posix 路径；符号链接一律不跟随。 */
function collectFiles(absDir: string, base: string, out: Record<string, string>): void {
  for (const e of listDir(absDir)) {
    if (e.isSymbolicLink()) continue;
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      collectFiles(abs, base, out);
    } else if (e.isFile()) {
      const rel = relative(base, abs).split(sep).join('/');
      out[rel] = readFileSync(abs, 'utf8');
    }
  }
}

function readIfExists(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function stripMd(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

export function collectResources(
  checkoutRoot: string,
  manifest: RolesManifest | null,
): CollectedResources {
  const kinds = emptyKinds();
  const warnings: string[] = [];

  const manifestNs = new Set<string>();
  if (manifest) {
    for (const role of manifest.roles) {
      for (const ns of role.namespaces) manifestNs.add(ns);
    }
  }

  collectSkills(join(checkoutRoot, 'skills'), manifestNs, kinds.skills, warnings);
  collectRules(join(checkoutRoot, 'rules'), manifestNs, kinds.rules, warnings);

  // mcp/ 是列表文件（mcp/mcp.yaml），不是一个目录树，解析在 core/mcp.ts。
  const mcp = collectMcp(checkoutRoot, manifestNs);
  kinds.mcp.push(...mcp.servers);
  warnings.push(...mcp.warnings);

  // agents/ 与 rules/ 同形（单文件 md + 可选 namespace 子树），差别只在投递时的格式转换。
  collectFlatMd(
    'agents',
    join(checkoutRoot, 'agents'),
    manifestNs,
    kinds.agents,
    warnings,
    false,
  );
  // docs/ 与 learnings/ 是并集语义（types.ts 的 KindSemantics）：name 带 ns 段，见那里的注释。
  collectFlatMd('docs', join(checkoutRoot, 'docs'), manifestNs, kinds.docs, warnings, true);
  collectFlatMd('learnings', join(checkoutRoot, 'learnings'), manifestNs, kinds.learnings, warnings, true);

  return { kinds, warnings, mcpFileError: mcp.fileError };
}

/**
 * teamai 用它做 codebase 知识图谱的目录名，声明它的 manifest 在对方那边直接加载失败。
 * 我们现在没有 codebase，沿用同一条禁用是免费保险：2.1 真加 codebase 时不会撞上一份已经
 * 叫这个名字的团队文档。
 */
const RESERVED_DOCS_NAMESPACE = 'team-codebase';

/**
 * 单文件 md 资源的一棵目录树 —— agents / docs / learnings 三类共用。
 *
 * `qualifiedName`（docs、learnings 用）决定 name 是否带 namespace 段。这不是风格差异而是记账正确性：
 * 这两类是并集语义，同名的根条目和 ns 条目**都要投**，镜像里是两个不同文件；name 若不带 ns 段，
 * `resourceKey` 就相同，apply 侧的「不在 activeResources 里才删」会永远认为其中一条还活着，
 * 停用 namespace 后那份文档删不掉。
 */
function collectFlatMd(
  kind: ResourceKind,
  rootDir: string,
  manifestNs: Set<string>,
  out: Resource[],
  warnings: string[],
  qualifiedName: boolean,
): void {
  if (!existsSync(rootDir)) return;
  for (const entry of listDir(rootDir)) {
    if (entry.isSymbolicLink()) {
      warnings.push(`${kind}/${entry.name} 是符号链接；跳过`);
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith('.md') && entry.name !== '.md') {
        const content = readIfExists(join(rootDir, entry.name));
        if (content === null) continue;
        const tags = readFrontmatterTags(content, `${kind}/${entry.name}`, warnings);
        out.push({
          kind,
          namespace: '',
          name: stripMd(entry.name),
          files: { content },
          ...(tags ? { tags } : {}),
        });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;

    if (qualifiedName && entry.name === RESERVED_DOCS_NAMESPACE) {
      warnings.push(`${kind}/${entry.name} 是保留名（${RESERVED_DOCS_NAMESPACE}）；整目录跳过`);
      continue;
    }

    const dirAbs = join(rootDir, entry.name);
    const isNamespace = anyDirectMd(dirAbs) || manifestNs.has(entry.name);
    if (!isNamespace) {
      warnings.push(`${kind}/${entry.name} 没有 .md 文件也不是已声明的 namespace；跳过`);
      continue;
    }
    for (const sub of listDir(dirAbs)) {
      if (sub.isSymbolicLink()) {
        warnings.push(`${kind}/${entry.name}/${sub.name} 是符号链接；跳过`);
        continue;
      }
      if (sub.isFile() && sub.name.endsWith('.md') && sub.name !== '.md') {
        const content = readIfExists(join(dirAbs, sub.name));
        if (content === null) continue;
        const base = stripMd(sub.name);
        const tags = readFrontmatterTags(content, `${kind}/${entry.name}/${sub.name}`, warnings);
        out.push({
          kind,
          namespace: entry.name,
          name: qualifiedName ? `${entry.name}/${base}` : base,
          files: { content },
          ...(tags ? { tags } : {}),
        });
      } else if (sub.isDirectory()) {
        warnings.push(`${kind}/${entry.name}/${sub.name} 是嵌套目录；不支持，跳过`);
      }
    }
  }
}

function collectSkills(
  skillsRoot: string,
  manifestNs: Set<string>,
  out: Resource[],
  warnings: string[],
): void {
  if (!existsSync(skillsRoot)) return;
  for (const entry of listDir(skillsRoot)) {
    if (entry.isSymbolicLink()) {
      warnings.push(`skills/${entry.name} 是符号链接；跳过`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const dirAbs = join(skillsRoot, entry.name);
    const directSkill = hasDirectFile(dirAbs, 'SKILL.md');
    const inManifest = manifestNs.has(entry.name);
    const nsLike = !directSkill && anySubdirHasFile(dirAbs, 'SKILL.md');
    const isNamespace = nsLike || inManifest;

    if (isNamespace) {
      for (const sub of listDir(dirAbs)) {
        if (sub.isSymbolicLink()) {
          warnings.push(`skills/${entry.name}/${sub.name} 是符号链接；跳过`);
          continue;
        }
        if (!sub.isDirectory()) continue;
        const skillAbs = join(dirAbs, sub.name);
        if (hasDirectFile(skillAbs, 'SKILL.md')) {
          const files: Record<string, string> = {};
          collectFiles(skillAbs, skillAbs, files);
          const tags = readFrontmatterTags(
            files['SKILL.md'] ?? '',
            `skills/${entry.name}/${sub.name}`,
            warnings,
          );
          out.push({ kind: 'skills', namespace: entry.name, name: sub.name, files, ...(tags ? { tags } : {}) });
        } else {
          warnings.push(`skills/${entry.name}/${sub.name} 没有 SKILL.md；跳过`);
        }
      }
    } else {
      if (directSkill) {
        const files: Record<string, string> = {};
        collectFiles(dirAbs, dirAbs, files);
        const tags = readFrontmatterTags(files['SKILL.md'] ?? '', `skills/${entry.name}`, warnings);
        out.push({ kind: 'skills', namespace: '', name: entry.name, files, ...(tags ? { tags } : {}) });
      } else {
        warnings.push(`skills/${entry.name} 没有 SKILL.md；跳过`);
      }
    }
  }
}

function collectRules(
  rulesRoot: string,
  manifestNs: Set<string>,
  out: Resource[],
  warnings: string[],
): void {
  if (!existsSync(rulesRoot)) return;
  for (const entry of listDir(rulesRoot)) {
    if (entry.isSymbolicLink()) {
      warnings.push(`rules/${entry.name} 是符号链接；跳过`);
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith('.md') && entry.name !== '.md') {
        const content = readIfExists(join(rulesRoot, entry.name));
        if (content === null) continue;
        const tags = readFrontmatterTags(content, `rules/${entry.name}`, warnings);
        out.push({ kind: 'rules', namespace: '', name: stripMd(entry.name), files: { content }, ...(tags ? { tags } : {}) });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;

    const dirAbs = join(rulesRoot, entry.name);
    const isNamespace = anyDirectMd(dirAbs) || manifestNs.has(entry.name);
    if (isNamespace) {
      for (const sub of listDir(dirAbs)) {
        if (sub.isSymbolicLink()) {
          warnings.push(`rules/${entry.name}/${sub.name} 是符号链接；跳过`);
          continue;
        }
        if (sub.isFile() && sub.name.endsWith('.md') && sub.name !== '.md') {
          const content = readIfExists(join(dirAbs, sub.name));
          if (content === null) continue;
          const tags = readFrontmatterTags(content, `rules/${entry.name}/${sub.name}`, warnings);
          out.push({ kind: 'rules', namespace: entry.name, name: stripMd(sub.name), files: { content }, ...(tags ? { tags } : {}) });
        } else if (sub.isDirectory()) {
          warnings.push(`rules/${entry.name}/${sub.name} 是嵌套目录；不支持，跳过`);
        }
      }
    } else {
      warnings.push(`rules/${entry.name} 没有 .md 文件也不是已声明的 namespace；跳过`);
    }
  }
}

// ------------------------------------------------------------ frontmatter

const FRONTMATTER_RE = /^---[ \t]*\r?\n/;
const FENCE_RE = /^---[ \t]*(\r?\n|$)/;

interface SplitFrontmatter {
  frontmatterText: string;
  /** 关闭围栏整行（含其后换行，若存在） */
  closing: string;
  body: string;
}

function splitFrontmatter(content: string): SplitFrontmatter | null {
  const open = FRONTMATTER_RE.exec(content);
  if (!open) return null;
  const afterOpen = content.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(afterOpen);
  if (!close) return null;
  const fenceStart = close.index + (close[1] ?? '').length;
  const frontmatterText = afterOpen.slice(0, close.index);
  const fence = FENCE_RE.exec(afterOpen.slice(fenceStart));
  if (!fence) return null;
  const closing = fence[0];
  const body = afterOpen.slice(fenceStart + closing.length);
  return { frontmatterText, closing, body };
}

function isFilledString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** 正文第一个 `# ` 标题之后的第一段非空文本；没有则回退 name。 */
function deriveDescription(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined && /^#\s+/.test(line)) break;
    i++;
  }
  if (i >= lines.length) return name;
  i++;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.trim() !== '') break;
    i++;
  }
  const paragraph: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') break;
    paragraph.push(line.trim());
  }
  const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
  if (joined === '') return name;
  // 不截断的话，一条 bullet 列表会被摊成一整段超长 description：既难读又会把 YAML 折成多行
  return joined.length > 160 ? `${joined.slice(0, 159).replace(/\s+\S*$/, '')}…` : joined;
}

/** 自带结束围栏的完整 frontmatter 块。调用方不要再补 closing。 */
function frontmatterBlock(map: Record<string, unknown>): string {
  // lineWidth: 0 —— 默认 100 列会把长 description 折成多行，读起来乱、也让 frontmatter 边界更难辨认
  const text = stringifyYaml(map, { lineWidth: 0 });
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text.replace(/\s+$/, '');
  return `---\n${trimmed}\n---\n`;
}

export interface CompleteFrontmatterResult {
  content: string;
  changed: boolean;
  warning?: string;
}

export function completeFrontmatter(content: string, name: string): CompleteFrontmatterResult {
  const split = splitFrontmatter(content);

  if (!split) {
    const description = deriveDescription(content, name);
    const block = frontmatterBlock({ name, description });
    return { content: `${block}${content}`, changed: true };
  }

  let parsed: unknown;
  try {
    parsed = split.frontmatterText.trim() === '' ? {} : parseYaml(split.frontmatterText);
  } catch (e) {
    return { content, changed: false, warning: `Frontmatter YAML is invalid: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content, changed: false, warning: 'Frontmatter YAML root must be a mapping' };
  }

  const map = parsed as Record<string, unknown>;
  const hasName = isFilledString(map.name);
  const hasDescription = isFilledString(map.description);
  if (hasName && hasDescription) return { content, changed: false };

  const next: Record<string, unknown> = { ...map };
  if (!hasName) next.name = name;
  if (!hasDescription) next.description = deriveDescription(split.body, name);

  return { content: `${frontmatterBlock(next)}${split.body}`, changed: true };
}

// ---------------------------------------------------------------- tags (2.1)

/**
 * 从 frontmatter 读条目标签。坏形状（非字符串数组）当作无标签并点名 ——
 * 静默吞掉会把「订阅了却不生效」伪装成「没人打标」。
 * 返回 undefined = 没有可用标签（未写 / 空数组 / 坏形状 / 整块 YAML 坏）。
 * 整块 YAML 坏时不在这里报：completeFrontmatter（push 侧）已经会点名同一处。
 */
export function readFrontmatterTags(
  content: string,
  label: string,
  warnings: string[],
): string[] | undefined {
  const split = splitFrontmatter(content);
  if (split === null) return undefined;
  let parsed: unknown;
  try {
    parsed = split.frontmatterText.trim() === '' ? {} : parseYaml(split.frontmatterText);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const raw = (parsed as Record<string, unknown>).tags;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || v.trim() === '')) {
    warnings.push(`${label} 的 tags 不是字符串数组；忽略标签`);
    return undefined;
  }
  const tags = [...new Set((raw as string[]).map((t) => t.trim()))];
  return tags.length > 0 ? tags : undefined;
}

export interface SetFrontmatterTagsResult {
  content: string;
  changed: boolean;
  error?: string;
}

/**
 * 改写 frontmatter 的 tags 键（管理员 `tags add/remove` 用），其余键原样保留。
 * `tags` 传 null 或空数组 = 删除该键（remove 掉最后一个标签后不留 `tags: []` 空壳）。
 * 没有实际变化时 changed=false，调用方据此报「无需提交」而不是开空 MR。
 */
export function setFrontmatterTags(content: string, tags: string[] | null): SetFrontmatterTagsResult {
  const split = splitFrontmatter(content);
  if (split === null) {
    if (tags === null || tags.length === 0) return { content, changed: false };
    return { content: `${frontmatterBlock({ tags })}${content}`, changed: true };
  }
  let parsed: unknown;
  try {
    parsed = split.frontmatterText.trim() === '' ? {} : parseYaml(split.frontmatterText);
  } catch (e) {
    return { content, changed: false, error: `Frontmatter YAML is invalid: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { content, changed: false, error: 'Frontmatter YAML root must be a mapping' };
  }
  const map = parsed as Record<string, unknown>;
  const before = map.tags === undefined ? null : JSON.stringify(map.tags);
  const after = tags !== null && tags.length > 0 ? JSON.stringify(tags) : null;
  if (before === after) return { content, changed: false };
  const next: Record<string, unknown> = { ...map };
  if (tags !== null && tags.length > 0) next.tags = tags;
  else delete next.tags;
  return { content: `${frontmatterBlock(next)}${split.body}`, changed: true };
}
