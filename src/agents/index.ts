import type { AgentAdapter, AgentRegistry } from '../core/types.js';
import { TOOL_IDS } from './paths.js';
import { claudeAdapter } from './claude.js';
import { qoderAdapter } from './qoder.js';
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

export const AGENT_IDS: string[] = TOOL_IDS.slice();

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
