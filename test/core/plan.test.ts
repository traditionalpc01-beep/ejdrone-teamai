import { describe, expect, it } from 'vitest';
import { activeNamespaces, resolve } from '../../src/core/plan.js';
import { emptyKinds, type Config, type KindSet, type Resource, type RolesManifest } from '../../src/core/types.js';

function skill(namespace: string, name: string): Resource {
  return { kind: 'skills', namespace, name, files: { 'SKILL.md': `${namespace || '<root>'}/${name}` } };
}
function rule(namespace: string, name: string): Resource {
  return { kind: 'rules', namespace, name, files: { content: `${namespace || '<root>'}/${name}` } };
}
function mcp(namespace: string, name: string): Resource {
  return {
    kind: 'mcp',
    namespace,
    name,
    files: {},
    payload: { transport: 'stdio', command: 'npx', args: [`-${name}-mcp`] },
  };
}
const label = (r: Resource): string => `${r.name}@${r.namespace}`;
const labels = (rs: Resource[]): string[] => rs.map(label);

/** 只有 skills/rules 参与的老用例用这个装配，新 kind 一律显式写出来。 */
function kindsOf(input: { skills?: Resource[]; rules?: Resource[]; mcp?: Resource[] }): KindSet {
  const kinds = emptyKinds();
  kinds.skills = input.skills ?? [];
  kinds.rules = input.rules ?? [];
  kinds.mcp = input.mcp ?? [];
  return kinds;
}

describe('resolve', () => {
  it('namespace entry fully replaces the root entry for the same (kind,name)', () => {
    const res = resolve({
      kinds: kindsOf({ skills: [skill('', 'a'), skill('fe', 'a')] }),
      activeNamespaces: ['fe'],
    });
    expect(res.kinds.skills).toHaveLength(1);
    expect(res.kinds.skills[0]).toEqual(skill('fe', 'a'));
    expect(res.conflicts).toEqual([]);
  });

  it('drops entries from non-active namespaces', () => {
    const res = resolve({
      kinds: kindsOf({ skills: [skill('', 'a'), skill('be', 'a')] }),
      activeNamespaces: ['fe'],
    });
    expect(res.kinds.skills).toEqual([skill('', 'a')]);
  });

  it('stops the whole kind on a two-namespace conflict, leaving the other kind intact', () => {
    const res = resolve({
      kinds: kindsOf({
        skills: [skill('fe', 'a'), skill('be', 'a')],
        rules: [rule('', 'code'), rule('fe', 'code')],
      }),
      activeNamespaces: ['fe', 'be'],
    });
    expect(res.kinds.skills).toEqual([]);
    expect(res.haltedKinds).toEqual(['skills']);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toContain('skills:a');
    expect(res.conflicts[0]).toContain('skills/fe/a');
    expect(res.conflicts[0]).toContain('skills/be/a');
    // rules unaffected by the skills conflict: namespace replaces root
    expect(res.kinds.rules).toEqual([rule('fe', 'code')]);
  });

  it('a root entry plus a single active namespace is not a conflict', () => {
    const res = resolve({
      kinds: kindsOf({ skills: [skill('', 'a'), skill('fe', 'a')] }),
      activeNamespaces: ['fe'],
    });
    expect(res.conflicts).toEqual([]);
    expect(res.kinds.skills).toEqual([skill('fe', 'a')]);
  });

  it('sorts deterministically by name then namespace (root first)', () => {
    const res = resolve({
      kinds: kindsOf({ skills: [skill('fe', 'z'), skill('', 'm'), skill('fe', 'm'), skill('', 'a')] }),
      activeNamespaces: ['fe'],
    });
    expect(labels(res.kinds.skills)).toEqual(['a@', 'm@fe', 'z@fe']);
  });

  it('is idempotent: same input yields identical output', () => {
    const input = {
      kinds: kindsOf({
        skills: [skill('fe', 'b'), skill('', 'b'), skill('', 'a'), skill('be', 'c')],
        rules: [rule('', 'r')],
      }),
      activeNamespaces: ['fe', 'be'],
    };
    const r1 = resolve(input);
    const r2 = resolve(input);
    expect(r2).toEqual(r1);
  });

  it('a root entry whose name equals a namespace name is handled without extra semantics', () => {
    const res = resolve({
      kinds: kindsOf({ skills: [skill('', 'fe'), skill('fe', 'x')] }),
      activeNamespaces: ['fe'],
    });
    expect(labels(res.kinds.skills).sort()).toEqual(['fe@', 'x@fe']);
  });

  // MCP 走同一套裁决：新 kind 不需要在算法里加分支，这是 KindSet 泛化的意义所在。
  it('mcp uses the same replace/conflict rules and its own source path in the message', () => {
    const replaced = resolve({
      kinds: kindsOf({ mcp: [mcp('', 'gpu'), mcp('fe', 'gpu')] }),
      activeNamespaces: ['fe'],
    });
    expect(replaced.kinds.mcp).toEqual([mcp('fe', 'gpu')]);
    expect(replaced.haltedKinds).toEqual([]);

    const conflicted = resolve({
      kinds: kindsOf({ mcp: [mcp('fe', 'gpu'), mcp('be', 'gpu')], skills: [skill('', 'a')] }),
      activeNamespaces: ['fe', 'be'],
    });
    expect(conflicted.haltedKinds).toEqual(['mcp']);
    expect(conflicted.kinds.mcp).toEqual([]);
    // 冲突消息指向 mcp/<ns>/<name>，不能被当成 rules/ 目录（老实现用三元会落到 else）
    expect(conflicted.conflicts[0]).toContain('mcp/fe/gpu');
    expect(conflicted.conflicts[0]).toContain('mcp/be/gpu');
    // 只停 mcp，skills 照常
    expect(conflicted.kinds.skills).toEqual([skill('', 'a')]);
  });
});

const cfg = (over: Partial<Config>): Config => ({
  version: 1,
  repo: 'https://example.invalid/repo.git',
  provider: 'git',
  primaryRole: null,
  additionalRoles: [],
  agents: [],
  ...over,
});

const manifest: RolesManifest = {
  version: 1,
  roles: [
    { id: 'fe', namespaces: ['fe', 'shared'] },
    { id: 'be', namespaces: ['be'] },
  ],
};

describe('activeNamespaces', () => {
  it('returns no namespaces and a warning when manifest is null but roles are configured', () => {
    const res = activeNamespaces(cfg({ primaryRole: 'fe' }), null);
    expect(res.namespaces).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('roles.yaml');
  });

  it('returns empty warnings when manifest is null and no roles configured', () => {
    expect(activeNamespaces(cfg({}), null)).toEqual({ namespaces: [], warnings: [] });
  });

  it('maps primary + additional roles into an ordered union of namespaces', () => {
    const res = activeNamespaces(cfg({ primaryRole: 'be', additionalRoles: ['fe'] }), manifest);
    expect(res.namespaces).toEqual(['be', 'fe', 'shared']);
    expect(res.warnings).toEqual([]);
  });

  it('warns for unknown roles but still returns known namespaces', () => {
    const res = activeNamespaces(cfg({ primaryRole: 'ghost', additionalRoles: ['fe'] }), manifest);
    expect(res.namespaces).toEqual(['fe', 'shared']);
    expect(res.warnings.some((w) => w.includes('ghost'))).toBe(true);
  });

  it('never includes the root namespace', () => {
    const res = activeNamespaces(cfg({ primaryRole: 'fe' }), manifest);
    expect(res.namespaces).not.toContain('');
  });
});
