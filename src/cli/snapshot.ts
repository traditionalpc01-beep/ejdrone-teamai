import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseRolesManifest } from '../core/manifest.js';
import { collectResources } from '../core/resources.js';
import { isCodeupUrl } from '../git/codeup-api.js';
import { syncCheckoutViaApi } from '../git/gitless.js';
import { defaultBranch, ensureClone, fetchReset, scrubCredentials } from '../git/repo.js';
import { hasGitAvailable } from '../platform.js';
import { repoDir, SYNC_INCOMPLETE_MARKER } from '../state.js';
import type { KindSet, RolesManifest } from '../core/types.js';
import { acquireLock, heldByCurrentProcess } from './lock.js';
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

export interface OpenSnapshotOptions {
  /** 缺省现查 hasGitAvailable(ctx.env)；测试显式注入，不猜主机环境 */
  gitAvailable?: boolean;
  /** 缺省 globalThis.fetch；免 git 链路的网络调用经它注入（codeup-api 同规矩） */
  fetchImpl?: typeof fetch;
}

/** clone（或复用已有 clone）→ 同步到默认分支 → 读 manifest 与仓库资源。不写任何工具目录。 */
export async function openSnapshot(
  ctx: CliContext,
  repo: string,
  opts?: OpenSnapshotOptions,
): Promise<SnapshotResult> {
  const dir = repoDir(ctx.env);
  // 显式注入优先，缺省现查：有 git 的机器走原有路径，行为逐字节不变
  const gitAvailable = opts?.gitAvailable ?? hasGitAvailable(ctx.env);
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  try {
    if (!gitAvailable) {
      // 免 git 降级只认 Codeup 托管的团队仓库，其余托管源没有等价的免 git 读路径
      if (!isCodeupUrl(repo)) {
        return {
          ok: false,
          error:
            '本机未检测到 git，无法同步团队仓库。两条路：安装 git 并确保在 PATH 上；' +
            '或把团队仓库迁移到 codeup.aliyun.com 后设置 EJDRONE_CODEUP_TOKEN，走免 git 模式',
        };
      }
      // API 同步是「清空重建」，写窗口比 git 的 reset --hard 长得多；pull 已持 sync.lock
      // 调到这里（acquireLock 不可重入），status/list/doctor 等裸调方在这里自己拿锁。
      // 锁被别的进程占着就失败返回——gitless 同步交错会把 checkout 撕成两半。
      if (!heldByCurrentProcess(ctx.env)) {
        const lock = acquireLock(ctx.env);
        if (!lock.ok) {
          return { ok: false, error: '另一会话正在同步团队仓库（sync.lock 被占用），稍后重试' };
        }
        try {
          const synced = await syncCheckoutViaApi(repo, dir, ctx.env, { fetchImpl });
          return snapshotFromDir(dir, synced.branch, synced.head, []);
        } finally {
          lock.release();
        }
      }
      const synced = await syncCheckoutViaApi(repo, dir, ctx.env, { fetchImpl });
      // relinked 语义不适用（免 git 链路没有本地 origin 可改写），不产生该 warning
      return snapshotFromDir(dir, synced.branch, synced.head, []);
    }
    const clone = await ensureClone(repo, dir, ctx.env);
    const branch = await defaultBranch(dir, ctx.env);
    const handle = await fetchReset(dir, branch, ctx.env);
    // origin 被改写（团队迁了仓库地址）必须让人知道：此前本地一直在同步另一个仓库。
    // URL 过 scrubCredentials（config.repo 本就是用户可见信息，但不带内嵌凭据）；
    // pull 与 doctor 都有 warnings 的现成显示通道（"提示："行），不新造机制。
    const relinkedWarning = clone.relinked
      ? [`本地 checkout 的 origin 已更新为 config 里的仓库地址 ${scrubCredentials(repo)}（此前指向别的仓库）`]
      : [];
    return snapshotFromDir(handle.dir, branch, handle.head, relinkedWarning);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 快照装配，git 与免 git 两条链路共用：manifest 与资源一律从落盘后的 dir 现读。 */
function snapshotFromDir(dir: string, branch: string, head: string, warnings: string[]): SnapshotResult {
  const parsed = parseRolesManifest(dir);
  const collected = collectResources(dir, parsed.manifest);
  return {
    ok: true,
    snapshot: {
      dir,
      head,
      branch,
      manifest: parsed.manifest,
      manifestError: parsed.error ?? null,
      kinds: collected.kinds,
      warnings: [...collected.warnings, ...warnings],
      mcpFileError: collected.mcpFileError,
    },
  };
}

/** 只读已有 checkout（doctor 离线时用），不做网络操作。 */
export function readExistingSnapshot(ctx: CliContext): Snapshot | null {
  const dir = repoDir(ctx.env);
  if (!existsSync(dir)) return null;
  // 免 git 同步中途失败的半截目录带 SYNC_INCOMPLETE_MARKER：把「缺 48 个文件」当团队
  // 真相读出来，doctor 会把缺失资源判成"团队已删除"。带标记一律当作没有本地快照。
  if (existsSync(join(dir, SYNC_INCOMPLETE_MARKER))) return null;
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
