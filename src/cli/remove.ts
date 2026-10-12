import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { namespacesForRoles } from '../core/manifest.js';
import { repoPathFor } from '../core/plan.js';
import type { Config, Resource, ResourceKind, RolesManifest } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { isValidResourceName } from './constants.js';
import { kindHelp, parseKind } from './kinds.js';
import { deleteMcpServers, mcpRepoFile } from './mcprepo.js';
import { submitMrChange } from './mr.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

export interface RemoveOptions {
  /** mcp：同名条目在根与 namespace 两处时，用角色映射到 namespace 表态 */
  role?: string;
  /** mcp：显式指定从哪个 namespace 的文件里删（'' 不行，只能指定一个真实 namespace） */
  ns?: string;
}

function repoPath(resource: Resource): string {
  // 路径表在 core/plan.ts（KIND_ROOT / KIND_ENTRY_EXT），这里只委派：
  // 新增 kind 时那一处表补全了这里就自动对，不再用 `kind === 'skills' ? … : …` 猜。
  return repoPathFor(resource);
}

// ------------------------------------------------------------------ mcp 专用

/**
 * `--role` / `--ns` 在这里是**选择器**而不是"默认值"：给了就只在那一个文件里找，
 * 找不到就报"找不到"，绝不回落到根文件 —— 那等于替成员猜他要删哪一条，
 * 而删除是唯一会波及全体成员的操作。
 */
function removeNamespaceSelector(
  ctx: CliContext,
  config: Config,
  manifest: RolesManifest | null,
  options: RemoveOptions,
): string | null | undefined {
  const ns = (options.ns ?? '').trim();
  if (ns !== '') {
    if (!isValidResourceName(ns)) {
      ctx.err(`错误：--ns「${ns}」不合法（只允许小写字母、数字、-、_，且不能含 /）`);
      ctx.err('下一步：用 manifest/roles.yaml 里已声明的 namespace 名');
      return null;
    }
    return ns;
  }
  const role = (options.role ?? '').trim();
  if (role === '') return undefined;
  if (manifest === null) {
    ctx.err('错误：仓库没有 manifest/roles.yaml，--role 映射不到 namespace。');
    ctx.err('下一步：用 --ns <namespace> 直接指定文件');
    return null;
  }
  const mapped = namespacesForRoles(manifest, [role]);
  if (mapped.unknownRoles.length > 0) {
    ctx.err(`错误：角色「${role}」不在 manifest/roles.yaml 里。`);
    ctx.err('下一步：ejdrone roles list 看现有角色，或用 --ns 直接指定');
    return null;
  }
  if (mapped.namespaces.length === 1) return mapped.namespaces[0] ?? '';
  ctx.err(`错误：角色「${role}」订阅了多个 namespace：${mapped.namespaces.join(', ')}`);
  ctx.err('下一步：加 --ns <namespace> 明确从哪一个文件里删');
  return null;
}

interface McpTarget {
  name: string;
  namespace: string;
}

async function removeMcp(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  names: string[],
  options: RemoveOptions,
): Promise<number> {
  if (snapshot.mcpFileError !== null) {
    ctx.err(`错误：mcp 列表文件读不出条目：${snapshot.mcpFileError}`);
    ctx.err('下一步：先把文件修好再做删除 —— 认不出条目就不知道该删哪一条，动手只会删错');
    return 1;
  }

  const selector = removeNamespaceSelector(ctx, config, snapshot.manifest, options);
  if (selector === null) return 1;

  const pool = snapshot.kinds.mcp;
  const found: McpTarget[] = [];
  const missing: string[] = [];
  const ambiguous: Array<{ name: string; files: string[] }> = [];
  for (const name of names) {
    let matches = pool.filter((r) => r.name === name);
    if (typeof selector === 'string') matches = matches.filter((r) => r.namespace === selector);
    if (matches.length === 0) {
      missing.push(name);
      continue;
    }
    if (matches.length > 1) {
      // 决定 3：根与 ns 两处同名 → 拒绝执行并列出两个文件，要求带 --role/--ns
      ambiguous.push({ name, files: matches.map((m) => mcpRepoFile(m.namespace)) });
      continue;
    }
    const first = matches[0];
    if (first) found.push({ name: first.name, namespace: first.namespace });
  }

  if (ambiguous.length > 0) {
    for (const item of ambiguous) {
      ctx.err(`错误：mcp server「${item.name}」在多处定义，删哪一个会波及不同的人：`);
      for (const file of item.files) ctx.err(`  - ${file}`);
    }
    ctx.err('下一步：加 --ns <namespace>（或 --role <id>）指明从哪一个文件删，然后重跑');
    return 1;
  }
  if (missing.length > 0) {
    ctx.out(`提示：仓库里找不到 mcp ${missing.join(', ')}${typeof selector === 'string' ? `（namespace=${selector}）` : ''}，其余条目照常处理`);
  }
  if (found.length === 0) {
    ctx.err('错误：mcp 里没有可删除的条目。');
    ctx.err('下一步：ejdrone list mcp 看现有名称');
    return 1;
  }

  // 按文件分组：一个文件一次编辑（逐条删会各算各的"是否删空"，容易留下 `servers: []` 的空文件）
  const byFile = new Map<string, string[]>();
  for (const target of found) {
    const file = mcpRepoFile(target.namespace);
    const list = byFile.get(file) ?? [];
    list.push(target.name);
    byFile.set(file, list);
  }

  const files: Record<string, string> = {};
  const removes: string[] = [];
  for (const [file, fileNames] of byFile) {
    const abs = join(snapshot.dir, file);
    if (!existsSync(abs)) {
      ctx.err(`错误：${file} 不在仓库里，没法从里面删条目。`);
      return 1;
    }
    const edited = deleteMcpServers(file, readFileSync(abs, 'utf8'), fileNames);
    if (!edited.ok || edited.text === undefined) {
      ctx.err(`错误：${edited.error ?? `${file} 编辑失败`}`);
      return 1;
    }
    if (edited.removed.length === 0) {
      ctx.out(`提示：${file} 里这些条目都不在，跳过该文件`);
      continue;
    }
    // 删完空了就把整个文件走删除：留一个 `servers: []` 会让别人以为"团队清光了 server"，
    // 而目录里空着的 mcp/<ns>/ 也没意义（照 remove.ts 现有的删文件写法）。
    if (edited.emptied) removes.push(file);
    else files[file] = edited.text;
  }
  if (Object.keys(files).length === 0 && removes.length === 0) {
    ctx.err('错误：没有任何 mcp 条目被删掉。');
    return 1;
  }

  const change = {
    files,
    removes,
    branchPrefix: `ejdrone/push-mcp-${found[0]?.name ?? 'multi'}-remove-`,
    title: `chore(mcp): remove ${found.map((r) => r.name).join(', ')}`,
    body: [
      '由 ejdrone remove mcp 生成，从团队仓库的 MCP 清单里删除条目：',
      '',
      ...found.map((r) => `- ${r.name} ← ${mcpRepoFile(r.namespace)}`),
      ...(removes.length > 0 ? ['', `删空后移除整个文件：${removes.join('、')}`] : []),
      '',
      '合入后各成员下次 pull 会从其工具的原生 MCP 配置里撤掉这些条目（受管条目合并）；',
      '成员自己配的 server 一条都不会被动，被成员改过的那条会保留并点名。',
    ].join('\n'),
  };

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out(`已提交删除 mcp：${found.map((r) => r.name).join('、')}`);
      ctx.out('注意：你本机各工具配置里的条目没有被删除——未合入就删会与团队其他成员不一致。');
      ctx.out('合入后 ejdrone pull 会撤掉它们（你改过的那条会保留并点名）。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：删除提交失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查本地 clone（~/.ejdrone/repo 可删除后重建）');
    return 1;
  }
}

export async function removeCommand(
  ctx: CliContext,
  rawKind: string | undefined,
  names: string[],
  options: RemoveOptions = {},
): Promise<number> {
  const kind: ResourceKind | null = rawKind === undefined ? null : parseKind(rawKind);
  if (kind === null) {
    ctx.err(`错误：remove 需要类型 ${kindHelp()}${rawKind ? `（收到「${rawKind}」）` : ''}。`);
    ctx.err('下一步：ejdrone remove skills <name...> 或 ejdrone remove rules <name...> 或 ejdrone remove mcp <name...>');
    return 1;
  }
  if (names.length === 0) {
    ctx.err('错误：remove 需要至少一个资源名。');
    ctx.err(`下一步：ejdrone list ${kind} 查看仓库现有条目`);
    return 1;
  }

  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络/仓库地址后重跑 ejdrone remove');
    return 1;
  }
  const snapshot = loaded.snapshot;
  if (snapshot.manifestError) {
    ctx.err(`错误：${snapshot.manifestError}`);
    ctx.err('下一步：先修好 manifest/roles.yaml，删除操作要在干净的 manifest 上进行');
    return 1;
  }

  if (kind === 'mcp') return removeMcp(ctx, config, snapshot, names, options);

  const pool = snapshot.kinds[kind];
  const found: Resource[] = [];
  const missing: string[] = [];
  // agents 专用（照 teamai 语义）：根与 namespace 两处同名时**拒绝并列出**，
  // 删哪一处会波及不同的人 —— 成员必须用 `<ns>/<name>` 表态，不许我们猜。
  const ambiguous: Array<{ name: string; paths: string[] }> = [];
  for (const name of names) {
    if (kind === 'agents' && name.includes('/')) {
      const idx = name.indexOf('/');
      const ns = name.slice(0, idx);
      const base = name.slice(idx + 1);
      const match = pool.find((resource) => resource.namespace === ns && resource.name === base);
      if (match) found.push(match);
      else missing.push(name);
      continue;
    }
    const matches = pool.filter((resource) => resource.name === name);
    if (matches.length === 0) {
      missing.push(name);
    } else if (kind === 'agents' && matches.length > 1) {
      ambiguous.push({ name, paths: matches.map((resource) => repoPath(resource)) });
    } else {
      found.push(...matches);
    }
  }
  if (ambiguous.length > 0) {
    for (const item of ambiguous) {
      ctx.err(`错误：agent「${item.name}」在根与 namespace 两处都有同名条目，删哪一个会波及不同的人：`);
      for (const path of item.paths) ctx.err(`  - ${path}`);
    }
    ctx.err('下一步：改用 ejdrone remove agents <ns>/<name> 指明删哪一处，然后重跑');
    return 1;
  }
  if (missing.length > 0) {
    ctx.out(`提示：仓库里找不到 ${kind} ${missing.join(', ')}，其余条目照常处理`);
  }
  if (found.length === 0) {
    ctx.err(`错误：${kind} 中没有可删除的条目。`);
    ctx.err(`下一步：ejdrone list ${kind} 查看现有名称`);
    return 1;
  }

  const removes = found.map((resource) => repoPath(resource));
  const single = found[0];
  const change = {
    files: {},
    removes,
    branchPrefix: `ejdrone/push-${kind}-${single?.name ?? 'multi'}-remove-`,
    title: `chore(${kind}): remove ${found.map((r) => r.name).join(', ')}`,
    body: [
      `由 ejdrone remove 生成，删除团队仓库中的 ${kind} 条目：`,
      '',
      ...removes.map((path) => `- ${path}`),
      '',
      '合入后各成员下次 pull 会自动从各自工具目录移除这些条目（本地改过的副本会被保留并点名）。',
    ].join('\n'),
  };

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out(`已提交删除 ${kind}：${removes.join('、')}`);
      ctx.out('注意：本机各工具目录的副本没有被删除——未合入就删会与团队不一致。');
      ctx.out('合入后 ejdrone pull 会自动从各工具移除（你改过的副本会保留并点名）。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：删除提交失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查本地 clone（~/.ejdrone/repo 可删除后重建）');
    return 1;
  }
}
