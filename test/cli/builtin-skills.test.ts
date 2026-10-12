import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_SKILL_NAMES,
  builtinSkillDirs,
  builtinSkillRepoPath,
  readBuiltinSkills,
  readBuiltinSkillsFrom,
} from '../../src/cli/builtin-skills.js';
import { BUILTIN_SKILL_NAMES as SAME_LIST_FROM_CONSTANTS } from '../../src/cli/constants.js';

/**
 * 内置引导技能的正文读取口（T8.4 / T9.2）。
 * `ejdrone readme` 靠它把 `skills/<name>/SKILL.md` 随说明书一起补进团队仓库，
 * 之后 pull 当普通根技能下发。两条要求钉在这里：
 * - 读的是**包内 markdown**，不是抄进 TS 的字符串常量（抄两份必漂）；
 * - 正文缺失只"跳过并说明"，**绝不抛错** —— 没有 skills 目录的安装也要能让 readme 跑完。
 * 不碰网络、不碰真实 HOME：临时目录 + 包内真实 skills/ 两条路径都够用。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ejdrone-builtin-skills-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readBuiltinSkillsFrom：目录注入版', () => {
  it('存在的技能返回 { repoPath, content }，repoPath 用仓库里的根技能路径', () => {
    const md = '---\nname: alpha\n---\n\n# Alpha\n\n正文。\n';
    mkdirSync(join(dir, 'alpha'), { recursive: true });
    writeFileSync(join(dir, 'alpha', 'SKILL.md'), md, 'utf8');

    const read = readBuiltinSkillsFrom([dir], ['alpha']);
    expect(read.notes).toEqual([]);
    expect(read.files).toEqual([{ repoPath: 'skills/alpha/SKILL.md', content: md }]);
  });

  it('缺正文的技能不进 files，只留一条说明；不抛错', () => {
    const read = readBuiltinSkillsFrom([dir], ['没有这一条']);
    expect(read.files).toEqual([]);
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]).toContain('没有这一条');
    expect(read.notes[0]).toContain('跳过');
  });

  it('混合时逐条处理：有正文的照常返回，缺的只点名', () => {
    mkdirSync(join(dir, 'present'), { recursive: true });
    writeFileSync(join(dir, 'present', 'SKILL.md'), '# Present\n', 'utf8');
    const read = readBuiltinSkillsFrom([dir], ['present', 'absent']);
    expect(read.files.map((f) => f.repoPath)).toEqual(['skills/present/SKILL.md']);
    expect(read.notes).toHaveLength(1);
  });

  it('多个候选目录时逐条取第一个命中的（构建产物只有一半时不全盘失败）', () => {
    const other = join(dir, 'other');
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(other, 'a'), { recursive: true });
    mkdirSync(join(other, 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'SKILL.md'), 'FIRST\n', 'utf8');
    writeFileSync(join(other, 'a', 'SKILL.md'), 'SECOND\n', 'utf8');
    writeFileSync(join(other, 'b', 'SKILL.md'), 'ONLY-SECOND\n', 'utf8');

    const read = readBuiltinSkillsFrom([dir, other], ['a', 'b']);
    expect(read.files).toEqual([
      { repoPath: 'skills/a/SKILL.md', content: 'FIRST\n' },
      { repoPath: 'skills/b/SKILL.md', content: 'ONLY-SECOND\n' },
    ]);
    expect(read.notes).toEqual([]);
  });

  it('非法名字（路径穿越一类）不进 files，只点名', () => {
    const read = readBuiltinSkillsFrom([dir], ['../../etc']);
    expect(read.files).toEqual([]);
    expect(read.notes[0]).toContain('不合法');
  });
});

describe('名单只有一处', () => {
  it('再导出的 BUILTIN_SKILL_NAMES 就是 constants.ts 那个数组（push 侧守卫共用同一份）', () => {
    expect(BUILTIN_SKILL_NAMES).toBe(SAME_LIST_FROM_CONSTANTS);
    expect(BUILTIN_SKILL_NAMES).toContain('ejdrone-recall');
  });

  it('builtinSkillRepoPath 与采集层的根技能目录约定一致', () => {
    expect(builtinSkillRepoPath('ejdrone-recall')).toBe('skills/ejdrone-recall/SKILL.md');
  });
});

describe('readBuiltinSkills：包内真实正文', () => {
  /** test/cli/*.ts → ../../ 与 src/cli/*.ts → ../../ 同深度，都落在仓库根的 skills/ */
  const repoSkills = fileURLToPath(new URL('../../skills/', import.meta.url));

  it('候选目录至少包含仓库根的 skills/', () => {
    expect(builtinSkillDirs().some((d) => d === repoSkills)).toBe(true);
  });

  it('ejdrone-recall 读到的就是仓库里那份 markdown（逐字节，不是 TS 里的抄本）', () => {
    const read = readBuiltinSkills(['ejdrone-recall']);
    expect(read.notes, read.notes.join('\n')).toEqual([]);
    expect(read.files).toHaveLength(1);
    expect(read.files[0]?.repoPath).toBe('skills/ejdrone-recall/SKILL.md');
    expect(read.files[0]?.content).toBe(readFileSync(join(repoSkills, 'ejdrone-recall', 'SKILL.md'), 'utf8'));
    expect(read.files[0]?.content).toContain('name: ejdrone-recall');
  });

  it('默认全量读：每条名字要么给正文要么给说明，绝不抛错、绝不重复', () => {
    const read = readBuiltinSkills();
    const paths = read.files.map((f) => f.repoPath);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length + read.notes.length).toBe(BUILTIN_SKILL_NAMES.length);
    for (const path of paths) expect(path).toMatch(/^skills\/[a-z0-9_-]+\/SKILL\.md$/);
  });

  it('名字根本不存在时（老安装没有 skills 目录的形状）降级为点名，不抛', () => {
    const read = readBuiltinSkills(['ejdrone-definitely-not-here']);
    expect(read.files).toEqual([]);
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0]).toContain('没找到');
  });

  it('名单里每条的正文都在仓库里就位（缺一条 readme 就少提交一条，这里钉住现状）', () => {
    const missing = BUILTIN_SKILL_NAMES.filter((name) => !existsSync(join(repoSkills, name, 'SKILL.md')));
    expect(missing, `内置技能正文缺失：${missing.join(', ')}`).toEqual([]);
  });
});
