import { isAbsolute, join } from 'node:path';

/**
 * 16 个工具的路径表 —— 全项目唯一的落点定义处。
 * 某个工具改了目录约定，只改这张表。
 *
 * `probe` 文案带「未核对 / 待真机 / PROBE」的项仍属猜测落点，`ejdrone doctor` 会以 WARN 逐条列出。
 * 核实为准确后请把 probe 字段改成实际值并删掉该注释项，不要留着猜测跑生产。
 *
 * 2.0 落点来源分三档，probe 文案里写清是哪一档：
 * - 真机核对（2026-10-11 本机 macOS）：目录存在且能看到工具自家内容
 * - 部分核对：目录在但无法证明该工具读它（内容级验证待做）
 * - 本机未装：值照 Tencent/teamai-cli 文档或该工具惯例抄，未核格逐一点名
 *
 * `rulesMode: 'none'` = 该工具没有可写的 markdown rules 载体，团队规则不下发给它（doctor 点名，不猜）。
 * `hookFile` 缺席 = 该工具无用户级 hook 落点，`installHook` 返回 installed:false + reason，
 * 成员改用手动 `ejdrone pull`（比装一个不被读的 hook 文件诚实）。
 */

export type RulesMode = 'rulesdir' | 'mdc' | 'block' | 'none';

/**
 * MCP 条目的四种目标形态（2.0 计划 §3.4）。`format` 只到 json/toml 为止 ——
 * merge.ts 与 PlannedWrite.merge 的冻结契约只认这两种；同是 json，
 * Claude 兼容形、opencode 的 mcp 键、copilot 的 tools 允许列表条目形状各不相同，
 * 差异全靠这个 style 字段在**表里**点名，mcpfmt 按它分派，适配器与 mcpfmt 都不许按工具 id 猜。
 */
export type McpTargetStyle = 'json-mcpServers' | 'toml-codex' | 'json-opencode' | 'json-copilot';

export interface ToolPathSpec {
  id: string;
  label: string;
  /** 相对 home 的根目录名 */
  rootRel: string;
  /** 若该环境变量已设置，则以它为根目录、忽略 rootRel（DeepSeek Harness 用） */
  rootEnvVar?: string;
  skillsSubdir: string;
  rulesMode: RulesMode;
  /** rulesdir / mdc 用 */
  rulesSubdir?: string;
  rulesExt?: string;
  /** block 用：根目录下的文件名 */
  rulesBlockFile?: string;
  /** hook 落点：相对根目录的文件名 */
  hookFile?: string;
  hookEvent?: string;
  /**
   * MCP 落点（M6）：成员已在用的共享配置文件，投递是**条目级合并**而非整文件覆写。
   * `file` 相对工具根；`homeFile` 相对 HOME —— 只有 Claude 需要（`~/.claude.json` 不在 `.claude` 下）。
   * `pointer` 指向条目表：JSON 是键路径，TOML 是表名（`mcp_servers` → `[mcp_servers.<name>]`）。
   * `style` 是条目文本的四种目标形态之一（见 McpTargetStyle）；`format` 只喂 merge 引擎（json|toml）。
   * 缺席 = 该工具没有用户级 MCP 落点，`mcp/` 内容不下发给它。
   */
  mcpTarget?: {
    format: 'json' | 'toml';
    style: McpTargetStyle;
    file?: string;
    homeFile?: string;
    pointer: string[];
  };
  /** 待真机确认的说明 */
  probe?: string;
}

export const TOOL_PATHS: Record<string, ToolPathSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    rootRel: '.claude',
    skillsSubdir: 'skills',
    rulesMode: 'rulesdir',
    rulesSubdir: 'rules',
    rulesExt: 'md',
    hookFile: 'settings.json',
    hookEvent: 'SessionStart',
    mcpTarget: { format: 'json', style: 'json-mcpServers', homeFile: '.claude.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11 M5 试验)：~/.claude/skills 投递正常、settings.json 里用户已有的 SessionEnd/Stop 条目不被动、我们那条 SessionStart 幂等；卸载后 settings.json 逐字节回到原样（缩进与结尾换行跟随原文件）。MCP 落点已真机核对：~/.claude.json 顶层就有 mcpServers 表（本机有 4 条成员自己的 server）。rules 目录名沿用投递矩阵（真机无原生 rules 目录，由本工具创建）',
  },
  'qoder-cn': {
    id: 'qoder-cn',
    label: 'Qoder CN',
    rootRel: '.qoder-cn',
    skillsSubdir: 'skills',
    rulesMode: 'rulesdir',
    rulesSubdir: 'rules',
    rulesExt: 'md',
    hookFile: 'settings.json',
    hookEvent: 'SessionStart',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: 'settings.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11 M5 试验)：投递到 ~/.qoder-cn/skills 的技能真的被 Qoder CN 读到了 —— 新会话的可用技能列表里出现了仓库刚投递的 trial-note/trial-ns，属内容级证据（1.0 只核到目录存在）。settings.json 的 hook 条目写入/卸载均正常（是否被 Qoder 触发仍未证）。MCP 落点已真机核对：~/.qoder-cn/settings.json 顶层有 mcpServers（本机有一条 GitHub）。未核对：rules 目录是否被读取',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    rootRel: '.cursor',
    skillsSubdir: 'skills',
    rulesMode: 'mdc',
    rulesSubdir: 'rules',
    rulesExt: 'mdc',
    hookFile: 'hooks.json',
    hookEvent: 'sessionStart',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: 'mcp.json', pointer: ['mcpServers'] },
    probe: '本机未安装 Cursor，未核对，保留 PROBE：rootRel/.cursor、skills 落点与 hook 事件名（随版本变化）均待真机确认；installHook 采取照表尝试、任何失败降级为 installed:false。MCP 落点 ~/.cursor/mcp.json 照 teamai 文档，未核',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    rootRel: '.codex',
    skillsSubdir: 'skills',
    rulesMode: 'block',
    rulesBlockFile: 'AGENTS.md',
    hookFile: 'hooks.json',
    hookEvent: 'SessionStart',
    mcpTarget: { format: 'toml', style: 'toml-codex', file: 'config.toml', pointer: ['mcp_servers'] },
    probe: '已真机核对(2026-10-11)：~/.codex/skills 与 AGENTS.md 均存在（skills 与 block 落点确认）。注：真机另有原生 ~/.codex/rules 目录，但投递矩阵规定 codex 走 AGENTS.md 区块。MCP 落点已真机核对：~/.codex/config.toml 用 [mcp_servers.<name>] 表（本机已有成员手写若干条，含 .env 子表）。hook 落点 hooks.json 未核对（真机只见 config.toml，无 hooks.json），保留 PROBE',
  },
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    rootRel: '.dsh',
    rootEnvVar: 'DSH_HOME',
    skillsSubdir: 'skills',
    rulesMode: 'block',
    rulesBlockFile: 'AGENTS.md',
    hookFile: 'hooks.json',
    hookEvent: 'SessionStart',
    probe: '本机未安装 DeepSeek Harness（无 ~/.dsh、DSH_HOME 未设置），未核对，保留 PROBE：DSH_HOME 未设置时回落 ~/.dsh；skills 落点与 hook 落点均待真机确认',
  },
  qoder: {
    id: 'qoder',
    label: 'Qoder',
    rootRel: '.qoder',
    skillsSubdir: 'skills',
    rulesMode: 'rulesdir',
    rulesSubdir: 'rules',
    rulesExt: 'md',
    hookFile: 'settings.json',
    hookEvent: 'SessionStart',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: 'mcp.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11)：~/.qoder/skills 存在，skills 落点确认；MCP 落点已真机核对 —— ~/.qoder/mcp.json 顶层就是 mcpServers（空表，形状与 Claude 兼容）。未核对：~/.qoder 下无 rules 目录（由本工具创建，Qoder 是否读取未知）、settings.json 存在但没有 hooks 键（Qoder 国际版是否按 Claude 兼容形读 SessionStart 待真机）',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    rootRel: '.copilot',
    rootEnvVar: 'COPILOT_HOME',
    skillsSubdir: 'skills',
    rulesMode: 'block',
    rulesBlockFile: 'AGENTS.md',
    mcpTarget: { format: 'json', style: 'json-copilot', file: 'mcp-config.json', pointer: ['mcpServers'] },
    probe: '本机未安装 GitHub Copilot CLI，未核对，保留 PROBE：rootRel ~/.copilot 与 COPILOT_HOME 覆盖照 teamai 文档；skills 子目录、AGENTS.md 区块均未核。MCP 落点 $COPILOT_HOME/mcp-config.json 照 teamai 文档，其条目要带 tools:["*"] 且 stdio 写成 type:"local"，未核。无用户级 hook 落点（teamai 只记载项目级 .github/hooks/，且 Copilot 不读 ~/.claude/settings.json），故不设 hookFile',
  },
  codebuddy: {
    id: 'codebuddy',
    label: 'CodeBuddy',
    rootRel: '.codebuddy',
    skillsSubdir: 'skills',
    rulesMode: 'none',
    hookFile: 'settings.json',
    hookEvent: 'SessionStart',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: '.mcp.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11)：~/.codebuddy/skills 存在且含工具自家 skill 目录，skills 落点确认。待真机：该机器上没有 ~/.codebuddy/settings.json，hookFile/hookEvent 照 CodeBuddy 的 Claude 兼容血统推断；无原生 markdown rules 目录，rules 置 none。MCP 照 teamai 记载 CodeBuddy 只读三个文件里的第一个（.mcp.json → mcp.json → ~/.codebuddy.json），我们只写首选 ~/.codebuddy/.mcp.json，那套"读哪个看先后"的搬迁逻辑不做，留 PROBE',
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    rootRel: '.workbuddy',
    skillsSubdir: 'skills',
    rulesMode: 'none',
    hookFile: 'settings.json',
    hookEvent: 'SessionStart',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: 'mcp.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11)：~/.workbuddy/skills 存在，skills 落点确认；MCP 落点已真机核对 —— ~/.workbuddy/mcp.json 顶层是 mcpServers（空表）。未核对：~/.workbuddy/settings.json 存在但只有 app 状态键（enabledPlugins/claw/sandbox/skillOverrides…），无 hooks 键，是否按 Claude 兼容形读 hook 待真机；无 markdown rules 目录，rules 置 none',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    rootRel: '.config/opencode',
    skillsSubdir: 'skills',
    rulesMode: 'block',
    rulesBlockFile: 'AGENTS.md',
    mcpTarget: { format: 'json', style: 'json-opencode', file: 'opencode.json', pointer: ['mcp'] },
    probe: '本机未安装 OpenCode（无 ~/.config/opencode），未核对，保留 PROBE：rootRel 用多级 ~/.config/opencode（照 teamai 的 opencode.json 位置）；skills 子目录与 AGENTS.md 区块均未核。MCP 照 teamai 落在共享 opencode.json 的 mcp 键（stdio 写成 type:"local"，远程写 type:"remote"），未核。无用户级 JSON hook 落点可复用我们的 upsertHook 形状，故不设 hookFile',
  },
  pi: {
    id: 'pi',
    label: 'Pi Coding Agent',
    rootRel: '.pi',
    skillsSubdir: 'agent/skills',
    rulesMode: 'none',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: 'agent/mcp.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11)：~/.pi/agent/skills 存在，skills 落点（多级）确认。rules 置 none：~/.pi 下无 rules 目录也无 AGENTS.md。MCP 落点 ~/.pi/agent/mcp.json 照 teamai 文档，本机该文件不存在，未核。不设 hook：teamai 记载 Pi 仅支持其内置生命周期桥接，不接受团队自定义 hook',
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    rootRel: '.openclaw',
    skillsSubdir: 'skills',
    rulesMode: 'none',
    probe: '已真机核对(2026-10-11)：~/.openclaw/skills 存在（同目录另有 agents/、workspace/、openclaw.json），skills 落点确认。不设 hook：OpenClaw 的 hook 是 workspace 级、需在 openclaw.json 启用条目，与本项目「只有 user scope」的前提冲突，照 teamai 的警告结论处理为无 hook。rules 置 none',
  },
  kiro: {
    id: 'kiro',
    label: 'Kiro',
    rootRel: '.kiro',
    skillsSubdir: 'skills',
    rulesMode: 'none',
    mcpTarget: { format: 'json', style: 'json-mcpServers', file: 'settings/mcp.json', pointer: ['mcpServers'] },
    probe: '已真机核对(2026-10-11)：~/.kiro/skills 存在且含工具自家 skill 目录，skills 落点确认。不设 hook：teamai 记载 Kiro 的 SessionStart 由 agent 同步以 hooks.agentSpawn 内嵌，只存在于已同步的 agent 中，无用户级 JSON 落点。rules 置 none（~/.kiro 下无 rules/ 也无 AGENTS.md）。MCP 落点 ~/.kiro/settings/mcp.json 照 Kiro 官方文档与 teamai 表，本机该目录不存在，未核',
  },
  trae: {
    id: 'trae',
    label: 'Trae',
    rootRel: '.trae',
    skillsSubdir: 'skills',
    rulesMode: 'rulesdir',
    rulesSubdir: 'rules',
    rulesExt: 'md',
    probe: '已真机核对(2026-10-11)：~/.trae/skills 与 ~/.trae/rules/*.md 均原生存在（rules 目录里是工具自家 markdown 规则文件），skills 与 rules 落点确认。不设 hook：~/.trae 下没有可写的 JSON hook 落点（只有 argv.json/binaries/extensions/tools），hookFile/hookEvent 待真机',
  },
  'trae-cn': {
    id: 'trae-cn',
    label: 'Trae CN',
    rootRel: '.trae-cn',
    skillsSubdir: 'skills',
    rulesMode: 'rulesdir',
    rulesSubdir: 'user_rules',
    rulesExt: 'md',
    probe: '已真机核对(2026-10-11)：~/.trae-cn/skills 存在，skills 落点确认；~/.trae-cn/user_rules 目录存在但为空，故 rules 落点属部分核对（目录名取自真机、内容级"是否被读取"未证）。不设 hook：无 JSON hook 落点',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    rootRel: '.hermes',
    skillsSubdir: 'skills',
    rulesMode: 'none',
    probe: '已真机核对(2026-10-11)：~/.hermes/skills 存在，skills 落点确认。不设 hook：~/.hermes/hooks 是空目录而非 JSON 配置文件，我们的 upsertHook 只支持 {hooks:{Event:[…]}} 形状，硬写会造出该工具不认的文件；hermes 的 hook 契约待真机确认。rules 置 none（另有 config.yaml，非 markdown rules 载体）',
  },
};

export const TOOL_IDS = Object.keys(TOOL_PATHS);

/** 该工具的根目录绝对路径（含 env 覆盖） */
export function toolRoot(id: string, home: string, env: NodeJS.ProcessEnv): string {
  const spec = spec_(id);
  if (spec.rootEnvVar) {
    const fromEnv = env[spec.rootEnvVar];
    // 只接受绝对路径：GUI 启动的 agent 的 cwd 不可预测，相对值会把投递写到随机目录并留下孤儿。
    if (fromEnv && isAbsolute(fromEnv.trim())) return fromEnv.trim();
  }
  return join(home, spec.rootRel);
}

export function skillsRoot(id: string, home: string, env: NodeJS.ProcessEnv): string {
  const spec = spec_(id);
  return join(toolRoot(id, home, env), spec.skillsSubdir);
}

export function rulesRoot(id: string, home: string, env: NodeJS.ProcessEnv): string | null {
  const spec = spec_(id);
  if (!spec.rulesSubdir) return null;
  return join(toolRoot(id, home, env), spec.rulesSubdir);
}

/** block 模式的 AGENTS.md 绝对路径；非 block 模式返回 null */
export function rulesBlockPath(id: string, home: string, env: NodeJS.ProcessEnv): string | null {
  const spec = spec_(id);
  if (spec.rulesMode !== 'block' || !spec.rulesBlockFile) return null;
  return join(toolRoot(id, home, env), spec.rulesBlockFile);
}

export function hookTarget(id: string, home: string, env: NodeJS.ProcessEnv): { path: string; event: string } | null {
  const spec = spec_(id);
  if (!spec.hookFile || !spec.hookEvent) return null;
  return { path: join(toolRoot(id, home, env), spec.hookFile), event: spec.hookEvent };
}

/**
 * MCP 落点（M6）。返回 null = 该工具没有用户级 MCP 配置，团队 server 不下发给它。
 * `homeFile` 走 HOME 而不是工具根：Claude 的 `~/.claude.json` 就不在 `~/.claude/` 下。
 * `style` 是给 mcpfmt 的条目形态分派用；`format`/`pointer` 原样进 PlannedWrite.merge。
 */
export function mcpTargetPath(
  id: string,
  home: string,
  env: NodeJS.ProcessEnv,
): { path: string; format: 'json' | 'toml'; style: McpTargetStyle; pointer: string[] } | null {
  const spec = spec_(id);
  const target = spec.mcpTarget;
  if (!target) return null;
  if (target.homeFile) {
    return { path: join(home, target.homeFile), format: target.format, style: target.style, pointer: target.pointer };
  }
  if (!target.file) return null;
  return {
    path: join(toolRoot(id, home, env), target.file),
    format: target.format,
    style: target.style,
    pointer: target.pointer,
  };
}

function spec_(id: string): ToolPathSpec {
  const spec = TOOL_PATHS[id];
  if (!spec) throw new Error(`Unknown agent id: ${id}`);
  return spec;
}
