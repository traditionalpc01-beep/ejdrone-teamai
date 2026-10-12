import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireLock, lockPath } from '../../src/cli/lock.js';

/**
 * sync.lock 的两个 M10 评审修复点（QA D5/D6）：
 * 1. stale 回收看"持锁人死了没有"，不看 mtime——超过 5 分钟的合法 pull 不许被抢锁；
 * 2. release 只删自己的锁——旧持锁人晚到的 release 不许删掉新持锁人的锁。
 */

let dir = '';
const env = (): NodeJS.ProcessEnv => ({ EJDRONE_HOME: dir });

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function fresh(): string {
  dir = join(tmpdir(), `ejdrone-lock-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把锁文件的 mtime 拨到 10 分钟前：证明"时间到了"不再是回收条件。 */
function backdate(): void {
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath(env()), old, old);
}

describe('acquireLock / release', () => {
  it('持锁/释放回归：释放后锁文件消失，可再次获取', () => {
    fresh();
    const first = acquireLock(env());
    expect(first.ok).toBe(true);
    expect(existsSync(lockPath(env()))).toBe(true);
    first.release();
    expect(existsSync(lockPath(env()))).toBe(false);
    const again = acquireLock(env());
    expect(again.ok).toBe(true);
  });

  it('锁被活着的进程持有时：mtime 再旧也不回收（合法长 pull 不许被抢锁）', () => {
    fresh();
    const first = acquireLock(env());
    expect(first.ok).toBe(true);
    backdate();
    const second = acquireLock(env());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder).toBe(String(process.pid));
    // 第一次的锁还在：没被抢
    expect(readFileSync(lockPath(env()), 'utf8')).toBe(`${process.pid}\n`);
    first.release();
  });

  it('持锁人已死（pid 不存在）→ stale 回收成功', () => {
    fresh();
    // 99999999 大于 macOS（≤99999）与 Linux 默认（≤4194304）的 pid 上限，必然 ESRCH
    writeFileSync(lockPath(env()), '99999999\n', 'utf8');
    const second = acquireLock(env());
    expect(second.ok).toBe(true);
  });

  it('release 只删自己的锁：旧持锁人晚到的 release 不许删掉新持锁人的锁', () => {
    fresh();
    // A 拿锁；锁随后被别人按 stale 回收并重写成 B 的 pid（模拟时钟跳变后的抢锁）
    const a = acquireLock(env());
    expect(a.ok).toBe(true);
    writeFileSync(lockPath(env()), '99999999\n', 'utf8');
    a.release(); // A 的 release：holder 不是自己 → 不动
    expect(existsSync(lockPath(env()))).toBe(true); // B 的锁还在
    expect(readFileSync(lockPath(env()), 'utf8')).toBe('99999999\n');
    // B（这里用同进程重新拿锁代替）能正常拿到并释放
    const b = acquireLock(env());
    expect(b.ok).toBe(true);
    b.release();
    expect(existsSync(lockPath(env()))).toBe(false);
  });
});
