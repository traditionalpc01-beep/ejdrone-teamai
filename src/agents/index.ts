import type { AgentAdapter, AgentRegistry } from '../core/types.js';
import { claudeAdapter } from './claude.js';
import { qoderAdapter } from './qoder-cn.js';
import { cursorAdapter } from './cursor.js';
import { codexAdapter } from './codex.js';
import { dshAdapter } from './dsh.js';
import { qoderIntlAdapter } from './qoder.js';
import { copilotAdapter } from './copilot.js';
import { codebuddyAdapter } from './codebuddy.js';
import { workbuddyAdapter } from './workbuddy.js';
import { opencodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';
import { openclawAdapter } from './openclaw.js';
import { kiroAdapter } from './kiro.js';
import { traeAdapter } from './trae.js';
import { traeCnAdapter } from './trae-cn.js';
import { hermesAdapter } from './hermes.js';
import { zcodeAdapter } from './zcode.js';

/** 顺序必须与 paths.ts 的 TOOL_PATHS 一致 —— 由 test/agents/adapters.test.ts 的 tripwire 守住。 */
export const adapters: AgentAdapter[] = [
  claudeAdapter,
  qoderAdapter,
  cursorAdapter,
  codexAdapter,
  dshAdapter,
  qoderIntlAdapter,
  copilotAdapter,
  codebuddyAdapter,
  workbuddyAdapter,
  opencodeAdapter,
  piAdapter,
  openclawAdapter,
  kiroAdapter,
  traeAdapter,
  traeCnAdapter,
  hermesAdapter,
  zcodeAdapter,
];

/**
 * 只对「已注册适配器」的 id 负责：paths.ts 允许有表项还没写适配器，
 * 若这里取 TOOL_IDS，CLI 会把选不出来的工具 advertise 给用户，init 只会回一句「未知 id」。
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
