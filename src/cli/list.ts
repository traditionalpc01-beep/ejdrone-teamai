import { activeNamespaces, isResourceActive } from '../core/plan.js';
import { resolveMcpResources } from '../core/mcp.js';
import { allResources, mcpPayload, type Resource, type ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { selectedAdapters } from './delivery.js';
import { kindHelp, parseKind, unknownKindMessage } from './kinds.js';
import { scanLocalAgents } from './local.js';
import { scanLocalMcp } from './mcpscan.js';
import { openSnapshot } from './snapshot.js';

export type ListSource = 'repo' | 'local' | 'all';

export interface ListOptions {
  source?: string;
}

export async function listCommand(ctx: CliContext, kind: string | undefined, options: ListOptions): Promise<number> {
  const wanted: ResourceKind | null = kind === undefined ? null : parseKind(kind);
  if (kind !== undefined && wanted === null) {
    ctx.err(`错误：${unknownKindMessage(kind)}。`);
    ctx.err(`下一步：ejdrone list [${kindHelp().replace(/ \| /g, '|')}] [--source repo|local|all]`);
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

  // mcp 的 local 源是**只列名字**：那些共享文件里可能写着明文 token，
  // command / args / env / headers / url 的值一个都不打印（M6 命令面决定 4）。
  if (wanted === 'mcp' && (source === 'local' || source === 'all')) {
    listLocalMcp(ctx, config.agents);
    if (source === 'local') return 0;
    ctx.out('');
  }
  if (wanted !== 'mcp' && (source === 'local' || source === 'all')) {
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
    if (wanted === null && config.agents.length > 0) {
      ctx.out('  提示：MCP server 不在这里列，用 ejdrone list mcp --source local 看各工具原生配置里有什么');
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
  const activeTags = new Set(config.subscribedTags);
  const { adapters, notes } = selectedAdapters(ctx, config);
  for (const note of notes) ctx.out(`提示：${note}`);

  if (wanted === 'mcp') {
    if (snapshot.mcpFileError !== null) {
      ctx.err(`错误：mcp 列表文件解析失败，本次 mcp 已停发（已装内容不动）：${snapshot.mcpFileError}`);
      ctx.err('下一步：修好 mcp/mcp.yaml（顶层必须是 servers: 列表）后重跑');
      return 1;
    }
    return listRepoMcp(ctx, snapshot.kinds.mcp, active, activeTags, adapters.map((a) => a.id));
  }

  const rows = (wanted === null ? allResources(snapshot.kinds) : snapshot.kinds[wanted]).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  ctx.out(`团队仓库：${rows.length} 条（分支 ${snapshot.branch}）`);
  for (const row of rows) {
    const rootTag = row.namespace === '' ? '根条目' : `namespace=${row.namespace}`;
    // 标签命中时点名是哪个标签：这是成员唯一能看出「这条为什么我会收到」的地方
    const hitTag =
      row.namespace !== '' && !active.has(row.namespace) && row.tags !== undefined
        ? row.tags.find((t) => activeTags.has(t))
        : undefined;
    const activeTag = isResourceActive(row, active, activeTags)
      ? hitTag !== undefined
        ? `本次会下发（tag:${hitTag}）`
        : '本次会下发'
      : '角色不匹配，本次不下发';
    ctx.out(`  ${row.kind}  ${row.name}  ${rootTag}  ${activeTag}${row.tags && row.tags.length > 0 ? `  tags=${row.tags.join(',')}` : ''}`);
  }
  if (rows.length === 0) ctx.out('  （仓库里还没有 skills/ 或 rules/ 条目）');
  if (snapshot.mcpFileError !== null) {
    ctx.out(`提示：mcp 本次停发（已装内容不动）：${snapshot.mcpFileError}`);
    ctx.out('      明细看 ejdrone list mcp 或 ejdrone doctor');
  }
  return 0;
}

// ---------------------------------------------------------------------- mcp

/** 本地各工具原生 MCP 文件里有什么（只有名字与路径）。 */
function listLocalMcp(ctx: CliContext, agents: string[]): void {
  const scan = scanLocalMcp(ctx.home, ctx.env, agents);
  const byFile = new Map<string, { label: string; file: string; names: string[]; collectable: boolean }>();
  for (const entry of scan.entries) {
    const group = byFile.get(entry.file) ?? {
      label: entry.label,
      file: entry.file,
      names: [],
      collectable: entry.collectable,
    };
    group.names.push(entry.name);
    byFile.set(entry.file, group);
  }
  const total = scan.entries.length;
  ctx.out(`本地 MCP（扫描 ${agents.join(', ') || '无选定工具'} 的用户级落点）：${total} 条`);
  for (const group of byFile.values()) {
    ctx.out(`  ${group.label}  ${group.file}`);
    for (const name of group.names.sort((a, b) => (a < b ? -1 : 1))) ctx.out(`    ${name}`);
    if (!group.collectable) {
      ctx.out('    （TOML 落点：只列名字，不做反向采集；要入库请手写进 mcp/mcp.yaml）');
    }
  }
  if (total === 0) ctx.out('  （选定工具的用户级 MCP 配置里没有条目，或文件还不存在）');
  for (const note of scan.notes) ctx.out(`提示：${note}`);
  if (scan.unsupported.length > 0) {
    ctx.out(`提示：这些工具没有用户级 MCP 落点，收不到团队的 mcp 内容：${scan.unsupported.join('、')}`);
  }
}

/** 仓库侧清单：name / namespace / transport / 本次是否会下发。值一律不回显。 */
function listRepoMcp(
  ctx: CliContext,
  servers: Resource[],
  active: Set<string>,
  activeTags: ReadonlySet<string>,
  agentIds: string[],
): number {
  // 缺 \${VAR} 的条目不下发（只列变量名，绝不列值）
  const { skipped } = resolveMcpResources(servers, ctx.env);
  const missingByServer = new Map<string, string[]>();
  for (const s of skipped) missingByServer.set(s.name, s.missing);

  ctx.out(`团队仓库 MCP：${servers.length} 条`);
  for (const server of servers) {
    const rootTag = server.namespace === '' ? '根条目' : `namespace=${server.namespace}`;
    const hitTag =
      server.namespace !== '' && !active.has(server.namespace) && server.tags !== undefined
        ? server.tags.find((t) => activeTags.has(t))
        : undefined;
    const nsTag = !isResourceActive(server, active, activeTags)
      ? '角色不匹配，本次不下发'
      : hitTag !== undefined
        ? `本次会下发（tag:${hitTag}）`
        : null;
    const payload = mcpPayload(server);
    const toolsTag =
      payload.tools && payload.tools.length > 0 && !payload.tools.some((t) => agentIds.includes(t))
        ? `只发给 ${payload.tools.join(',')}（你没勾这些工具，本次收不到）`
        : null;
    const varTag = missingByServer.has(server.name)
      ? `缺环境变量 ${missingByServer.get(server.name)?.map((v) => `\${${v}}`).join('、')}，本次不下发`
      : null;
    const verdict = nsTag ?? toolsTag ?? varTag ?? '本次会下发';
    ctx.out(`  mcp  ${server.name}  ${rootTag}  ${payload.transport}  ${verdict}`);
  }
  if (servers.length === 0) ctx.out('  （仓库里还没有 mcp/mcp.yaml 条目）');
  return 0;
}
