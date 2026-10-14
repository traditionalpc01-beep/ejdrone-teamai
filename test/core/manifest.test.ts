import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { namespacesForRoles, parseRolesManifest } from '../../src/core/manifest.js';
import type { RolesManifest } from '../../src/core/types.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function tmp(): string {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-'));
  return root;
}

function writeManifest(base: string, text: string): void {
  const dir = join(base, 'manifest');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'roles.yaml'), text, 'utf8');
}

describe('parseRolesManifest', () => {
  it('returns null manifest with no error when the file is absent', () => {
    const base = tmp();
    expect(parseRolesManifest(base)).toEqual({ manifest: null });
  });

  it('parses a valid manifest', () => {
    const base = tmp();
    writeManifest(
      base,
      'version: 1\nroles:\n  - id: fe\n    description: 前端\n    namespaces: [fe]\n  - id: devops\n    namespaces: [devops]\n',
    );
    const res = parseRolesManifest(base);
    expect(res.error).toBeUndefined();
    expect(res.manifest?.version).toBe(1);
    expect(res.manifest?.roles.map((r) => r.id)).toEqual(['fe', 'devops']);
    expect(res.manifest?.roles[0]?.namespaces).toEqual(['fe']);
  });

  it('reports an error containing the file path on invalid YAML', () => {
    const base = tmp();
    writeManifest(base, 'version: 1\nroles: [\n');
    const res = parseRolesManifest(base);
    expect(res.manifest).toBeNull();
    expect(res.error).toContain('roles.yaml');
  });

  it('rejects a non-mapping root node', () => {
    const base = tmp();
    writeManifest(base, '- a\n- b\n');
    const res = parseRolesManifest(base);
    expect(res.manifest).toBeNull();
    expect(res.error).toContain('mapping');
    expect(res.error).toContain('roles.yaml');
  });

  it('rejects an empty document', () => {
    const base = tmp();
    writeManifest(base, '');
    const res = parseRolesManifest(base);
    expect(res.manifest).toBeNull();
    expect(res.error).toBeDefined();
  });

  it('rejects an invalid role id (uppercase)', () => {
    const base = tmp();
    writeManifest(base, 'version: 1\nroles:\n  - id: Fe\n    namespaces: [fe]\n');
    expect(parseRolesManifest(base).manifest).toBeNull();
  });

  it('rejects an invalid namespace (space)', () => {
    const base = tmp();
    writeManifest(base, 'version: 1\nroles:\n  - id: fe\n    namespaces: [Bad NS]\n');
    expect(parseRolesManifest(base).manifest).toBeNull();
  });

  it('accepts ids with leading digit, dash and underscore', () => {
    const base = tmp();
    writeManifest(base, 'version: 1\nroles:\n  - id: 1a_b-c\n    namespaces: [x_y-z]\n');
    expect(parseRolesManifest(base).manifest).not.toBeNull();
  });

  it('rejects duplicate role ids', () => {
    const base = tmp();
    writeManifest(
      base,
      'version: 1\nroles:\n  - id: fe\n    namespaces: [fe]\n  - id: fe\n    namespaces: [x]\n',
    );
    const res = parseRolesManifest(base);
    expect(res.manifest).toBeNull();
    expect(res.error).toContain('duplicate');
  });
});

describe('namespacesForRoles', () => {
  const manifest: RolesManifest = {
    version: 1,
    roles: [
      { id: 'fe', namespaces: ['fe', 'shared'] },
      { id: 'be', namespaces: ['be', 'shared'] },
      { id: 'ops', namespaces: ['devops'] },
    ],
  };

  it('unions namespaces in roleIds order and dedups', () => {
    expect(namespacesForRoles(manifest, ['be', 'fe'])).toEqual({
      namespaces: ['be', 'shared', 'fe'],
      unknownRoles: [],
    });
  });

  it('collects unknown roles once, and still returns known namespaces', () => {
    const res = namespacesForRoles(manifest, ['ghost', 'fe', 'ghost']);
    expect(res.namespaces).toEqual(['fe', 'shared']);
    expect(res.unknownRoles).toEqual(['ghost']);
  });

  it('returns empty for empty input', () => {
    expect(namespacesForRoles(manifest, [])).toEqual({ namespaces: [], unknownRoles: [] });
  });
});
