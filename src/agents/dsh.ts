import type { AgentAdapter } from '../core/types.js';
import {
  detectTool,
  installHookFor,
  ownsPathFor,
  planRulesFor,
  planSkillWritesFor,
  specOf,
  uninstallHookFor,
} from './common.js';

const ID = 'dsh';

/** toolRoot 已内置 DSH_HOME 覆盖：设了 DSH_HOME 就以它为根（只认绝对路径）。 */
export const dshAdapter: AgentAdapter = {
  id: ID,
  label: specOf(ID).label,
  detect: (home, env) => detectTool(ID, home, env),
  planSkills: (skills, home, env) => planSkillWritesFor(ID, skills, home, env),
  planRules: (rules, home, env) => planRulesFor(ID, rules, home, env),
  ownsPath: (path, home, env) => ownsPathFor(ID, path, home, env),
  installHook: (home, env, cmd) => installHookFor(ID, home, env, cmd),
  uninstallHook: (home, env) => uninstallHookFor(ID, home, env),
};
