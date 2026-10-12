import { namespacesForRoles } from './manifest.js';
import {
  RESOURCE_KINDS,
  emptyKinds,
  type Config,
  type KindSemantics,
  type KindSet,
  type Resolution,
  type ResolveInput,
  type Resource,
  type ResourceKind,
  type RolesManifest,
} from './types.js';

/**
 * 每类资源在团队仓库里的顶层目录名。
 * 用表而不是 `kind === 'skills' ? … : …`：新增 kind 时漏了这一格会编译失败，
 * 而三元表达式的 else 分支会把新 kind 静默当成 rules/ 目录处理。
 */
const KIND_ROOT: Record<ResourceKind, string> = {
  skills: 'skills',
  rules: 'rules',
  mcp: 'mcp',
  agents: 'agents',
  docs: 'docs',
  learnings: 'learnings',
};

/**
 * namespace 裁决语义（契约注释在 types.ts 的 RESOURCE_KINDS 上方）。
 * `union` 走的是「只过滤、不替换、不判冲突」那条分支 —— docs/learnings 的 name 已含 ns 路径，
 * 同名根条目与 ns 条目落到镜像里是两个不同文件，把它们判成冲突只会让整类文档停发。
 */
const KIND_SEMANTICS: Record<ResourceKind, KindSemantics> = {
  skills: 'override',
  rules: 'override',
  mcp: 'override',
  agents: 'override',
  docs: 'union',
  learnings: 'union',
};

interface KindResult {
  items: Resource[];
  conflicts: string[];
  conflicted: boolean;
}

/**
 * 各类资源在仓库里的落盘形态：`null` = 目录型（skills 是一个目录，`mcp` 由 `mcp/<ns>/mcp.yaml`
 * 列表文件单独处理，不走这里），其余是「一个文件一条资源」的单文件 md。
 * 用表而不是三元：`remove.ts` 原来是 `kind === 'skills' ? 'skills' : 'rules'`，
 * 新增 kind 会静默被当成 rules/ 路径删到别的目录里去。
 */
const KIND_ENTRY_EXT: Record<ResourceKind, string | null> = {
  skills: null,
  rules: '.md',
  mcp: null,
  agents: '.md',
  docs: '.md',
  learnings: '.md',
};

/** docs / learnings 的 name 里已经含 namespace 段（契约注释在 types.ts 的 Resource 上方）。 */
const KIND_QUALIFIED_NAME: Record<ResourceKind, boolean> = {
  skills: false,
  rules: false,
  mcp: false,
  agents: false,
  docs: true,
  learnings: true,
};

/** 一条资源在团队仓库里的路径（`remove` 删文件、报告文案指路都用它）。 */
export function repoPathFor(resource: Resource): string {
  const root = KIND_ROOT[resource.kind];
  const qualified = KIND_QUALIFIED_NAME[resource.kind] || resource.namespace === '';
  const rel = qualified ? resource.name : `${resource.namespace}/${resource.name}`;
  const ext = KIND_ENTRY_EXT[resource.kind];
  return ext === null ? `${root}/${rel}` : `${root}/${rel}${ext}`;
}

function sourcePath(kind: ResourceKind, namespace: string, name: string): string {
  const root = KIND_ROOT[kind];
  return namespace === '' ? `${root}/${name}` : `${root}/${namespace}/${name}`;
}

function resolveKind(kind: ResourceKind, resources: Resource[], active: Set<string>): KindResult {
  // 候选 = 根条目 ∪ 活跃 namespace 条目；非活跃 namespace 一律排除。
  const candidates = resources.filter((r) => r.namespace === '' || active.has(r.namespace));

  if (KIND_SEMANTICS[kind] === 'union') {
    return { items: sortResources(candidates), conflicts: [], conflicted: false };
  }

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
  const kinds = emptyKinds();
  const conflicts: string[] = [];
  const haltedKinds: ResourceKind[] = [];

  for (const kind of RESOURCE_KINDS) {
    const result = resolveKind(kind, input.kinds[kind] ?? [], active);
    conflicts.push(...result.conflicts);
    if (result.conflicted) {
      haltedKinds.push(kind);
      kinds[kind] = [];
    } else {
      kinds[kind] = sortResources(result.items);
    }
  }

  return { kinds, conflicts, warnings: [], haltedKinds };
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
        ? ['config 里设了角色，但仓库没有 manifest/roles.yaml，角色不生效']
        : [];
    return { namespaces: [], warnings };
  }

  const { namespaces, unknownRoles } = namespacesForRoles(manifest, roleIds);
  const warnings = unknownRoles.map((id) => `角色 "${id}" 不在 manifest/roles.yaml 里`);
  // 根目录（namespace ''）永远下发，不依赖这里；manifest 校验已排除 ''，此处仅防御。
  return { namespaces: namespaces.filter((n) => n !== ''), warnings };
}
