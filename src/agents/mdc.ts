import { join } from 'node:path';
import { parse } from 'yaml';
import { resourceKey, type PlannedWrite, type Resource } from '../core/types.js';
import { ruleContent } from './rulesdir.js';

/**
 * mdc 模式（Cursor）：每条 rule 重写为 Cursor 的 `.mdc` frontmatter 形式。
 * 生成的 frontmatter：description / (globs) / alwaysApply: true；正文逐字节保持原文。
 */
export function planRulesMdc(input: { rules: Resource[]; rulesRoot: string }): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  for (const rule of input.rules) {
    const { body, description, paths } = readRuleText(rule);
    const desc = description ?? firstParagraphAfterHeading(body) ?? rule.name;

    const fm: string[] = ['---', `description: ${JSON.stringify(desc)}`];
    if (paths.length > 0) fm.push(`globs: ${paths.join(', ')}`);
    fm.push('alwaysApply: true', '---');

    writes.push({
      path: join(input.rulesRoot, `${rule.name}.mdc`),
      content: `${fm.join('\n')}\n${body}`,
      resource: resourceKey('rules', rule.name),
    });
  }
  return writes;
}

export interface RuleText {
  content: string;
  /** 去掉 frontmatter 后的正文（逐字节） */
  body: string;
  hasFrontmatter: boolean;
  description?: string;
  paths: string[];
}

/** 解析 rule：拆 frontmatter，取 description 与 paths glob。 */
export function readRuleText(rule: Resource): RuleText {
  const content = ruleContent(rule);
  const parts = splitFrontmatter(content);
  let description: string | undefined;
  let paths: string[] = [];
  if (parts.hasFrontmatter) {
    const meta = parseFrontmatter(parts.frontmatter);
    description = meta.description;
    paths = meta.paths;
  }
  return { content, body: parts.body, hasFrontmatter: parts.hasFrontmatter, description, paths };
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export function splitFrontmatter(text: string): {
  hasFrontmatter: boolean;
  frontmatter: string;
  body: string;
} {
  const m = FM_RE.exec(text);
  if (!m) return { hasFrontmatter: false, frontmatter: '', body: text };
  return {
    hasFrontmatter: true,
    frontmatter: m[1] ?? '',
    body: m[2] ?? '',
  };
}

function parseFrontmatter(fm: string): { description?: string; paths: string[] } {
  let data: unknown;
  try {
    data = parse(fm);
  } catch {
    return { paths: [] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { paths: [] };
  const obj = data as Record<string, unknown>;
  const descVal = obj['description'];
  const description =
    typeof descVal === 'string' && descVal.trim() !== '' ? descVal.trim() : undefined;
  return { description, paths: normalizePaths(obj['paths']) };
}

function normalizePaths(raw: unknown): string[] {
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  if (Array.isArray(raw)) {
    return raw
      .map((x) => (x === null || x === undefined ? '' : String(x)).trim())
      .filter((s) => s !== '');
  }
  return [];
}

function firstParagraphAfterHeading(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^#{1,6}\s/.test(lines[i] as string)) i++;
  if (i >= lines.length) return undefined;
  i++; // 跳过标题行
  while (i < lines.length && (lines[i] as string).trim() === '') i++;
  const para: string[] = [];
  while (i < lines.length && (lines[i] as string).trim() !== '') {
    para.push((lines[i] as string).trim());
    i++;
  }
  return para.length > 0 ? para.join(' ') : undefined;
}
