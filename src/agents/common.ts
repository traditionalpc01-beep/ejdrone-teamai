import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import {
  resourceKey,
  type HookInstallOutcome,
  type PlannedWrite,
  type Resource,
} from '../core/types.js';
import { removeHook, upsertHook } from '../hooks.js';
import { hookTarget, rulesBlockPath, rulesRoot, skillsRoot, TOOL_PATHS, toolRoot, type ToolPathSpec } from './paths.js';
import { planRulesBlock } from './block.js';
import { planRulesMdc } from './mdc.js';
import { planRulesDir } from './rulesdir.js';

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
 * skills 子树 + rules 子树归本适配器管。
 * block / none 模式下 rulesRoot 为 null，所以工具的 AGENTS.md 天然不被 own ——
 * 那是用户共享文件，我们只管它里面的标记区块，绝不整体删除。
 */
export function ownsPathFor(id: string, path: string, home: string, env: NodeJS.ProcessEnv): boolean {
  if (under(path, skillsRoot(id, home, env))) return true;
  const rr = rulesRoot(id, home, env);
  return rr !== null && under(path, rr);
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
