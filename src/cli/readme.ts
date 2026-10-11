import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir } from '../state.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { submitMrChange } from './mr.js';
import { openSnapshot } from './snapshot.js';
import { teamReadme } from './team-readme.js';

export { teamReadme };

/**
 * 给团队仓库补一份首页说明书。已存在且内容相同则不动 —— 重复跑不该产出空 MR。
 */
export async function readmeCommand(ctx: CliContext): Promise<number> {
  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：确认仓库地址可访问后重跑 ejdrone readme');
    return 1;
  }
  const snapshot = loaded.snapshot;

  const text = teamReadme(config.repo, snapshot.branch);
  const inRepo = join(snapshot.dir, 'README.md');
  if (existsSync(inRepo) && readFileSync(inRepo, 'utf8') === text) {
    ctx.out('README.md 已是最新，无需提交');
    return 0;
  }

  const exists = existsSync(inRepo);
  const outcome = await submitMrChange(ctx, config, snapshot, {
    files: { 'README.md': text },
    removes: [],
    branchPrefix: 'ejdrone/readme-',
    title: exists ? 'docs: 更新团队仓库说明书' : 'docs: 给团队仓库加一份说明书（README）',
    body: [
      exists ? '重新生成 README.md（内容跟随当前仓库地址与默认分支）。' : '让新成员打开仓库首页就知道这是什么、怎么加入、怎么退出。',
      '',
      `合入后成员无需任何操作；没装过的成员运行 \`ejdrone init ${config.repo}\` 即可。`,
    ].join('\n'),
  });

  if (outcome.code === 0 && outcome.branch === null) return 0;
  if (outcome.code === 0 && !exists) {
    ctx.out(`提示：合入后新成员打开仓库首页就能看到加入步骤；本机状态在 ${stateDir(ctx.env)}`);
  }
  return outcome.code;
}
