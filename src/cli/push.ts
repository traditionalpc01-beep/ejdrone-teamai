import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import { namespacesForRoles } from '../core/manifest.js';
import { completeFrontmatter } from '../core/resources.js';
import type { Config, Resource, ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { isValidResourceName } from './constants.js';
import { candidateKey, readTree, scanLocalAgents } from './local.js';
import { submitMrChange, type MrChange } from './mr.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

export interface PushOptions {
  skill?: string[];
  rule?: string[];
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

function absPath(ctx: CliContext, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(ctx.cwd, value);
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

function repoHas(snapshot: Snapshot, resource: Resource): boolean {
  const pool = resource.kind === 'skills' ? snapshot.skills : snapshot.rules;
  return pool.some((r) => r.name === resource.name && r.namespace === resource.namespace);
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

  const scanned = scanLocalAgents(ctx, agentIds);
  warnings.push(...scanned.warnings);

  // 仓库已有的条目不再自动推（那是团队内容回流，会把根条目挪进 namespace）；
  // 要更新已入库的资源请用 --skill/--rule 显式指定路径。
  const repoKeys = new Set([
    ...snapshot.skills.map((r) => `skills:${r.name}`),
    ...snapshot.rules.map((r) => `rules:${r.name}`),
  ]);
  const fresh = scanned.candidates.filter((c) => !repoKeys.has(candidateKey(c)));
  const skipped = scanned.candidates.length - fresh.length;

  if (options.all) {
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
      ctx.err('下一步：先在工具目录里写好内容，或用 --skill/--rule 指定要更新的条目路径');
      return null;
    }
    if (!ctx.interactive) {
      ctx.err('错误：非交互模式需要显式选择。');
      ctx.err('下一步：用 --all 推送全部本地候选，或 --skill <path> / --rule <path> 指定条目');
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
  if (pendings === null || pendings.length === 0) return 1;

  const namespace = resolveTargetNamespace(ctx, config, snapshot, options);
  if (namespace === null) return 1;

  const targets = buildTargets(ctx, pendings, namespace);
  if (targets.error) {
    ctx.err(`错误：${targets.error}`);
    ctx.err('下一步：重命名该目录/文件（只允许小写字母、数字、-、_）后重跑 ejdrone push');
    return 1;
  }
  const { files, listed } = targets;

  ctx.out('待推送：');
  for (const line of listed) ctx.out(`  ${line}`);

  const single = pendings.length === 1 ? pendings[0] : undefined;
  const verb = single ? (repoHas(snapshot, { ...single.resource, namespace }) ? 'update' : 'add') : 'update';
  const title = single
    ? `${single.resource.kind === 'skills' ? 'feat' : 'docs'}(${namespace === '' ? 'root' : namespace}): ${verb} ${single.resource.name}`
    : `feat(team): push ${pendings.length} resources`;
  const body = [
    '由 ejdrone push 生成。',
    '',
    `目标目录：${namespace === '' ? '仓库根（全员共享）' : namespace}`,
    '',
    '资源：',
    ...listed.map((line) => `- ${line}`),
    '',
    `提交者角色：${config.primaryRole ?? '（未设置）'}`,
    '请评审：内容是否适合团队共享、是否含密钥。',
  ].join('\n');

  const change: MrChange = {
    files,
    removes: [],
    branchPrefix: branchPrefixFor(pendings.map((p) => ({ kind: p.resource.kind, name: p.resource.name }))),
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
