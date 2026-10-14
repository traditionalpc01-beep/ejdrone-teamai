import { resourceKey, type PlannedWrite, type Resource } from '../core/types.js';
import { readRuleText } from './mdc.js';

/**
 * block 模式（Codex / DeepSeek Harness）：所有 rule 合并成一条 PlannedWrite，
 * 用 region 标记把区块正文写进该工具的 AGENTS.md。标记外的用户内容保持不动。
 */
export const BLOCK_START = '<!-- [ejdrone:team-rules:start] -->';
export const BLOCK_END = '<!-- [ejdrone:team-rules:end] -->';
export const BLOCK_RESOURCE_KEY = resourceKey('rules', 'team-rules-block');

export function planRulesBlock(input: { rules: Resource[]; path: string }): PlannedWrite[] {
  return [
    {
      path: input.path,
      content: renderBlock(input.rules),
      resource: BLOCK_RESOURCE_KEY,
      region: { start: BLOCK_START, end: BLOCK_END },
    },
  ];
}

/** 合并区块正文（不含标记行本身）。rules 为空 → 空字符串（清空但保留标记）。 */
export function renderBlock(rules: Resource[]): string {
  if (rules.length === 0) return '';
  const sorted = [...rules].sort(
    (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
  );
  const segments = sorted.map((rule) => {
    const { body, paths } = readRuleText(rule);
    let text = body.trim();
    if (paths.length > 0) {
      text = `Applies to files matching: ${paths.join(', ')}\n\n${text}`.trimEnd();
    }
    return text;
  });
  return `${segments.join('\n\n---\n\n')}\n`;
}
