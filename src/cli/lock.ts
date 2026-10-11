import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../state.js';

/**
 * 团队仓库的本地 clone 与 ledger 是共享状态。两个 AI 会话同时启动就有两个 pull 交错
 * load/saveLedger，后写的人丢掉先写的人刚记的账 —— 那些文件此后被当成"别人的文件"
 * 永久保留，团队更新再也进不去。push 也操作同一个 checkout，所以共用这把锁。
 */

/** 超过这个时长没结束的锁按死锁处理（进程崩了、或机器休眠后没释放）。 */
const STALE_MS = 5 * 60_000;

export function lockPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), 'sync.lock');
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: string | null };

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
      return { ok: false, holder: readHolder(path) };
    }
  }
  return { ok: false, holder: readHolder(path) };
}

function isStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > STALE_MS;
  } catch {
    // 读不到状态就当作可回收：宁可多试一次创建，也不要把用户永久锁死
    return true;
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
