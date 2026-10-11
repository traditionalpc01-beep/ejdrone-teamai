import { describe, expect, it } from 'vitest';

import { RESOURCE_KINDS } from '../../src/core/types.js';
import { cliKinds, kindHelp, parseKind, unknownKindMessage } from '../../src/cli/kinds.js';

/**
 * kind 白名单的钉子。
 *
 * 1.0 的 list.ts / remove.ts 各写了一条 `if (input === 'skills') …` 字面量链，M6 加 mcp 时
 * 就得记住"改两处"。现在白名单集中在 `src/cli/kinds.ts` 的 `Record<ResourceKind, string[]>` 里，
 * 新增 kind 时 tsc 会因缺键报错；这组用例再钉住运行时那一层：
 * **任何一个 RESOURCE_KINDS 成员 parseKind 认不出，或表里多出一个不是 kind 的键，测试就红**。
 */

describe('kind 白名单', () => {
  it('每个 ResourceKind 都能被 CLI 认出来（新增 kind 漏接时这里先炸）', () => {
    for (const kind of RESOURCE_KINDS) {
      expect(parseKind(kind), `${kind} 没登记在 cli/kinds.ts 的白名单里`).toBe(kind);
    }
  });

  it('表里的键与 RESOURCE_KINDS 完全同集（不许手写多余的 kind）', () => {
    expect([...cliKinds()].sort()).toEqual([...RESOURCE_KINDS].sort());
  });

  it('单数别名也认（成员会写 skill / rule / mcp）', () => {
    expect(parseKind('skill')).toBe('skills');
    expect(parseKind('rule')).toBe('rules');
    expect(parseKind('mcp')).toBe('mcp');
    expect(parseKind('mcps')).toBe('mcp');
    expect(parseKind('  skills  ')).toBe('skills');
  });

  it('不认识的写法返回 null，帮助文案随白名单一起变', () => {
    expect(parseKind('agents')).toBeNull();
    expect(parseKind('')).toBeNull();
    expect(parseKind(undefined)).toBeNull();
    for (const kind of RESOURCE_KINDS) {
      expect(kindHelp()).toContain(kind);
      expect(unknownKindMessage('xyz')).toContain(kind);
    }
  });
});
