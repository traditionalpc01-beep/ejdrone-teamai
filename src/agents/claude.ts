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
import { hookTarget, rulesRoot, skillsRoot, TOOL_PATHS, toolRoot } from './paths.js';
import { planRulesDir } from './rulesdir.js';

const ID = 'claude';

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

export const claudeAdapter: AgentAdapter = {
  id: ID,
  label: spec()?.label ?? 'Claude Code',

  detect(home, env) {
    return isDir(toolRoot(ID, home, env));
  },

  planSkills(skills, home, env) {
    return planSkillWrites(skills, home, env);
  },

  planRules(rules, home, env) {
    const rr = rulesRoot(ID, home, env);
    if (!rr) return [];
    return planRulesDir({ rules, rulesRoot: rr, ext: spec()?.rulesExt ?? 'md' });
  },

  ownsPath(path, home, env) {
    if (under(path, skillsRoot(ID, home, env))) return true;
    const rr = rulesRoot(ID, home, env);
    return rr !== null && under(path, rr);
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
