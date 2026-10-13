import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readBuiltinSkills } from './builtin-skills.js';
import { stateDir } from '../state.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { submitMrChange } from './mr.js';
import { openSnapshot } from './snapshot.js';
import { teamGitattributes, teamReadme } from './team-readme.js';

export { teamReadme };

/**
 * 给团队仓库补一份首页说明书，并顺手把内置引导技能（`skills/<name>/SKILL.md`，两条）补进仓库 —— 同一个 MR。
 *
 * 已存在且内容相同的东西一律不动，重复跑不该产出空 MR；**仓库里已有的技能目录更是绝不覆盖** ——
 * 团队改过的那份是他们评审过的资产，重写它等于静默回滚他们的定制，而仓库才是唯一真相源。
 * 技能进了仓库之后就是普通根技能：`pull` 照常下发，成员可删可改（T8.4）。
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
  const readmeExists = existsSync(inRepo);

  const files: Record<string, string> = {};
  if (!readmeExists || readFileSync(inRepo, 'utf8') !== text) files['README.md'] = text;

  // 行尾约定跟着这份 MR 一起进仓库：Windows 成员默认 core.autocrlf=true，缺了它同一份团队
  // 仓库在两种 OS 上检出不同字节，换机后全部投递内容会被判成「本地已修改」。
  // 仓库里已有就不带 —— 团队可能定制过（比如加了自有二进制规则），覆盖等于绕过评审。
  const gitattributesExists = existsSync(join(snapshot.dir, '.gitattributes'));
  if (!gitattributesExists) files['.gitattributes'] = teamGitattributes();

  const skills = readBuiltinSkills();
  for (const note of skills.notes) ctx.out(`提示：${note}`);
  const addedSkills: string[] = [];
  for (const skill of skills.files) {
    if (existsSync(join(snapshot.dir, skill.repoPath))) continue;
    files[skill.repoPath] = skill.content;
    addedSkills.push(skill.repoPath);
  }

  if (Object.keys(files).length === 0) {
    ctx.out('README.md、内置技能与 .gitattributes 都已是最新，无需提交');
    return 0;
  }

  const body: string[] = [];
  if (files['README.md'] !== undefined) {
    body.push(
      readmeExists
        ? '重新生成 README.md（内容跟随当前仓库地址与默认分支）。'
        : '让新成员打开仓库首页就知道这是什么、怎么加入、怎么退出。',
    );
  }
  if (files['.gitattributes'] !== undefined) {
    body.push(
      '加上 `.gitattributes`（`* text=auto eol=lf`）：Git for Windows 默认 `core.autocrlf=true`，',
      '缺了它同一份团队仓库在 Windows 成员机器上检出是 CRLF、mac/Linux 是 LF，',
      '成员换操作系统后所有投递内容会被判成「本地已修改」而收不到更新。',
    );
  }
  if (addedSkills.length > 0) {
    body.push(
      `同时补上内置引导技能：${addedSkills.map((p) => `\`${p}\``).join('、')}。`,
      '它们教 agent 动手前先 `ejdrone recall` 做一次检索预检、踩坑后用 `ejdrone contribute` 沉淀经验；',
      '进仓库后就是普通根技能，成员 `pull` 即得。仓库里已有同名目录的本次一律没动 —— 要定制就直接改这些文件并走 MR。',
    );
  }
  body.push('', `合入后成员无需任何操作；没装过的成员运行 \`ejdrone init ${config.repo}\` 即可。`);

  const outcome = await submitMrChange(ctx, config, snapshot, {
    files,
    removes: [],
    branchPrefix: 'ejdrone/readme-',
    title:
      addedSkills.length > 0
        ? 'docs: 补团队说明书、内置引导技能与行尾约定'
        : readmeExists
          ? 'docs: 更新团队仓库说明书'
          : 'docs: 给团队仓库加一份说明书（README）',
    body: body.join('\n'),
  });

  if (outcome.code === 0 && outcome.branch === null) return 0;
  if (outcome.code === 0 && addedSkills.length > 0) {
    ctx.out('提示：合入后内置技能随 pull 下发给所有成员；`ejdrone push` 不允许覆盖这些保留名，改它们请直接在仓库里改并走 MR。');
  }
  if (outcome.code === 0 && !readmeExists) {
    ctx.out(`提示：合入后新成员打开仓库首页就能看到加入步骤；本机状态在 ${stateDir(ctx.env)}`);
  }
  return outcome.code;
}
