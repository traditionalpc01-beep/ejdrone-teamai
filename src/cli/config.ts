import type { Config } from '../core/types.js';
import { loadConfig } from '../state.js';
import type { CliContext } from './context.js';

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string; nextStep: string };

/** 所有命令的第 1 步：没有 config 就别往下走。 */
export function requireConfig(ctx: CliContext): ConfigResult {
  const loaded = loadConfig(ctx.env);
  if (loaded.config) return { ok: true, config: loaded.config };
  if (loaded.error) {
    return { ok: false, error: loaded.error, nextStep: '修正该文件，或用 ejdrone init <repo> --force 重新初始化' };
  }
  return { ok: false, error: '尚未初始化（找不到 config）', nextStep: '运行 ejdrone init <团队仓库地址> 完成初始化' };
}
