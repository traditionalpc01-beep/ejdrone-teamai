import { namespacesForRoles } from './manifest.js';
import type { Config, Resolution, ResolveInput, Resource, ResourceKind, RolesManifest } from './types.js';

interface KindResult {
  items: Resource[];
  conflicts: string[];
  conflicted: boolean;
}

function sourcePath(kind: ResourceKind, namespace: string, name: string): string {
  const root = kind === 'skills' ? 'skills' : 'rules';
  return namespace === '' ? `${root}/${name}` : `${root}/${namespace}/${name}`;
}

function resolveKind(kind: ResourceKind, resources: Resource[], active: Set<string>): KindResult {
  // 候选 = 根条目 ∪ 活跃 namespace 条目；非活跃 namespace 一律排除。
  const candidates = resources.filter((r) => r.namespace === '' || active.has(r.namespace));

  const byName = new Map<string, Resource[]>();
  for (const r of candidates) {
    const group = byName.get(r.name);
    if (group) group.push(r);
    else byName.set(r.name, [r]);
  }

  const items: Resource[] = [];
  const conflicts: string[] = [];
  let conflicted = false;

  // 按 name 字典序遍历，保证冲突消息顺序确定。
  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const group = byName.get(name);
    if (!group) continue;

    const activeNs = [...new Set(group.map((r) => r.namespace).filter((n) => n !== ''))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    if (activeNs.length >= 2) {
      conflicted = true;
      const paths = activeNs.map((ns) => sourcePath(kind, ns, name));
      conflicts.push(`${kind}:${name} conflict between ${paths.join(' and ')}`);
      continue;
    }

    // namespace 条目整体替换根条目（不做字段合并）；无 namespace 时用根条目。
    const nsEntry = group.find((r) => r.namespace !== '');
    const rootEntry = group.find((r) => r.namespace === '');
    const chosen = nsEntry ?? rootEntry;
    if (chosen) items.push(chosen);
  }

  return { items, conflicts, conflicted };
}

function sortResources(items: Resource[]): Resource[] {
  return [...items].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
    return 0;
  });
}

export function resolve(input: ResolveInput): Resolution {
  const active = new Set(input.activeNamespaces);
  const skills = resolveKind('skills', input.skills, active);
  const rules = resolveKind('rules', input.rules, active);

  const haltedKinds: ResourceKind[] = [];
  if (skills.conflicted) haltedKinds.push('skills');
  if (rules.conflicted) haltedKinds.push('rules');

  return {
    skills: skills.conflicted ? [] : sortResources(skills.items),
    rules: rules.conflicted ? [] : sortResources(rules.items),
    conflicts: [...skills.conflicts, ...rules.conflicts],
    warnings: [],
    haltedKinds,
  };
}

export function activeNamespaces(
  config: Config,
  manifest: RolesManifest | null,
): { namespaces: string[]; warnings: string[] } {
  const roleIds: string[] = [];
  if (config.primaryRole !== null) roleIds.push(config.primaryRole);
  for (const r of config.additionalRoles) roleIds.push(r);

  if (manifest === null) {
    const warnings =
      roleIds.length > 0
        ? ['Config sets role(s) but the repo has no manifest/roles.yaml, so roles do not take effect']
        : [];
    return { namespaces: [], warnings };
  }

  const { namespaces, unknownRoles } = namespacesForRoles(manifest, roleIds);
  const warnings = unknownRoles.map((id) => `Role "${id}" is not defined in manifest/roles.yaml`);
  // 根目录（namespace ''）永远下发，不依赖这里；manifest 校验已排除 ''，此处仅防御。
  return { namespaces: namespaces.filter((n) => n !== ''), warnings };
}
