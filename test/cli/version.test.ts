import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';

const manifestVersion = (
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/**
 * 版本号的唯一来源是 package.json。这里守住的是发版身份：README 让成员用
 * `ejdrone --version` 确认自己装的是哪一版，所以这个值一旦和清单脱钩，
 * 成员就会拿着旧号以为自己没升级。
 */
describe('ejdrone --version', () => {
  async function run(argv: string[]): Promise<string[]> {
    const lines: string[] = [];
    const code = await runCli(argv, {
      env: { HOME: process.env['HOME'] ?? '' },
      interactive: false,
      out: (text) => lines.push(text),
      err: (text) => lines.push(text),
    });
    expect(code).toBe(0);
    return lines;
  }

  it('--version 打的就是 package.json 里的那个版本', async () => {
    const lines = await run(['--version']);
    expect(lines).toEqual([manifestVersion]);
  });

  it('-v 与 --version 同源', async () => {
    const lines = await run(['-v']);
    expect(lines[0]).toBe(manifestVersion);
  });
});
