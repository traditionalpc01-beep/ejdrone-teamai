import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN_SKILL_NAMES, isValidResourceName } from './constants.js';

/**
 * 内置引导技能的**正文读取口**（T8.4 / T9.2）。
 *
 * 两条技能（`ejdrone-recall`、`ejdrone-share`）写在本仓库的 `skills/<name>/SKILL.md` 里，
 * 由 `ejdrone readme` 随团队说明书一起补进团队仓库，之后 `pull` 把它们当**普通根技能**下发。
 * 之所以在运行时读 markdown 而不是把正文抄成 TS 字符串：抄一遍就有两份真相，
 * 而这两份迟早会漂（1.0 试验记录的缺陷 5 就是这类漂移）。
 *
 * 名单只有一处：`cli/constants.ts` 的 `BUILTIN_SKILL_NAMES`（`push.ts` 的保留名守卫用同一个数组），
 * 这里只做再导出，不再列一遍。
 */
export { BUILTIN_SKILL_NAMES };

export interface BuiltinSkillFile {
  /** 团队仓库里的相对路径，形如 `skills/ejdrone-recall/SKILL.md`（根技能目录约定） */
  repoPath: string;
  content: string;
}

export interface BuiltinSkillRead {
  files: BuiltinSkillFile[];
  /** 降级说明：正文没找到时逐条点名，命令照常工作（缺文件的安装不该让 readme 报错） */
  notes: string[];
}

/** 技能在团队仓库里的路径 —— 与采集层的根技能目录一致，pull 才会把它当普通技能投递。 */
export function builtinSkillRepoPath(name: string): string {
  return `skills/${name}/SKILL.md`;
}

/**
 * 包内技能目录的候选位置，按顺序试（每条名字各自解析，构建产物只缺一半时只点名缺的那条）：
 * - `../../skills/`：源码形态（vitest 直接跑 `src/cli/*.ts`）以及仓库里跑 `dist/cli/*.js`
 *   ——两者都落在仓库根的 `skills/`。
 * - `../skills/`：全局安装后的形态。npm 只发布 `dist/`（package.json 的 files），
 *   仓库根的 `skills/` 不在包里，所以 `npm run build` 的 copy-skills 步骤把它搬到 `dist/skills/`。
 */
const CANDIDATE_RELS = ['../../skills/', '../skills/'] as const;

export function builtinSkillDirs(): string[] {
  const dirs: string[] = [];
  for (const rel of CANDIDATE_RELS) {
    try {
      dirs.push(fileURLToPath(new URL(rel, import.meta.url)));
    } catch {
      // import.meta.url 不是 file:（异常运行环境）→ 少一个候选，交给下一个
    }
  }
  return dirs;
}

/**
 * 从给定目录根读正文。导出是为了单测能指向临时目录，
 * 也为了让 readme 命令在缺文件时只是"跳过并说明"，绝不抛错。
 */
export function readBuiltinSkillsFrom(
  dirs: readonly string[],
  names: readonly string[] = BUILTIN_SKILL_NAMES,
): BuiltinSkillRead {
  const files: BuiltinSkillFile[] = [];
  const notes: string[] = [];
  for (const name of names) {
    if (!isValidResourceName(name)) {
      notes.push(`内置技能名「${name}」不合法（只允许小写字母、数字、-、_），本次跳过这一条`);
      continue;
    }
    const hit = dirs
      .map((dir) => join(dir, name, 'SKILL.md'))
      .find((candidate) => existsSync(candidate));
    if (hit === undefined) {
      notes.push(`内置技能 ${name} 的正文没找到（期望 <包>/skills/${name}/SKILL.md），本次跳过这一条`);
      continue;
    }
    files.push({ repoPath: builtinSkillRepoPath(name), content: readFileSync(hit, 'utf8') });
  }
  return { files, notes };
}

/** 读当前这个已安装的 ejdrone 自带的技能正文。 */
export function readBuiltinSkills(names: readonly string[] = BUILTIN_SKILL_NAMES): BuiltinSkillRead {
  return readBuiltinSkillsFrom(builtinSkillDirs(), names);
}
