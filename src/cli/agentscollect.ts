import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { agentsTarget, type AgentsFormat } from '../agents/paths.js';
import { agentToRepoMarkdown } from '../agents/agentfmt.js';
import { namespacesForRoles } from '../core/manifest.js';
import { completeFrontmatter } from '../core/resources.js';
import type { Config } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { isValidResourceName } from './constants.js';
import { submitMrChange } from './mr.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

/**
 * `push --agent <path|name>` 的反向采集（M7 T7.4）：从**选定工具**的 agents 落点里取一个文件写回仓库。
 *
 * 命令注册由协调者收口（本文件只导出 `agentPushCommand`，不在 cli.ts 挂线）。
 * 与 push --mcp 同一套纪律：
 * - 多工具同名且**内容不同**时拒绝并逐处点名，让成员用 `--tool` 或完整路径表态 —— 不许猜；
 *   （内容相同不告警：那是同一份团队投递的副本，或成员在两个工具里写了同一份东西。）
 * - toml 落点不做反向解析（照 MCP 侧对 TOML 的决定），点名原因与出路；
 * - 写入仓库前补全 frontmatter（与 push --skill/--rule 的 buildTargets 同一函数），
 *   坏 YAML 保留原文并提示。
 */

export interface AgentPushOptions {
  /** 把采集范围缩到一个工具 id（多工具同名不同内容时由它表态） */
  tool?: string;
  /** 目标 namespace 目录名；与 push 同规则，多角色多 ns 时必须显式 */
  ns?: string;
  /** 用角色 id 映射目标 namespace */
  role?: string;
}

interface AgentFileCandidate {
  tool: string;
  file: string;
  format: AgentsFormat;
}

function absPath(ctx: CliContext, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(ctx.cwd, value);
}

/** 目录包含判断（平台感知，同 common.ts 的 under）：relative 不为空、不以 .. 开头、不是绝对路径。 */
function underDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && rel !== sep;
}

/** 从文件名去掉该形态的扩展名得到 agent 名（`.agent.md` 双段扩展要先剥）。 */
function stripExt(fileName: string, format: AgentsFormat): string {
  switch (format) {
    case 'md':
      return fileName.endsWith('.md') ? fileName.slice(0, -3) : '';
    case 'agent-md':
      return fileName.endsWith('.agent.md') ? fileName.slice(0, -'.agent.md'.length) : '';
    case 'toml':
      return fileName.endsWith('.toml') ? fileName.slice(0, -5) : '';
    case 'json':
      return fileName.endsWith('.json') ? fileName.slice(0, -5) : '';
  }
}

/** 采集范围：默认全部选定工具；--tool 缩到其中一个（不在选定内则拒绝）。 */
function agentScope(ctx: CliContext, config: Config, options: AgentPushOptions): string[] | null {
  const requested = (options.tool ?? '').trim();
  if (requested === '') {
    if (config.agents.length === 0) {
      ctx.err('错误：还没有选定工具，没有可采集的 agents 落点。');
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

/**
 * 解析输入为候选文件：
 * - 存在的路径 → 必须落在某个选定工具的 agents 目录里（§10：写入/读取范围都收在落点表内）；
 * - 否则按 agent 名在各选定工具的落点里找 `<name><ext>`。
 */
function resolveCandidates(
  ctx: CliContext,
  scope: string[],
  input: string,
): { candidates: AgentFileCandidate[]; error?: string; nextStep?: string } {
  const out = absPath(ctx, input);
  const asPath = existsSync(out) && statSync(out).isFile();
  const targets = scope
    .map((id) => {
      const t = agentsTarget(id, ctx.home, ctx.env);
      return t ? { id, ...t } : null;
    })
    .filter((t): t is { id: string; dir: string; format: AgentsFormat; ext: string } => t !== null);

  if (targets.length === 0) {
    return {
      candidates: [],
      error: `选定的工具（${scope.join(', ')}）都没有用户级 agents 落点，收不到内容`,
      nextStep: 'agents 只下发给表里有落点的工具；团队侧内容请手写进仓库的 agents/ 目录',
    };
  }

  if (asPath) {
    const owner = targets.find((t) => underDir(out, t.dir));
    if (!owner) {
      return {
        candidates: [],
        error: `${out} 不在任何选定工具的 agents 落点里`,
        nextStep: `可选落点：${targets.map((t) => `${t.id}: ${t.dir}`).join('；')}`,
      };
    }
    return { candidates: [{ tool: owner.id, file: out, format: owner.format }] };
  }

  const name = input.trim();
  if (!isValidResourceName(name)) {
    return {
      candidates: [],
      error: `「${input}」既不是存在的文件，也不是合法的 agent 名（只允许小写字母、数字、-、_）`,
      nextStep: '传 agents 落点里的文件路径，或 <name>（如 review-assistant）',
    };
  }
  const candidates: AgentFileCandidate[] = [];
  for (const t of targets) {
    const file = join(t.dir, `${name}${t.ext}`);
    if (existsSync(file) && statSync(file).isFile()) candidates.push({ tool: t.id, file, format: t.format });
  }
  if (candidates.length === 0) {
    return {
      candidates: [],
      error: `在选定工具的 agents 落点里找不到 agent「${name}」（扫描：${targets.map((t) => t.dir).join('；')}）`,
      nextStep: '先在工具目录里写好该 agent，或改传完整路径',
    };
  }
  return { candidates };
}

/** 目标 namespace：--ns 优先；否则 --role/primaryRole 走 manifest 映射；再否则根（全员）。 */
function resolveNamespace(
  ctx: CliContext,
  config: Config,
  snapshot: Snapshot,
  options: AgentPushOptions,
): string | null {
  const explicit = (options.ns ?? '').trim();
  if (explicit !== '') {
    if (!isValidResourceName(explicit)) {
      ctx.err(`错误：--ns「${explicit}」不合法（只允许小写字母、数字、-、_，且不能含 /）`);
      return null;
    }
    return explicit;
  }
  const role = (options.role ?? config.primaryRole ?? '').trim();
  if (role === '') {
    ctx.out('提示：当前没有角色，agent 将推到仓库根目录（全员共享）');
    return '';
  }
  const mapped =
    snapshot.manifest === null ? { namespaces: [], unknownRoles: [role] } : namespacesForRoles(snapshot.manifest, [role]);
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
  ctx.out(`提示：「${role}」不在 manifest/roles.yaml 的角色 id 里，按同名 namespace 目录 agents/${role}/ 推送`);
  return role;
}

export async function agentPushCommand(
  ctx: CliContext,
  input: string,
  options: AgentPushOptions = {},
): Promise<number> {
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
    ctx.err('下一步：确认网络与仓库地址后重跑该命令');
    return 1;
  }
  const snapshot = loaded.snapshot;

  const scope = agentScope(ctx, config, options);
  if (scope === null) return 1;

  const resolved = resolveCandidates(ctx, scope, input);
  if (resolved.error) {
    ctx.err(`错误：${resolved.error}`);
    if (resolved.nextStep) ctx.err(`下一步：${resolved.nextStep}`);
    return 1;
  }
  const candidates = resolved.candidates;

  // 按内容分组：同名不同内容 = 成员在两个工具里养了两个不同的 agent，猜哪个都必错一个。
  const byText = new Map<string, AgentFileCandidate[]>();
  const contents = new Map<AgentFileCandidate, string>();
  for (const c of candidates) {
    const text = readFileSync(c.file, 'utf8');
    contents.set(c, text);
    const group = byText.get(text) ?? [];
    group.push(c);
    byText.set(text, group);
  }
  if (byText.size > 1) {
    ctx.err(`错误：agent「${input}」在 ${candidates.length} 个落点里内容不同：`);
    for (const c of candidates) ctx.err(`  - ${c.tool}：${c.file}`);
    ctx.err('下一步：加 --tool <工具 id>（或直接传那一个文件的完整路径）指明从哪个工具采集');
    return 1;
  }
  const chosen = candidates[0] as AgentFileCandidate;
  const raw = contents.get(chosen) as string;

  const name = stripExt(basename(chosen.file), chosen.format);
  if (name === '') {
    ctx.err(`错误：${chosen.file} 的文件名与 ${chosen.tool} 的 agents 落点扩展名对不上，认不出 agent 名。`);
    return 1;
  }
  if (!isValidResourceName(name)) {
    ctx.err(`错误：agent 名「${name}」不合法（只允许小写字母、数字、-、_）。`);
    return 1;
  }

  const converted = agentToRepoMarkdown(raw, chosen.format);
  if (converted.error || converted.markdown === undefined) {
    ctx.err(`错误：无法从 ${chosen.tool} 的落点文件反向还原成仓库格式：${converted.error ?? '未知原因'}`);
    ctx.err(`文件：${chosen.file}`);
    ctx.err('下一步：改从 md 形态的工具目录采集（--tool <id>），或手写进团队仓库的 agents/ 目录再走 ejdrone push 评审');
    return 1;
  }

  const namespace = resolveNamespace(ctx, config, snapshot, options);
  if (namespace === null) return 1;

  const done = completeFrontmatter(converted.markdown, name);
  if (done.changed) ctx.out(`提示：已为 ${name}.md 补全 frontmatter`);
  if (done.warning) ctx.out(`提示：${name}.md ${done.warning}`);

  const file = namespace === '' ? `agents/${name}.md` : `agents/${namespace}/${name}.md`;
  const existing = snapshot.kinds.agents.some((r) => r.name === name && r.namespace === namespace);
  const verb = existing ? 'update' : 'add';
  const title = `feat(${namespace === '' ? 'root' : namespace}): ${verb} agent ${name}`;
  const body = [
    '由 ejdrone push --agent 生成（反向采集自本机工具的 agents 落点）。',
    '',
    `来源：${chosen.tool} 的 ${chosen.file}`,
    `目标：${file}`,
    '',
    `提交者角色：${config.primaryRole ?? '（未设置）'}`,
    '请评审：内容是否适合团队共享、是否含密钥。',
  ].join('\n');

  ctx.out('待推送：');
  ctx.out(`  agents ${namespace === '' ? '(root)' : `${namespace}/${name}`} ← ${chosen.tool}：${chosen.file}`);

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, {
      files: { [file]: done.content },
      removes: [],
      branchPrefix: `ejdrone/push-agents-${name}-`,
      title,
      body,
    });
    if (outcome.code === 0) {
      ctx.out('提示：合入后其他成员下次会话自动拿到该 agent（各工具按自己的形态转换）。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：采集提交失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查本地 clone（~/.ejdrone/repo 可删除后重建）');
    return 1;
  }
}
