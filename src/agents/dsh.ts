import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  resourceKey,
  type AgentAdapter,
  type HookInstallOutcome,
  type PlannedWrite,
  type Resource,
} from '../core/types.js';
import { removeHook, upsertHook } from '../hooks.js';
import { hookTarget, rulesBlockPath, skillsRoot, TOOL_PATHS, toolRoot } from './paths.js';
import { planRulesBlock } from './block.js';

const ID = 'dsh';

function spec() {
  return TOOL_PATHS[ID];
}

function isDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function under(p: string, dir: string): boolean {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function planSkillWrites(skills: Resource[], home: string, env: NodeJS.ProcessEnv): PlannedWrite[] {
  const root = skillsRoot(ID, home, env);
  const writes: PlannedWrite[] = [];
  for (const skill of skills) {
    const dir = join(root, skill.name);
    for (const [rel, content] of Object.entries(skill.files)) {
      writes.push({ path: join(dir, rel), content, resource: resourceKey('skills', skill.name) });
    }
  }
  return writes;
}

export const dshAdapter: AgentAdapter = {
  id: ID,
  label: spec()?.label ?? 'DeepSeek Harness',

  detect(home, env) {
    // toolRoot 已内置 DSH_HOME env 覆盖：设了 DSH_HOME 就以它为根。
    return isDir(toolRoot(ID, home, env));
  },

  planSkills(skills, home, env) {
    return planSkillWrites(skills, home, env);
  },

  planRules(rules, home, env) {
    const blockPath = rulesBlockPath(ID, home, env);
    if (!blockPath) return [];
    return planRulesBlock({ rules, path: blockPath });
  },

  ownsPath(path, home, env) {
    // block 模式：AGENTS.md 是用户共享文件，只管理其内区块，不能整体删除。
    return under(path, skillsRoot(ID, home, env));
  },

  installHook(home, env, cmd): HookInstallOutcome {
    const target = hookTarget(ID, home, env);
    if (!target) return { installed: false, reason: `${this.label} v1 无 hook 机制，请手动运行 ejdrone pull` };
    try {
      upsertHook(target.path, { event: target.event, cmd });
      return { installed: true };
    } catch (e) {
      return { installed: false, reason: e instanceof Error ? e.message : String(e) };
    }
  },

  uninstallHook(home, env) {
    const target = hookTarget(ID, home, env);
    if (!target) return;
    removeHook(target.path, target.event);
  },
};
