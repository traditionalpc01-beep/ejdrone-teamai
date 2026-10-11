import { activeNamespaces } from '../core/plan.js';
import type { ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { selectedAdapters } from './delivery.js';
import { scanLocalAgents } from './local.js';
import { openSnapshot } from './snapshot.js';

export type ListSource = 'repo' | 'local' | 'all';

export interface ListOptions {
  source?: string;
}

function normalizeKind(kind: string | undefined): ResourceKind | null {
  if (kind === undefined) return null;
  if (kind === 'skills') return 'skills';
  if (kind === 'rules') return 'rules';
  if (kind === 'skill') return 'skills';
  if (kind === 'rule') return 'rules';
  return null;
}

export async function listCommand(ctx: CliContext, kind: string | undefined, options: ListOptions): Promise<number> {
  const wanted = normalizeKind(kind);
  if (kind !== undefined && wanted === null) {
    ctx.err(`错误：未知类型「${kind}」。`);
    ctx.err('下一步：ejdrone list [skills|rules] [--source repo|local|all]');
    return 1;
  }

  const source = (options.source ?? 'repo').trim();
  if (source !== 'repo' && source !== 'local' && source !== 'all') {
    ctx.err(`错误：--source 只支持 repo / local / all，收到「${source}」。`);
    ctx.err('下一步：ejdrone list --source repo');
    return 1;
  }

  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  if (source === 'local' || source === 'all') {
    const { candidates, warnings } = scanLocalAgents(ctx, config.agents);
    for (const warning of warnings) ctx.out(`提示：${warning}`);
    const filtered = wanted ? candidates.filter((c) => c.kind === wanted) : candidates;
    ctx.out(`本地（扫描 ${config.agents.join(', ') || '无选定工具'} 的原生目录）：${filtered.length} 条`);
    for (const candidate of filtered) {
      ctx.out(`  ${candidate.kind}  ${candidate.name}  (root)  ${candidate.agent}`);
    }
    if (filtered.length === 0) {
      ctx.out('  （没有候选；先在某工具目录写好 skill/rule，或用 --source repo 看仓库现状）');
    }
    if (source === 'local') return 0;
    ctx.out('');
  }

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络/仓库地址，或改用 ejdrone list --source local');
    return 1;
  }
  const snapshot = loaded.snapshot;
  if (snapshot.manifestError) {
    ctx.err(`错误：manifest/roles.yaml 无法解析：${snapshot.manifestError}`);
    ctx.err('下一步：修正该文件后重跑');
    return 1;
  }

  const { namespaces, warnings } = activeNamespaces(config, snapshot.manifest);
  for (const warning of warnings) ctx.out(`提示：${warning}`);
  const active = new Set(namespaces);
  const { notes } = selectedAdapters(ctx, config);
  for (const note of notes) ctx.out(`提示：${note}`);

  const rows = [
    ...(wanted === null || wanted === 'skills' ? snapshot.skills : []),
    ...(wanted === null || wanted === 'rules' ? snapshot.rules : []),
  ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  ctx.out(`团队仓库：${rows.length} 条（分支 ${snapshot.branch}）`);
  for (const row of rows) {
    const rootTag = row.namespace === '' ? '根条目' : `namespace=${row.namespace}`;
    const activeTag = row.namespace === '' || active.has(row.namespace) ? '本次会下发' : '角色不匹配，本次不下发';
    ctx.out(`  ${row.kind}  ${row.name}  ${rootTag}  ${activeTag}`);
  }
  if (rows.length === 0) ctx.out('  （仓库里还没有 skills/ 或 rules/ 条目）');
  return 0;
}
