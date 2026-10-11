import type { AgentAdapter, AgentRegistry } from '../core/types.js';
import { claudeAdapter } from './claude.js';
import { qoderAdapter } from './qoder-cn.js';
import { cursorAdapter } from './cursor.js';
import { codexAdapter } from './codex.js';
import { dshAdapter } from './dsh.js';

/** 顺序对齐 paths.ts 的 TOOL_PATHS / TOOL_IDS。 */
export const adapters: AgentAdapter[] = [
  claudeAdapter,
  qoderAdapter,
  cursorAdapter,
  codexAdapter,
  dshAdapter,
];

/**
 * 只对「已注册适配器」的 id 负责：paths.ts 允许有表项还没写适配器（分批落地时就会这样），
 * 若这里取 TOOL_IDS，CLI 会把选不出来的工具 advertise 给用户，init 只会回一句「未知 id」。
 * adapters 与 TOOL_PATHS 键集必须一致 —— 由 test/agents/adapters.test.ts 的 tripwire 守住。
 */
export const AGENT_IDS: string[] = adapters.map((a) => a.id);

export function registry(): AgentRegistry {
  const byId = new Map<string, AgentAdapter>(adapters.map((a) => [a.id, a]));
  return {
    all() {
      return adapters;
    },
    byId(id: string) {
      return byId.get(id);
    },
    ids() {
      return AGENT_IDS.slice();
    },
  };
}
