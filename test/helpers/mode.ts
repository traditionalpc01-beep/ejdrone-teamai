import { statSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * 权限位断言的跨平台口径（2026-10-12 Windows 真机试验引出）。
 *
 * 为什么要抽这一层：`chmod 0600` 在 Windows 上是**语义缺失**而不是失败 —— Node 在 NTFS 上
 * 只能表达「只读 / 可写」一位（对应 S_IREAD/S_IWRITE），组与其他用户的位根本不存在，
 * `statSync().mode` 对普通可写文件恒返回 0o666。直接把断言写成 `toBe(0o600)` 会让
 * 真机 Windows 上 9 例无关功能的用例红掉，而把它们一律 skip 掉又会把「我们确实调了 chmod」
 * 这条回归信号一起丢掉。
 *
 * 因此：POSIX 精确断言；win32 断言「不是只读」（这才是 Windows 上唯一真实存在的权限语义），
 * 并把「明文密钥文件的保护来自 %USERPROFILE% 的 NTFS ACL 继承，不是 POSIX 0600」登记为
 * 有意偏差（见 `docs/superpowers/plans/2026-10-11-ejdrone-skills-2.0.md` §7 与
 * `docs/trials/2026-10-13-windows-real-trial.md`）。
 */
export const IS_POSIX = process.platform !== 'win32';

/** 期望文件按 wanted 收紧。win32 上 wanted 不生效，只校验文件可写（NTFS 无组/其他位）。 */
export function expectPrivateMode(path: string, wanted: number): void {
  const mode = statSync(path).mode & 0o777;
  if (!IS_POSIX) {
    // 0o666 = 普通可写文件；0o444 意味着被误设成只读，后续 pull 写不进去，是真缺陷
    expect(mode & 0o200).toBeGreaterThan(0);
    return;
  }
  expect(mode).toBe(wanted);
}

/** 期望文件权限与 expected 一致（用于「不放宽/不误收紧」这类断言）。 */
export function expectMode(path: string, expected: number): void {
  const mode = statSync(path).mode & 0o777;
  if (!IS_POSIX) {
    expect(mode & 0o200).toBeGreaterThan(0);
    return;
  }
  expect(mode).toBe(expected);
}

/** 组与其他用户不可读（POSIX 0600 红线的可断言部分）。 */
export function expectNotGroupReadable(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (!IS_POSIX) {
    expect(mode & 0o200).toBeGreaterThan(0);
    return;
  }
  expect(mode & 0o077).toBe(0);
}
