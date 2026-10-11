import type { AgentAdapter } from '../core/types.js';
import {
  detectTool,
  installHookFor,
  ownsPathFor,
  planMcpFor,
  planRulesFor,
  planSkillWritesFor,
  specOf,
  uninstallHookFor,
} from './common.js';

const ID = 'pi';

/** 落点、rules 模式、hook 形状全部取自 paths.ts 的表，公共行为在 common.ts；本文件只做组装。 */
export const piAdapter: AgentAdapter = {
  id: ID,
  label: specOf(ID).label,
  detect: (home, env) => detectTool(ID, home, env),
  planSkills: (skills, home, env) => planSkillWritesFor(ID, skills, home, env),
  planRules: (rules, home, env) => planRulesFor(ID, rules, home, env),
  planMcp: (servers, home, env, note) => planMcpFor(ID, servers, home, env, note),
  ownsPath: (path, home, env) => ownsPathFor(ID, path, home, env),
  installHook: (home, env, cmd) => installHookFor(ID, home, env, cmd),
  uninstallHook: (home, env) => uninstallHookFor(ID, home, env),
};
