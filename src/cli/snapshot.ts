import { existsSync } from 'node:fs';

import { parseRolesManifest } from '../core/manifest.js';
import { collectResources } from '../core/resources.js';
import { defaultBranch, ensureClone, fetchReset } from '../git/repo.js';
import { repoDir } from '../state.js';
import type { KindSet, RolesManifest } from '../core/types.js';
import type { CliContext } from './context.js';

export interface Snapshot {
  dir: string;
  head: string;
  /** 远端默认分支名 */
  branch: string;
  manifest: RolesManifest | null;
  /** 非空 → 必须全量停发（设计文档 §9） */
  manifestError: string | null;
  /** 仓库里的全部资源，按 kind 分组（skills / rules / mcp） */
  kinds: KindSet;
  warnings: string[];
  /**
   * mcp 列表文件的文件级解析失败（非空时 kinds.mcp 为空集）。
   * delivery 层必须像 haltedKinds 一样让 mcp 整体停发（已装内容不动）——
   * 当成"团队删光了所有 server"处理会把全员已装条目清空。
   */
  mcpFileError: string | null;
}

export type SnapshotResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

/** clone（或复用已有 clone）→ 同步到默认分支 → 读 manifest 与仓库资源。不写任何工具目录。 */
export async function openSnapshot(ctx: CliContext, repo: string): Promise<SnapshotResult> {
  const dir = repoDir(ctx.env);
  try {
    await ensureClone(repo, dir, ctx.env);
    const branch = await defaultBranch(dir, ctx.env);
    const handle = await fetchReset(dir, branch, ctx.env);
    const parsed = parseRolesManifest(handle.dir);
    const collected = collectResources(handle.dir, parsed.manifest);
    return {
      ok: true,
      snapshot: {
        dir: handle.dir,
        head: handle.head,
        branch,
        manifest: parsed.manifest,
        manifestError: parsed.error ?? null,
        kinds: collected.kinds,
        warnings: collected.warnings,
        mcpFileError: collected.mcpFileError,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 只读已有 checkout（doctor 离线时用），不做网络操作。 */
export function readExistingSnapshot(ctx: CliContext): Snapshot | null {
  const dir = repoDir(ctx.env);
  if (!existsSync(dir)) return null;
  const parsed = parseRolesManifest(dir);
  const collected = collectResources(dir, parsed.manifest);
  return {
    dir,
    head: '',
    branch: '',
    manifest: parsed.manifest,
    manifestError: parsed.error ?? null,
    kinds: collected.kinds,
    warnings: collected.warnings,
    mcpFileError: collected.mcpFileError,
  };
}
