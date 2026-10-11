import { describe, expect, it } from 'vitest';
import { activeNamespaces, resolve } from '../../src/core/plan.js';
import type { Config, Resource, RolesManifest } from '../../src/core/types.js';

function skill(namespace: string, name: string): Resource {
  return { kind: 'skills', namespace, name, files: { 'SKILL.md': `${namespace || '<root>'}/${name}` } };
}
function rule(namespace: string, name: string): Resource {
  return { kind: 'rules', namespace, name, files: { content: `${namespace || '<root>'}/${name}` } };
}
const label = (r: Resource): string => `${r.name}@${r.namespace}`;
const labels = (rs: Resource[]): string[] => rs.map(label);

describe('resolve', () => {
  it('namespace entry fully replaces the root entry for the same (kind,name)', () => {
    const res = resolve({
      skills: [skill('', 'a'), skill('fe', 'a')],
      rules: [],
      activeNamespaces: ['fe'],
    });
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0]).toEqual(skill('fe', 'a'));
    expect(res.conflicts).toEqual([]);
  });

  it('drops entries from non-active namespaces', () => {
    const res = resolve({
      skills: [skill('', 'a'), skill('be', 'a')],
      rules: [],
      activeNamespaces: ['fe'],
    });
    expect(res.skills).toEqual([skill('', 'a')]);
  });

  it('stops the whole kind on a two-namespace conflict, leaving the other kind intact', () => {
    const res = resolve({
      skills: [skill('fe', 'a'), skill('be', 'a')],
      rules: [rule('', 'code'), rule('fe', 'code')],
      activeNamespaces: ['fe', 'be'],
    });
    expect(res.skills).toEqual([]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]).toContain('skills:a');
    expect(res.conflicts[0]).toContain('skills/fe/a');
    expect(res.conflicts[0]).toContain('skills/be/a');
    // rules unaffected by the skills conflict: namespace replaces root
    expect(res.rules).toEqual([rule('fe', 'code')]);
  });

  it('a root entry plus a single active namespace is not a conflict', () => {
    const res = resolve({
      skills: [skill('', 'a'), skill('fe', 'a')],
      rules: [],
      activeNamespaces: ['fe'],
    });
    expect(res.conflicts).toEqual([]);
    expect(res.skills).toEqual([skill('fe', 'a')]);
  });

  it('sorts deterministically by name then namespace (root first)', () => {
    const res = resolve({
      skills: [skill('fe', 'z'), skill('', 'm'), skill('fe', 'm'), skill('', 'a')],
      rules: [],
      activeNamespaces: ['fe'],
    });
    expect(labels(res.skills)).toEqual(['a@', 'm@fe', 'z@fe']);
  });

  it('is idempotent: same input yields identical output', () => {
    const input = {
      skills: [skill('fe', 'b'), skill('', 'b'), skill('', 'a'), skill('be', 'c')],
      rules: [rule('', 'r')],
      activeNamespaces: ['fe', 'be'],
    };
    const r1 = resolve(input);
    const r2 = resolve(input);
    expect(r2).toEqual(r1);
  });

  it('a root entry whose name equals a namespace name is handled without extra semantics', () => {
    const res = resolve({
      skills: [skill('', 'fe'), skill('fe', 'x')],
      rules: [],
      activeNamespaces: ['fe'],
    });
    expect(labels(res.skills).sort()).toEqual(['fe@', 'x@fe']);
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
