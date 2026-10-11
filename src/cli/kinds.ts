import { RESOURCE_KINDS, type ResourceKind } from '../core/types.js';

/**
 * CLI 侧的 kind 白名单唯一一处。
 *
 * 1.0 时 list.ts / remove.ts 各写了一条 `if (input === 'skills') …` 字面量链，M6 加 mcp 就得再改两处
 * （漏一处的表现是"命令报未知类型"，没人会当成 bug 去补）。这里改成**按 ResourceKind 穷举的 Record**：
 * `src/core/types.ts` 新增 kind 后本表缺键，`npm run typecheck` 当场报错；
 * `test/cli/kinds.test.ts` 再把运行时的表键与 `RESOURCE_KINDS` 对照钉住（防有人用 `as` 绕过编译期）。
 */
const SPELLINGS: Record<ResourceKind, string[]> = {
  skills: ['skills', 'skill'],
  rules: ['rules', 'rule'],
  // mcp 的清单文件叫 mcp.yaml，单复数同形；`mcps` 收下单数为兼容，别指望成员写它
  mcp: ['mcp', 'mcps'],
};

/** 表里登记的 kind（与 RESOURCE_KINDS 同集，测试钉住）。 */
export function cliKinds(): ResourceKind[] {
  return Object.keys(SPELLINGS) as ResourceKind[];
}

/** 把成员写的 kind（含单数别名）归一成 ResourceKind；不认识返回 null。 */
export function parseKind(raw: string | undefined): ResourceKind | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (value === '') return null;
  for (const kind of RESOURCE_KINDS) {
    if (SPELLINGS[kind]?.includes(value)) return kind;
  }
  return null;
}

/** 帮助文案与错误提示里的 kind 列表，如 `skills | rules | mcp`。 */
export function kindHelp(): string {
  return RESOURCE_KINDS.join(' | ');
}

/** 面向人的报错：`未知类型「xyz」（支持 skills | rules | mcp）`。 */
export function unknownKindMessage(raw: string | undefined): string {
  const got = raw === undefined || raw.trim() === '' ? '' : `「${raw}」`;
  return `未知类型${got}（支持 ${kindHelp()}）`;
}
