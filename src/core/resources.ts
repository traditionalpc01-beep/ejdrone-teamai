import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Dirent } from 'node:fs';
import type { Resource, RolesManifest } from './types.js';

export interface CollectedResources {
  skills: Resource[];
  rules: Resource[];
  warnings: string[];
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
  const skills: Resource[] = [];
  const rules: Resource[] = [];
  const warnings: string[] = [];

  const manifestNs = new Set<string>();
  if (manifest) {
    for (const role of manifest.roles) {
      for (const ns of role.namespaces) manifestNs.add(ns);
    }
  }

  collectSkills(join(checkoutRoot, 'skills'), manifestNs, skills, warnings);
  collectRules(join(checkoutRoot, 'rules'), manifestNs, rules, warnings);

  return { skills, rules, warnings };
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
      warnings.push(`skills/${entry.name} is a symlink; skipped`);
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
          warnings.push(`skills/${entry.name}/${sub.name} is a symlink; skipped`);
          continue;
        }
        if (!sub.isDirectory()) continue;
        const skillAbs = join(dirAbs, sub.name);
        if (hasDirectFile(skillAbs, 'SKILL.md')) {
          const files: Record<string, string> = {};
          collectFiles(skillAbs, skillAbs, files);
          out.push({ kind: 'skills', namespace: entry.name, name: sub.name, files });
        } else {
          warnings.push(`skills/${entry.name}/${sub.name} has no SKILL.md; skipped`);
        }
      }
    } else {
      if (directSkill) {
        const files: Record<string, string> = {};
        collectFiles(dirAbs, dirAbs, files);
        out.push({ kind: 'skills', namespace: '', name: entry.name, files });
      } else {
        warnings.push(`skills/${entry.name} has no SKILL.md; skipped`);
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
      warnings.push(`rules/${entry.name} is a symlink; skipped`);
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.endsWith('.md') && entry.name !== '.md') {
        const content = readIfExists(join(rulesRoot, entry.name));
        if (content === null) continue;
        out.push({ kind: 'rules', namespace: '', name: stripMd(entry.name), files: { content } });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;

    const dirAbs = join(rulesRoot, entry.name);
    const isNamespace = anyDirectMd(dirAbs) || manifestNs.has(entry.name);
    if (isNamespace) {
      for (const sub of listDir(dirAbs)) {
        if (sub.isSymbolicLink()) {
          warnings.push(`rules/${entry.name}/${sub.name} is a symlink; skipped`);
          continue;
        }
        if (sub.isFile() && sub.name.endsWith('.md') && sub.name !== '.md') {
          const content = readIfExists(join(dirAbs, sub.name));
          if (content === null) continue;
          out.push({ kind: 'rules', namespace: entry.name, name: stripMd(sub.name), files: { content } });
        } else if (sub.isDirectory()) {
          warnings.push(`rules/${entry.name}/${sub.name} is a nested directory; not supported, skipped`);
        }
      }
    } else {
      warnings.push(`rules/${entry.name} has no .md files and is not a declared namespace; skipped`);
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
  return joined === '' ? name : joined;
}

function frontmatterBlock(map: Record<string, unknown>): string {
  const text = stringifyYaml(map);
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text.replace(/\s+$/, '');
  return `---\n${trimmed}\n`;
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

  return { content: `${frontmatterBlock(next)}${split.closing}${split.body}`, changed: true };
}
