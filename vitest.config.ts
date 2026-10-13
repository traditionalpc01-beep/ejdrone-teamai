import { defineConfig } from 'vitest/config';

/**
 * Windows 上端到端用例要跑真实 git（init --bare / clone / fetch / merge），
 * 单次子进程开销比 macOS/Linux 高 2-4 倍：真机实测 20s 的默认线会让
 * `contribute --ns` 这类多成员用例超时，把「跑得通但慢」误记成失败。
 * 只在 win32 抬线，POSIX 保持原值——超时阈值本身是回归信号，不该无差别放宽。
 */
const testTimeout = process.platform === 'win32' ? 90000 : 20000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout,
    hookTimeout: testTimeout,
  },
});
