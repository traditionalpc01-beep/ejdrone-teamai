import { join } from 'node:path';
import { resourceKey, type PlannedWrite, type Resource } from '../core/types.js';

/**
 * rulesdir 模式：每条 rule 落成一个独立文件，内容 = 原文（frontmatter 保留）。
 * 用于原生支持 rules 目录的工具（Claude / Qoder CN）。
 */
export function planRulesDir(input: {
  rules: Resource[];
  rulesRoot: string;
  ext: string;
}): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  for (const rule of input.rules) {
    writes.push({
      path: join(input.rulesRoot, `${rule.name}.${input.ext}`),
      content: ruleContent(rule),
      resource: resourceKey('rules', rule.name),
    });
  }
  return writes;
}

/** rules 资源的正文：优先 files['content']，回落首个值。 */
export function ruleContent(rule: Resource): string {
  const direct = rule.files['content'];
  if (typeof direct === 'string') return direct;
  const first = Object.values(rule.files)[0];
  return first ?? '';
}
