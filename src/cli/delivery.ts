import { registry } from '../agents/index.js';
import { rulesRoot, skillsRoot } from '../agents/paths.js';
import { activeNamespaces, resolve } from '../core/plan.js';
import { type AgentAdapter, type Config, type Ledger, type PlannedWrite, type Resource, type ResourceKey } from '../core/types.js';
import type { CliContext } from './context.js';
import type { Snapshot } from './snapshot.js';

export interface Delivery {
  writes: PlannedWrite[];
  /** 本次候选集打算保留的全部 resource key */
  activeResources: ResourceKey[];
  isManaged(path: string): boolean;
  conflicts: string[];
  /** 人类可读的过程告警（manifest 角色、缺 SKILL.md、未知工具等） */
  notes: string[];
  adapters: AgentAdapter[];
  skills: Resource[];
  rules: Resource[];
}

export function selectedAdapters(ctx: CliContext, config: Config): { adapters: AgentAdapter[]; notes: string[] } {
  const registry_ = registry();
  const adapters: AgentAdapter[] = [];
  const notes: string[] = [];
  for (const id of config.agents) {
    const adapter = registry_.byId(id);
    if (!adapter) {
      notes.push(`未知的工具 id「${id}」，本次跳过。可选：${registry_.ids().join(', ')}`);
      continue;
    }
    adapters.push(adapter);
  }
  return { adapters, notes };
}

/** 各选定工具的原生落点根目录：删除后要在这里收掉只剩空壳的目录。 */
export function managedRoots(ctx: CliContext, adapters: AgentAdapter[]): string[] {
  const roots: string[] = [];
  for (const adapter of adapters) {
    roots.push(skillsRoot(adapter.id, ctx.home, ctx.env));
    const rr = rulesRoot(adapter.id, ctx.home, ctx.env);
    if (rr !== null) roots.push(rr);
  }
  return roots;
}

/** pull 管线第 5-9 步：只算计划，不写盘。 */
export function buildDelivery(ctx: CliContext, config: Config, snapshot: Snapshot): Delivery {
  const notes: string[] = [];
  const { namespaces, warnings } = activeNamespaces(config, snapshot.manifest);
  notes.push(...warnings);

  const resolution = resolve({
    skills: snapshot.skills,
    rules: snapshot.rules,
    activeNamespaces: namespaces,
  });
  notes.push(...resolution.warnings);

  const { adapters, notes: adapterNotes } = selectedAdapters(ctx, config);
  notes.push(...adapterNotes);

  const writes: PlannedWrite[] = [];
  const halted = new Set(resolution.haltedKinds);
  for (const adapter of adapters) {
    // 停发 ≠ 清空：block 模式适配器拿到空数组会写出一条"清空区块"的投递，
    // 那会把已装的 Codex / DSH 团队区块抹掉。冲突时必须整个跳过。
    if (!halted.has('skills')) writes.push(...adapter.planSkills(resolution.skills, ctx.home, ctx.env));
    if (!halted.has('rules')) writes.push(...adapter.planRules(resolution.rules, ctx.home, ctx.env));
  }

  const isManaged = (path: string): boolean =>
    adapters.some((adapter) => adapter.ownsPath(path, ctx.home, ctx.env));

  return {
    writes,
    activeResources: [...new Set(writes.map((w) => w.resource))],
    isManaged,
    conflicts: resolution.conflicts,
    notes,
    adapters,
    skills: resolution.skills,
    rules: resolution.rules,
  };
}

/**
 * 冲突只停该 kind，但停发不等于删除：把该 kind 在 ledger 里的既有资源也标成 active，
 * 否则 applyPlan 会把全体成员的已装内容清空（名称冲突是团队写错目录，不是删除指令）。
 */
export function activeResourcesWithConflictHold(
  delivery: Delivery,
  ledger: Ledger,
): ResourceKey[] {
  const active = new Set<ResourceKey>(delivery.activeResources);
  for (const conflict of delivery.conflicts) {
    const kind = conflict.split(':', 1)[0];
    if (kind !== 'skills' && kind !== 'rules') continue;
    for (const entry of ledger.entries) {
      if (entry.resource.startsWith(`${kind}:`)) active.add(entry.resource);
    }
  }
  return [...active];
}
