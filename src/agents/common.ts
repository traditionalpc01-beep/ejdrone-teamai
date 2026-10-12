import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import {
  mcpPayload,
  resourceKey,
  type HookInstallOutcome,
  type PlannedWrite,
  type Resource,
} from '../core/types.js';
import { removeHook, upsertHook } from '../hooks.js';
import { referencesEnvVar, resolveMcpResources } from '../core/mcp.js';
import {
  hookTarget,
  mcpTargetPath,
  agentsRoot,
  agentsTarget,
  rulesBlockPath,
  rulesRoot,
  skillsRoot,
  TOOL_PATHS,
  toolRoot,
  type ToolPathSpec,
} from './paths.js';
import { planRulesBlock } from './block.js';
import { planRulesMdc } from './mdc.js';
import { planRulesDir } from './rulesdir.js';
import { mcpMergeResourceKey, renderMcpEntries } from './mcpfmt.js';
import { parseAgentSource, renderAgentChecked } from './agentfmt.js';

/**
 * 16 个适配器的公共层。
 *
 * 1.0 时这五份逻辑在 claude/cursor/qoder-cn/codex/dsh 里逐字重复了一遍，
 * 2.0 扩到 16 个工具再重复 16 遍就是维护地狱 —— 抽到这里，适配器只剩「声明 id + 组装」。
 *
 * rules 的三种落点（rulesdir / mdc / block）分走三个 helper，本文件只做**一处**按表分派；
 * 适配器里不许再出现 mode 判断（见 AGENTS.md「代码形态」）。
 */

export function specOf(id: string): ToolPathSpec {
  const spec = TOOL_PATHS[id];
  if (!spec) throw new Error(`Unknown agent id: ${id}`);
  return spec;
}

export function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function under(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function detectTool(id: string, home: string, env: NodeJS.ProcessEnv): boolean {
  return isDir(toolRoot(id, home, env));
}

export function planSkillWritesFor(
  id: string,
  skills: Resource[],
  home: string,
  env: NodeJS.ProcessEnv,
): PlannedWrite[] {
  const root = skillsRoot(id, home, env);
  const writes: PlannedWrite[] = [];
  for (const skill of skills) {
    const dir = join(root, skill.name);
    for (const [rel, content] of Object.entries(skill.files)) {
      writes.push({ path: join(dir, rel), content, resource: resourceKey('skills', skill.name) });
    }
  }
  return writes;
}

export function planRulesFor(
  id: string,
  rules: Resource[],
  home: string,
  env: NodeJS.ProcessEnv,
): PlannedWrite[] {
  const spec = specOf(id);
  switch (spec.rulesMode) {
    case 'rulesdir': {
      const rr = rulesRoot(id, home, env);
      if (!rr) return [];
      return planRulesDir({ rules, rulesRoot: rr, ext: spec.rulesExt ?? 'md' });
    }
    case 'mdc': {
      const rr = rulesRoot(id, home, env);
      if (!rr) return [];
      return planRulesMdc({ rules, rulesRoot: rr });
    }
    case 'block': {
      const blockPath = rulesBlockPath(id, home, env);
      if (!blockPath) return [];
      return planRulesBlock({ rules, path: blockPath });
    }
    case 'none':
      // 该工具没有可写的 markdown rules 载体（见 paths.ts 表注释），规则不下发给它。
      return [];
  }
}

/**
 * MCP 投递的分派同样只此一处（同 planRulesFor 的做法，适配器一行组装）：
 *  - paths.ts 没给 mcpTarget → 空数组（该工具不支持 MCP 下发）；
 *  - 有 → **恒发恰好一条 merge write**（entries 可为空）。空 entries 的那条就是
 *    "最后一个 server 停投也要清掉账本与成员条目"的指令，缺了它孤儿条目永远留在成员文件里。
 * 条目文本约定、四种形态与 requires 探测在 mcpfmt.ts；点名（缺变量 / 缺可执行 /
 * codex 不支持 sse 的 server）通过 `note` 交给调用方 —— 只含 server 名、变量名、可执行名，绝不含已解析值。
 * 必须能到达用户：静默跳过会让成员以为团队下发了而自己没拿到。
 */
export function planMcpFor(
  id: string,
  servers: Resource[],
  home: string,
  env: NodeJS.ProcessEnv,
  note?: (message: string) => void,
): PlannedWrite[] {
  const target = mcpTargetPath(id, home, env);
  if (!target) return [];
  const label = specOf(id).label;
  const warnings: string[] = [];
  // tools: 缺省 = 所有支持 MCP 的工具；先按目标工具过滤再解析 ${VAR}，
  // 免得发给别的工具的 server 在本工具的点名里刷屏。
  const applicable = servers.filter((r) => {
    const { tools } = mcpPayload(r);
    return !tools || tools.includes(id);
  });
  const { servers: resolved, skipped } = resolveMcpResources(applicable, env);
  for (const s of skipped) {
    warnings.push(`${label}：环境变量未定义 ${s.missing.map((v) => `\${${v}}`).join('、')}，server "${s.name}" 本次跳过`);
  }
  // 只要有一条把 ${VAR} 解析成了明文，这个文件落盘后就必须是 0600。
  const hasResolvedValue = applicable.some((r) => referencesEnvVar(mcpPayload(r)));
  const entries = renderMcpEntries({
    style: target.style,
    pointer: target.pointer,
    servers: resolved,
    env,
    toolLabel: label,
    warnings,
  });
  if (note) for (const message of warnings) note(message);
  return [
    {
      path: target.path,
      // merge 投递的 content 恒为空（§3.3）：文件归成员，apply 层只按 entries 做条目级合并。
      content: '',
      resource: mcpMergeResourceKey(id),
      // 只在真需要收紧时带这个标记：多余的 false 会让 merge 形状与"没解析过值"时不同。
      merge: hasResolvedValue
        ? { format: target.format, pointer: target.pointer, entries, hasResolvedValue }
        : { format: target.format, pointer: target.pointer, entries },
    },
  ];
}

/**
 * skills 子树 + rules 子树 + agents 子树归本适配器管。
 * block / none 模式下 rulesRoot 为 null，所以工具的 AGENTS.md 天然不被 own ——
 * 那是用户共享文件，我们只管它里面的标记区块，绝不整体删除。
 * agents 目录同理：只有表里给了 agentsSubdir 的工具才认领（卸载不留孤儿，
 * 没落点的工具绝不把别人的同名目录认成自己的）。
 */
export function ownsPathFor(id: string, path: string, home: string, env: NodeJS.ProcessEnv): boolean {
  if (under(path, skillsRoot(id, home, env))) return true;
  const rr = rulesRoot(id, home, env);
  if (rr !== null && under(path, rr)) return true;
  const ar = agentsRoot(id, home, env);
  return ar !== null && under(path, ar);
}

/**
 * 子 Agent 投递（M7）的唯一实现处：适配器一行组装，格式转换全在 agentfmt.ts。
 * 与 planMcpFor 同一条原则 —— 查 paths.ts 的 agentsTarget：
 *  - 无落点 → 空数组（该工具不支持 agents 下发；这类适配器干脆不挂 planAgents）；
 *  - 有落点 → 一 agent 一文件 `<dir>/<name><ext>`，namespace 拍平（agents 是 override 语义，
 *    name 不含 ns 段，根条目与 ns 条目本来就互斥）；整文件投递沿用 skills 的形状，
 *    「成员本地改过就不覆盖、只点名」由 core/apply.ts 依 resource 记账免费给出。
 * completeFrontmatter 的 warning（坏 YAML 保留原文投递）在这里没有出口：
 * AgentAdapter.planAgents 的冻结签名不带 note 通道，见回报给协调者的契约观察。
 */
export function planAgentsFor(
  id: string,
  agents: Resource[],
  home: string,
  env: NodeJS.ProcessEnv,
  note?: (message: string) => void,
): PlannedWrite[] {
  const target = agentsTarget(id, home, env);
  if (!target) return [];
  const writes: PlannedWrite[] = [];
  for (const agent of agents) {
    const raw = agent.files['content'] ?? '';
    const spec = parseAgentSource(raw, agent.name);
    const rendered = renderAgentChecked(spec, target.format);
    // 降级必须点名（AGENTS.md §10 相邻红线：跳过不能是静默的）。带上工具 label 是因为
    // 同一条 agent 会投给多个工具，只写 agent 名的话成员分不清是哪个工具那侧出的问题。
    if (rendered.warning !== undefined && note) note(`${specOf(id).label}：${rendered.warning}`);
    writes.push({
      path: join(target.dir, `${agent.name}${target.ext}`),
      content: rendered.content,
      resource: resourceKey('agents', agent.name),
    });
  }
  return writes;
}

export function installHookFor(
  id: string,
  home: string,
  env: NodeJS.ProcessEnv,
  cmd: string,
): HookInstallOutcome {
  const label = specOf(id).label;
  const target = hookTarget(id, home, env);
  if (!target) return { installed: false, reason: `${label} 无用户级 hook 落点，请手动运行 ejdrone pull` };
  // hook 事件名与落点随版本变化（尤以其表内 PROBE 项）：照表尝试注入，
  // 任何失败都降级为 installed:false，绝不抛错中断 pull。
  try {
    upsertHook(target.path, { event: target.event, cmd });
    return { installed: true };
  } catch (e) {
    return { installed: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function uninstallHookFor(id: string, home: string, env: NodeJS.ProcessEnv): void {
  const target = hookTarget(id, home, env);
  if (!target) return;
  removeHook(target.path, target.event);
}
