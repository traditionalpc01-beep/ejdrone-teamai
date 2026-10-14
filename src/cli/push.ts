import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import { agentPushCommand } from './agentscollect.js';
import { namespacesForRoles } from '../core/manifest.js';
import { completeFrontmatter } from '../core/resources.js';
import { allResources, type Config, type Resource, type ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { BUILTIN_SKILL_NAMES, isValidResourceName } from './constants.js';
import { collectMcpDefs, type McpCollectedItem } from './mcpcollect.js';
import { defToEntry, mcpRepoFile, upsertMcpServer } from './mcprepo.js';
import { candidateKey, readTree, scanLocalAgents } from './local.js';
import { submitMrChange, type MrChange } from './mr.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

export interface PushOptions {
  skill?: string[];
  rule?: string[];
  /**
   * 从选定工具的用户级 MCP 落点反向采集一个 server 入仓库（可重复）。
   * `--all` **不**含 mcp，理由写在 collectPending 的注释里。
   */
  mcp?: string[];
  /**
   * 子 Agent（M7）：从选定工具的 agents 落点反向采集一个 agent 文件入仓库（可重复），
   * 值可以是 agent 名也可以是完整路径。各自一个 MR，因此不与 --skill/--rule/--mcp/--all 混用。
   */
  agent?: string[];
  /**
   * 把 `--mcp` / `--agent` 的采集范围缩到这一个**工具 id**（同名不同内容时由成员表态，不许猜）。
   * 它不再叫 `--agent`：从 M7 起 agent 是资源类型名（子 Agent），
   * 同一个命令里一个 flag 两种含义，比多打两个字母贵得多。
   */
  tool?: string;
  all?: boolean;
  role?: string;
  /** 显式指定目标 namespace 目录名；角色映射到多个 namespace 时必须用它挑一个 */
  ns?: string;
}

interface Pending {
  resource: Resource;
  origin: string;
}

/** 补 frontmatter + 校验名字 + 算仓库内目标路径（导出供集成测试直断） */
export function buildTargets(
  ctx: CliContext,
  pendings: Pending[],
  namespace: string,
): { files: Record<string, string>; listed: string[]; error?: string } {
  const files: Record<string, string> = {};
  const listed: string[] = [];
  for (const pending of pendings) {
    const { resource } = pending;
    if (!isValidResourceName(resource.name)) {
      return { files, listed, error: `资源名「${resource.name}」不合法（只允许小写字母、数字、-、_）` };
    }
    // 内置 skill 的保留名（照 teamai 把 `teamai-recall` 设为永不 push 的做法）：
    // 成员本地那份可能已被改过，用 push 覆盖等于绕过评审把全员的引导技能换掉。
    // 要改它仍然可以 —— 直接在团队仓库里改并走 MR，那才是评审兜底的那条路。
    if (resource.kind === 'skills' && BUILTIN_SKILL_NAMES.includes(resource.name)) {
      return {
        files,
        listed,
        error: `「${resource.name}」是内置 skill 的保留名，不能用 push 覆盖团队仓库里的那份。`,
      };
    }
    const copy: Resource = { ...resource, namespace };
    if (copy.kind === 'skills') {
      const done = completeFrontmatter(copy.files['SKILL.md'] ?? '', copy.name);
      if (done.changed) ctx.out(`提示：已为 ${copy.name}/SKILL.md 补全 frontmatter`);
      if (done.warning) ctx.out(`提示：${copy.name}/SKILL.md ${done.warning}`);
      copy.files = { ...copy.files, 'SKILL.md': done.content };
    } else {
      const done = completeFrontmatter(copy.files['content'] ?? '', copy.name);
      if (done.changed) ctx.out(`提示：已为 ${copy.name}.md 补全 frontmatter`);
      if (done.warning) ctx.out(`提示：${copy.name}.md ${done.warning}`);
      copy.files = { content: done.content };
    }
    Object.assign(files, targetPaths(copy, namespace));
    listed.push(`${copy.kind} ${namespace === '' ? '(root)' : namespace}/${copy.name} ← ${pending.origin}`);
  }
  return { files, listed };
}

// ------------------------------------------------------------------ push --mcp

/**
 * MCP 反向采集的落点范围：默认全部选定工具，`--tool` 缩到其中一个。
 * 缩范围不是便利功能 —— 同名不同内容时唯一安全的做法是让成员表态（不许猜）。
 */
function mcpScope(ctx: CliContext, config: Config, options: PushOptions): string[] | null {
  const requested = (options.tool ?? '').trim();
  if (requested === '') {
    if (config.agents.length === 0) {
      ctx.err('错误：还没有选定工具，没有可采集的 MCP 落点。');
      ctx.err('下一步：ejdrone init <repo> --agent <ids>（或 ejdrone init --force 重选）');
      return null;
    }
    return config.agents;
  }
  if (!config.agents.includes(requested)) {
    ctx.err(`错误：--tool「${requested}」不在你选定的工具里（${config.agents.join(', ') || '无'}）。`);
    ctx.err('下一步：用 ejdrone list --source local 看得到的工具，或 ejdrone init --force 重选');
    return null;
  }
  return [requested];
}

/** 改写过的疑似密钥逐条点名：只出字段名与变量名，值永不出现（决定 2 的输出形态）。 */
function reportSecretRewrites(ctx: CliContext, items: McpCollectedItem[]): void {
  const lines: string[] = [];
  for (const item of items) {
    for (const rewrite of item.rewrites) {
      const where = `server "${item.name}" 的 ${rewrite.field}.${rewrite.key}`;
      lines.push(
        rewrite.reused
          ? `  - ${where} → \${${rewrite.varName}}（沿用你环境里已有的同名变量，不用再设置）`
          : `  - ${where} → \${${rewrite.varName}}（新变量名）\n    设置方法：export ${rewrite.varName}='<该凭据的原值>'`,
      );
    }
  }
  if (lines.length === 0) return;
  ctx.out(`提示：为了不把你本机的凭据写进仓库，已把 ${lines.length} 处疑似密钥改写成环境变量引用（值不出现在这里）：`);
  for (const line of lines) ctx.out(line);
  ctx.out('提示：其他成员要拿到这条 server，需要在自己的环境里 export 同名变量（pull 会点名缺哪个）。');
}

/**
 * 把采集到的 server 写进目标 mcp.yaml。一次 --mcp 可以带多条，全部落在同一个文件里，
 * 所以是**链式套用**（前一条的结果文本是后一条的输入），不能各算各的再合并。
 */
function editMcpFile(
  snapshot: Snapshot,
  namespace: string,
  items: McpCollectedItem[],
): { files: Record<string, string>; listed: string[]; error?: string } {
  const file = mcpRepoFile(namespace);
  const abs = join(snapshot.dir, file);
  let text: string | null = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  const files: Record<string, string> = {};
  const listed: string[] = [];

  for (const item of items) {
    const entry = defToEntry(item.name, item.def);
    // tools / requires 是仓库侧的下发过滤器，本机文件里没有这个概念：就地更新时必须留下，
    // 否则重新 push 一条已在库的 server 会顺手把团队的过滤条件抹掉。
    const edited = upsertMcpServer(file, text, entry, ['tools', 'requires']);
    if (!edited.ok || edited.text === undefined) {
      return { files, listed, error: edited.error ?? '未知错误' };
    }
    text = edited.text;
    const verb = edited.action === 'updated' ? '更新' : '新增';
    listed.push(`${verb} mcp ${namespace === '' ? '(root)' : `${namespace}/${item.name}`} ← ${item.origins.join('、')}`);
  }
  if (text !== null) files[file] = text;
  return { files, listed };
}

function absPath(ctx: CliContext, value: string): string {  return isAbsolute(value) ? resolve(value) : resolve(ctx.cwd, value);
}

function loadSkillPath(ctx: CliContext, input: string): { pending?: Pending; error?: string } {
  const target = absPath(ctx, input);
  if (!existsSync(target)) return { error: `找不到 skill 路径：${target}` };
  const stats = statSync(target);
  const dir = stats.isDirectory() ? target : basename(target) === 'SKILL.md' ? resolve(target, '..') : '';
  if (dir === '') return { error: `${target} 不是 skill 目录（应包含 SKILL.md）` };
  const skillFile = join(dir, 'SKILL.md');
  if (!existsSync(skillFile)) return { error: `${dir} 缺少 SKILL.md` };
  const name = basename(dir);
  const files = readTree(dir) ?? { 'SKILL.md': readFileSync(skillFile, 'utf8') };
  return {
    pending: {
      origin: dir,
      resource: { kind: 'skills', namespace: '', name, files },
    },
  };
}

function loadRulePath(ctx: CliContext, input: string): { pending?: Pending; error?: string } {
  const target = absPath(ctx, input);
  if (!existsSync(target)) return { error: `找不到 rule 文件：${target}` };
  if (!statSync(target).isFile()) return { error: `${target} 不是文件（rule 是一个 .md 文件）` };
  const ext = extname(target).toLowerCase();
  if (ext !== '.md' && ext !== '.mdc') return { error: `${target} 的扩展名不是 .md/.mdc` };
  const name = basename(target, extname(target));
  return {
    pending: {
      origin: target,
      resource: { kind: 'rules', namespace: '', name, files: { content: readFileSync(target, 'utf8') } },
    },
  };
}

function branchPrefixFor(resources: Array<{ kind: ResourceKind; name: string }>): string {
  const single = resources[0];
  if (resources.length === 1 && single) {
    return `ejdrone/push-${single.kind}-${single.name}-`;
  }
  const keys = resources
    .map((r) => `${r.kind}:${r.name}`)
    .sort()
    .join('|');
  const digest = createHash('sha1').update(keys).digest('hex').slice(0, 8);
  const kinds = [...new Set(resources.map((r) => r.kind))];
  const label = kinds.length === 1 ? (kinds[0] ?? 'mixed') : 'mixed';
  return `ejdrone/push-${label}-batch-${digest}-`;
}

function repoHas(snapshot: Snapshot, kind: ResourceKind, name: string, namespace: string): boolean {
  return snapshot.kinds[kind].some((r) => r.name === name && r.namespace === namespace);
}

/**
 * 目标 namespace 目录名。角色 id 与 namespace 目录名不是一回事（一个角色可以订阅多个
 * namespace），所以走 manifest 映射；多义时要求显式 --ns，而不是猜一个把团队内容放错目录。
 * 返回 '' 表示推到仓库根目录（全员共享）。
 */
function resolveTargetNamespace(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  options: PushOptions
): string | null {
  const explicit = (options.ns ?? '').trim();
  if (explicit !== '') {
    if (!isValidResourceName(explicit)) {
      ctx.err(`错误：--ns「${explicit}」不合法（只允许小写字母、数字、-、_，且不能含 /）`);
      ctx.err('下一步：用 manifest/roles.yaml 里已声明的 namespace 名');
      return null;
    }
    return explicit;
  }

  const role = (options.role ?? config.primaryRole ?? '').trim();
  if (role === '') {
    ctx.out('提示：当前没有角色，资源将推到仓库根目录（全员共享）');
    return '';
  }

  const mapped =
    snapshot.manifest === null
      ? { namespaces: [], unknownRoles: [role] }
      : namespacesForRoles(snapshot.manifest, [role]);
  if (mapped.unknownRoles.length === 0) {
    if (mapped.namespaces.length === 1) return mapped.namespaces[0] ?? '';
    if (mapped.namespaces.length > 1) {
      ctx.err(`错误：角色「${role}」订阅了多个 namespace：${mapped.namespaces.join(', ')}`);
      ctx.err('下一步：加 --ns <namespace> 明确推到哪一个');
      return null;
    }
  }

  if (!isValidResourceName(role)) {
    ctx.err(`错误：角色「${role}」既不在 manifest/roles.yaml 里，也不是合法的目录名`);
    ctx.err('下一步：用 --ns <合法 namespace> 指定目标目录');
    return null;
  }
  ctx.out(`提示：「${role}」不在 manifest/roles.yaml 的角色 id 里，按同名 namespace 目录 skills/${role}/ 推送`);
  return role;
}

function targetPaths(resource: Resource, namespace: string): Record<string, string> {
  if (resource.kind === 'skills') {
    const dir = namespace === '' ? `skills/${resource.name}` : `skills/${namespace}/${resource.name}`;
    return Object.fromEntries(Object.entries(resource.files).map(([rel, content]) => [`${dir}/${rel}`, content]));
  }
  const path = namespace === '' ? `rules/${resource.name}.md` : `rules/${namespace}/${resource.name}.md`;
  const content = resource.files['content'] ?? '';
  return { [path]: content };
}

async function collectPending(
  ctx: CliContext,
  options: PushOptions,
  agentIds: string[],
  snapshot: Snapshot,
): Promise<Pending[] | null> {
  const byKey = new Map<string, Pending>();
  const warnings: string[] = [];

  const remember = (pending: Pending): void => {
    const key = `${pending.resource.kind}:${pending.resource.name}`;
    if (byKey.has(key)) {
      warnings.push(`${key} 重复指定，只保留第一个`);
      return;
    }
    byKey.set(key, pending);
  };

  for (const input of options.skill ?? []) {
    const loaded = loadSkillPath(ctx, input);
    if (loaded.error) {
      ctx.err(`错误：${loaded.error}`);
      ctx.err('下一步：skill 传目录（含 SKILL.md）或 SKILL.md 本身，例如 --skill ~/.claude/skills/my-skill');
      return null;
    }
    if (loaded.pending) remember(loaded.pending);
  }
  for (const input of options.rule ?? []) {
    const loaded = loadRulePath(ctx, input);
    if (loaded.error) {
      ctx.err(`错误：${loaded.error}`);
      ctx.err('下一步：rule 传单个 .md 文件路径，例如 --rule ~/.claude/rules/code-style.md');
      return null;
    }
    if (loaded.pending) remember(loaded.pending);
  }

  // 只给了 --mcp：一条 skill/rule 都不扫。反向采集有自己的一套候选（工具的原生 MCP 文件），
  // 混着扫会把"本地没有新 skill"报成错误，也会让成员以为顺手推了技能。
  if (byKey.size === 0 && !options.all && (options.mcp?.length ?? 0) > 0) {
    for (const warning of warnings) ctx.out(`提示：${warning}`);
    return [];
  }

  const scanned = scanLocalAgents(ctx, agentIds);
  warnings.push(...scanned.warnings);

  // 仓库已有的条目不再自动推（那是团队内容回流，会把根条目挪进 namespace）；
  // 要更新已入库的资源请用 --skill/--rule 显式指定路径。
  const repoKeys = new Set(allResources(snapshot.kinds).map((r) => `${r.kind}:${r.name}`));
  const fresh = scanned.candidates.filter((c) => !repoKeys.has(candidateKey(c)));
  const skipped = scanned.candidates.length - fresh.length;

  if (options.all) {
    // --all 只含 skills/rules，**不含 mcp**（有意，别"顺手补上"）：
    // 各工具的 MCP 落点是成员日常随手配置的共享文件，里面通常混着个人 server 与明文 token。
    // 让 --all 把它们全量扫进 MR，等于把每个人的私人配置往团队评审里推，
    // 而"疑似密钥自动改写"只能按键名兜住一部分 —— 显式 --mcp <name> 才是要教给成员的习惯。
    if (skipped > 0) warnings.push(`仓库里已有 ${skipped} 条同名资源，--all 只推新条目；要更新请显式 --skill/--rule`);
    if (fresh.length === 0) {
      ctx.err('错误：本地候选都在仓库里有了，没有要推的新内容。');
      ctx.err('下一步：用 ejdrone list --source local 看候选，或用 --skill <path> 指定要更新的条目');
      return null;
    }
    for (const candidate of fresh) {
      remember({ origin: candidate.origin, resource: candidate.resource });
    }
  } else if (byKey.size === 0) {
    if (fresh.length === 0) {
      ctx.err('错误：选定的工具目录里没有可推送的新 skill/rule（团队已入库的不重复推）。');
      ctx.err('下一步：先在工具目录里写好内容，或用 --skill/--rule 指定要更新的条目路径，或 --mcp <name> 采集 MCP server');
      return null;
    }
    if (!ctx.interactive) {
      ctx.err('错误：非交互模式需要显式选择。');
      ctx.err('下一步：用 --all 推送全部本地候选，或 --skill <path> / --rule <path> 指定条目（MCP 用 --mcp <name>）');
      return null;
    }
    const chosen = await ctx.choose(
      '选择要推送给团队的本地资源：',
      fresh.map((c) => ({ value: candidateKey(c), label: `${c.kind} ${c.name}（${c.agent}）` })),
      [],
    );
    for (const key of chosen) {
      const candidate = fresh.find((c) => candidateKey(c) === key);
      if (candidate) remember({ origin: candidate.origin, resource: candidate.resource });
    }
    if (byKey.size === 0) {
      ctx.err('错误：没有选中任何资源。');
      ctx.err('下一步：重新运行并勾选，或用 --skill/--rule 指定');
      return null;
    }
  }

  for (const warning of warnings) ctx.out(`提示：${warning}`);
  return [...byKey.values()];
}

export async function pushCommand(ctx: CliContext, options: PushOptions): Promise<number> {
  // `--agent` 走独立 MR：反向采集在 agentscollect.ts 里自带 snapshot 与提交流程。
  // 不与 --skill/--rule/--mcp 混在同一次调用 —— 混起来就是一个 MR 里两类互不相干的变更，
  // 评审看不出彼此影响，回滚也只能一起回。
  if ((options.agent?.length ?? 0) > 0) {
    const others =
      (options.skill?.length ?? 0) + (options.rule?.length ?? 0) + (options.mcp?.length ?? 0) > 0 ||
      options.all === true;
    if (others) {
      ctx.err('错误：--agent 要单独跑，不与 --skill/--rule/--mcp/--all 混在同一次 push（各自一个 MR）。');
      ctx.err('下一步：分两次运行');
      return 1;
    }
    let code = 0;
    for (const input of options.agent ?? []) {
      const one = await agentPushCommand(ctx, input, { tool: options.tool, ns: options.ns, role: options.role });
      if (one !== 0) code = one;
    }
    return code;
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
    ctx.err('下一步：确认网络与仓库地址后重跑 ejdrone push');
    return 1;
  }
  const snapshot = loaded.snapshot;

  const pendings = await collectPending(ctx, options, config.agents, snapshot);
  if (pendings === null) return 1;

  const namespace = resolveTargetNamespace(ctx, config, snapshot, options);
  if (namespace === null) return 1;

  const targets = buildTargets(ctx, pendings, namespace);
  if (targets.error) {
    ctx.err(`错误：${targets.error}`);
    ctx.err('下一步：重命名该目录/文件（只允许小写字母、数字、-、_）后重跑 ejdrone push');
    return 1;
  }
  const files: Record<string, string> = { ...targets.files };
  const listed: string[] = [...targets.listed];
  if (listed.length === 0 && (options.mcp?.length ?? 0) === 0) {
    ctx.err('错误：没有要推送的内容。');
    return 1;
  }

  // --mcp：反向采集 → 疑似密钥改写 → 写进目标 mcp.yaml。任一条采不到就整体拒绝（不部分提交），
  // 因为成员会以为"都推上去了"，而漏掉的那条在别人机器上就是缺一个 server。
  let mcpItems: McpCollectedItem[] = [];
  if ((options.mcp?.length ?? 0) > 0) {
    const scope = mcpScope(ctx, config, options);
    if (scope === null) return 1;
    const collected = collectMcpDefs(ctx, scope, options.mcp ?? [], mcpRepoFile(namespace));
    for (const note of collected.notes) ctx.out(`提示：${note}`);
    if (!collected.ok) {
      for (const line of collected.errors) ctx.err(`错误：${line}`);
      return 1;
    }
    mcpItems = collected.items;
    const edited = editMcpFile(snapshot, namespace, mcpItems);
    if (edited.error) {
      ctx.err(`错误：${edited.error}`);
      ctx.err('下一步：该文件由成员手写维护，本工具不重写它；照 mcp/mcp.yaml 现有条目的形状手工加一条再 ejdrone push 也可');
      return 1;
    }
    Object.assign(files, edited.files);
    listed.push(...edited.listed);
    reportSecretRewrites(ctx, mcpItems);
  }

  ctx.out('待推送：');
  for (const line of listed) ctx.out(`  ${line}`);

  const units = [
    ...pendings.map((p) => ({ kind: p.resource.kind, name: p.resource.name })),
    ...mcpItems.map((m) => ({ kind: 'mcp' as const, name: m.name })),
  ];
  const single = units.length === 1 ? units[0] : undefined;
  const verb = single ? (repoHas(snapshot, single.kind, single.name, namespace) ? 'update' : 'add') : 'update';
  const prefix = single ? (single.kind === 'rules' ? 'docs' : 'feat') : 'feat';
  const title = single
    ? `${prefix}(${namespace === '' ? 'root' : namespace}): ${verb} ${single.kind === 'mcp' ? `mcp ${single.name}` : single.name}`
    : `${prefix}(team): push ${units.length} resources`;
  const body = [
    '由 ejdrone push 生成。',
    '',
    `目标目录：${namespace === '' ? '仓库根（全员共享）' : namespace}`,
    '',
    '资源：',
    ...listed.map((line) => `- ${line}`),
    ...(mcpItems.length > 0
      ? [
          '',
          `MCP 条目写入文件：${mcpRepoFile(namespace)}`,
          '本工具的疑似密钥自动改写只认键名（TOKEN/KEY/SECRET/PASSWORD 结尾）与凭据形状的取值，',
          '请评审时再确认一遍：仓库里不该有明文 token。',
        ]
      : []),
    '',
    `提交者角色：${config.primaryRole ?? '（未设置）'}`,
    '请评审：内容是否适合团队共享、是否含密钥。',
  ].join('\n');

  const change: MrChange = {
    files,
    removes: [],
    branchPrefix: branchPrefixFor(units),
    title,
    body,
  };

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out('提示：合入后其他成员下次会话自动拿到；本机副本要等合入后再 ejdrone pull 才会记账。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：推送流程失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查仓库状态（~/.ejdrone/repo 可安全删除后重建）');
    return 1;
  }
}
