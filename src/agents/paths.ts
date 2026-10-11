import { isAbsolute, join } from 'node:path';

/**
 * 5 个工具的路径表 —— 全项目唯一的落点定义处。
 * 某个工具改了目录约定，只改这张表。
 *
 * `PROBE` 标记项：M1 必须在真机确认（见设计文档 §5）。确认为准后请把 probe 字段
 * 改成实际值并删除该注释项，不要留着猜测跑生产。
 */

export type RulesMode = 'rulesdir' | 'mdc' | 'block' | 'none';

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
    probe: '已真机核对(2026-10-11)：~/.claude/skills 与 settings.json 均存在，skills 与 hook 落点确认；rules 目录名沿用投递矩阵（真机无原生 rules 目录，由本工具创建）',
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
    probe: '已真机核对(2026-10-11)：~/.qoder-cn/skills 与 settings.json 均存在，故 skills 与 hook 落点确认；rules 目录名沿用投递矩阵（真机无原生 rules 目录，由本工具创建）',
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
    probe: '本机未安装 Cursor，未核对，保留 PROBE：rootRel/.cursor、skills 落点与 hook 事件名（随版本变化）均待真机确认；installHook 采取照表尝试、任何失败降级为 installed:false',
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
    probe: '已真机核对(2026-10-11)：~/.codex/skills 与 AGENTS.md 均存在（skills 与 block 落点确认）。注：真机另有原生 ~/.codex/rules 目录，但投递矩阵规定 codex 走 AGENTS.md 区块。hook 落点 hooks.json 未核对（真机只见 config.toml，无 hooks.json），保留 PROBE',
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

function spec_(id: string): ToolPathSpec {
  const spec = TOOL_PATHS[id];
  if (!spec) throw new Error(`Unknown agent id: ${id}`);
  return spec;
}
