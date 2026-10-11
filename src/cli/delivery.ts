import { registry } from '../agents/index.js';
import { rulesRoot, skillsRoot } from '../agents/paths.js';
import { activeNamespaces, resolve } from '../core/plan.js';
import {
  type AgentAdapter,
  type Config,
  type KindSet,
  type Ledger,
  type PlannedWrite,
  type ResourceKey,
  type ResourceKind,
} from '../core/types.js';
import type { CliContext } from './context.js';
import type { Snapshot } from './snapshot.js';

export interface Delivery {
  writes: PlannedWrite[];
  /** 本次候选集打算保留的全部 resource key */
  activeResources: ResourceKey[];
  isManaged(path: string): boolean;
  conflicts: string[];
  /** 因冲突被整体停发的 kind —— 消费方据此跳过该 kind，别把"停发"当成"清空" */
  haltedKinds: ResourceKind[];
  /** 人类可读的过程告警（manifest 角色、缺 SKILL.md、未知工具等） */
  notes: string[];
  adapters: AgentAdapter[];
  /** 裁决后的候选集，按 kind 分组 */
  kinds: KindSet;
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
    kinds: snapshot.kinds,
    activeNamespaces: namespaces,
  });
  notes.push(...resolution.warnings);

  const { adapters, notes: adapterNotes } = selectedAdapters(ctx, config);
  notes.push(...adapterNotes);

  const writes: PlannedWrite[] = [];
  const halted = new Set(resolution.haltedKinds);

  // mcp.yaml 文件级解析失败 → mcp 整体停发。绝不能当成"仓库里没有 server"：
  // 那样 apply 会把每个成员已装的受管条目全删掉（一个拼错的 `server:` 就够引发全员事故）。
  if (snapshot.mcpFileError !== null && !halted.has('mcp')) {
    halted.add('mcp');
    notes.push(`mcp 本次停发（已装内容不动）：${snapshot.mcpFileError}`);
  }

  for (const adapter of adapters) {
    // 停发 ≠ 清空：block 模式适配器拿到空数组会写出一条"清空区块"的投递，
    // 那会把已装的 Codex / DSH 团队区块抹掉。冲突时必须整个跳过。
    if (!halted.has('skills')) writes.push(...adapter.planSkills(resolution.kinds.skills, ctx.home, ctx.env));
    if (!halted.has('rules')) writes.push(...adapter.planRules(resolution.kinds.rules, ctx.home, ctx.env));
    // MCP 能力是可选项：表里没给 mcpTarget 的工具不实现 planMcp，跳过即可。
    // note 把"因缺变量/缺可执行/不支持 transport 而跳过"带到用户眼前 —— 静默跳过会被当成"团队没下发"。
    if (!halted.has('mcp') && adapter.planMcp) {
      writes.push(...adapter.planMcp(resolution.kinds.mcp, ctx.home, ctx.env, (message) => notes.push(message)));
    }
  }

  const isManaged = (path: string): boolean =>
    adapters.some((adapter) => adapter.ownsPath(path, ctx.home, ctx.env));

  return {
    writes,
    activeResources: [...new Set(writes.map((w) => w.resource))],
    isManaged,
    conflicts: resolution.conflicts,
    // 必须是实际生效的停发集合（含 mcpFileError 那一条），不是裁决原始值：
    // activeResourcesWithConflictHold 靠它把已记账的 mcp 条目保住，否则停发会变成删除。
    haltedKinds: [...halted],
    notes,
    adapters,
    kinds: resolution.kinds,
  };
}

/**
 * 冲突只停该 kind，但停发不等于删除：把该 kind 在 ledger 里的既有资源也标成 active，
 * 否则 applyPlan 会把全体成员的已装内容清空（名称冲突是团队写错目录，不是删除指令）。
 * 用 haltedKinds 而不是从冲突文案里 split 出 kind：文案给人看，随时会变，
 * 而漏掉一个新 kind 的后果是"停发"被当成"删除"，全员该类型内容被清空。
 */
export function activeResourcesWithConflictHold(
  delivery: Delivery,
  ledger: Ledger,
): ResourceKey[] {
  const active = new Set<ResourceKey>(delivery.activeResources);
  for (const kind of delivery.haltedKinds) {
    for (const entry of ledger.entries) {
      if (entry.resource.startsWith(`${kind}:`)) active.add(entry.resource);
    }
  }
  return [...active];
}
