import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../state.js';

/**
 * 团队仓库的本地 clone 与 ledger 是共享状态。两个 AI 会话同时启动就有两个 pull 交错
 * load/saveLedger，后写的人丢掉先写的人刚记的账 —— 那些文件此后被当成"别人的文件"
 * 永久保留，团队更新再也进不去。push 也操作同一个 checkout，所以共用这把锁。
 */

/** 提示阈值：锁持有超过这么久，交互报错里提醒成员确认是否真有进程在跑。 */
export const STALE_MS = 5 * 60_000;

export function lockPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'sync.lock');
}

/**
 * 持锁进程还活着吗。进程崩溃/被杀后 pid 不存在（ESRCH）→ 死；EPERM = 存在但非本方
 * 进程 → 活着（保守：绝不抢活进程的锁）；其他错误也保守当活着。
 *
 * 为什么 stale 判定不能只看 mtime（1.0-2.0 的旧做法）：超过 5 分钟的**合法** pull
 * （超大仓库/极慢网络、或机器休眠唤醒后继续跑）会被并发会话误判死锁抢锁，两个 pull
 * 交错写 checkout/ledger，正是这把锁要防的事故形态。回收条件从"时间到了"改成
 * "持锁人确实死了"。
 *
 * 已知退化：锁文件里的 pid 被系统回收复用给另一个活进程时，锁不会被自动回收，
 * 成员按交互提示手动删锁即可 —— 概率远低于误抢活锁，后果是"多等一下"而不是"丢账本"。
 * Windows 上 libuv 对不存在的 pid 同样映射 ESRCH，无需平台分支。
 */
export function isHolderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult =
  | { ok: true; release: () => void }
  | { ok: false; holder: string | null; heldMs: number | null };

/** 锁已被持有多久（毫秒）；读不到状态返回 null。只用于交互提示，不参与回收判定。 */
function heldDuration(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readHolder(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** stale = 持锁人已死（或锁文件读不出 holder）。mtime 不再是回收条件，只作提示。 */
function isStale(path: string): boolean {
  const holder = readHolder(path);
  if (holder === null) return true; // 空文件/被破坏：维持旧行为，可回收
  return !isHolderAlive(Number(holder));
}

export function acquireLock(env?: NodeJS.ProcessEnv): LockResult {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const path = lockPath(env);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        ok: true,
        release: () => {
          try {
            // 只删自己的锁：若本进程的锁已被别人按 stale 回收（时钟跳变/极长卡顿），
            // 这里删掉的就是**新持锁人**的锁 —— 随后第三个进程畅通拿锁，两个 pull
            // 同时写 checkout/ledger，正是这把锁要防的事故。holder 不是本进程 pid
            // 时静默不动（uninstall 等路径也会调 release，不许它抛错）。
            const holder = readHolder(path);
            if (holder !== null && holder !== String(process.pid)) return;
            unlinkSync(path);
          } catch {
            /* 已被 stale 清理或别的进程拿走，不该再把别人的锁删掉 */
          }
        },
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (attempt === 0 && isStale(path)) {
        try {
          unlinkSync(path);
        } catch {
          /* 竞争方刚拿走，下一轮 EEXIST 分支会处理 */
        }
        continue;
      }
      return { ok: false, holder: readHolder(path), heldMs: heldDuration(path) };
    }
  }
  return { ok: false, holder: readHolder(path), heldMs: heldDuration(path) };
}
