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

const ID = 'codex';

/** block 模式：rules 写进 ~/.codex/AGENTS.md 的标记区块，区块外内容不动（见 common.ts ownsPathFor）。 */
export const codexAdapter: AgentAdapter = {
  id: ID,
  label: specOf(ID).label,
  detect: (home, env) => detectTool(ID, home, env),
  planSkills: (skills, home, env) => planSkillWritesFor(ID, skills, home, env),
  planRules: (rules, home, env) => planRulesFor(ID, rules, home, env),
  ownsPath: (path, home, env) => ownsPathFor(ID, path, home, env),
  installHook: (home, env, cmd) => installHookFor(ID, home, env, cmd),
  uninstallHook: (home, env) => uninstallHookFor(ID, home, env),
};
