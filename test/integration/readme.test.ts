import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_SKILL_NAMES, readBuiltinSkills } from '../../src/cli/builtin-skills.js';
import { createHarness, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * `ejdrone readme` 的第二职责（T8.4 / T9.2）：同一个 MR 里把内置引导技能的正文补进团队仓库
 * `skills/<name>/SKILL.md`，之后 `pull` 当**普通根技能**下发 —— 否则 `ejdrone recall` /
 * `ejdrone contribute` 两条命令永远没人告诉 agent 去跑。
 *
 * 四条钉子：
 * 1. MR 变更集 = README.md + 仓库里还没有的技能正文（逐字节等于包内 markdown）；
 * 2. 合入后成员 pull 拿到它们；
 * 3. 幂等，且**团队已有/改过的那份绝不覆盖**（仓库才是唯一真相源，重写等于静默回滚他们的定制）；
 * 4. `push` 侧的保留名守卫照旧生效（成员本地那份推不回仓库）。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

/** 那条 readme 分支相对默认分支的变更集（= MR 会带上的路径；ls-tree 看的是整棵树，不能用）。 */
function mrPaths(member: Member, branch: string): string[] {
  const stdout = execFileSync(
    'git',
    ['-C', member.path('.ejdrone', 'repo'), 'diff', '--name-only', 'origin/main', `origin/${branch}`],
    { encoding: 'utf8', env: member.env },
  );
  return stdout.split('\n').filter((line) => line !== '');
}

function readmeBranches(): string[] {
  return h.remoteBranches().filter((name) => name.startsWith('ejdrone/readme-'));
}

/** 标准前置：有内容但没有 README、没有内置技能的团队仓库 + 一个选了 claude 的 be 角色成员。 */
async function memberWithRepo(label: string): Promise<Member> {
  seedTeamRepo(h);
  const member = h.member(label);
  installTools(member, ['claude']);
  const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
  expect(init.code, init.all).toBe(0);
  expect(member.exists('.ejdrone', 'repo', 'README.md')).toBe(false);
  return member;
}

const RECALL_PATH = 'skills/ejdrone-recall/SKILL.md';

describe('readme 把内置技能一起提交', () => {
  it('MR 里除 README.md 外还有仓库还没有的内置技能，正文逐字节等于包内 markdown', async () => {
    const member = await memberWithRepo('readme-skills-mr');
    const expected = readBuiltinSkills();
    expect(expected.files.length, expected.notes.join('\n')).toBe(BUILTIN_SKILL_NAMES.length);

    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);
    const branch = readmeBranches()[0];
    expect(branch, done.all).toBeTruthy();

    const changed = mrPaths(member, branch as string);
    expect(changed).toContain('README.md');
    expect(changed.filter((p) => p.startsWith('skills/ejdrone-')).sort()).toEqual(
      expected.files.map((f) => f.repoPath).sort(),
    );

    h.mergeIntoMain(branch as string);
    for (const file of expected.files) {
      expect(h.seedRead(file.repoPath)).toBe(file.content);
    }
  });

  it('合入后成员 pull 就把 ejdrone-recall 当普通根技能拿到', async () => {
    const member = await memberWithRepo('readme-skills-pull');
    const recall = readBuiltinSkills(['ejdrone-recall']).files[0];
    expect(recall).toBeTruthy();

    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);
    h.mergeIntoMain(readmeBranches()[0] as string);

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(member.read('.claude', 'skills', 'ejdrone-recall', 'SKILL.md')).toBe(recall?.content);
    // 技能正文里承诺的命令确实存在（这条技能的意义就在"agent 会去跑 recall"）
    expect(recall?.content).toContain('ejdrone recall');
  });

  it('再跑一次 readme 不产出重复 MR', async () => {
    const member = await memberWithRepo('readme-skills-idempotent');
    const first = await member.run(['readme']);
    expect(first.code, first.all).toBe(0);
    h.mergeIntoMain(readmeBranches()[0] as string);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(readmeBranches()).toHaveLength(1);

    const second = await member.run(['readme']);
    expect(second.code, second.all).toBe(0);
    expect(second.all).toContain('无需提交');
    expect(readmeBranches()).toHaveLength(1);
  });

  it('仓库里已有（且被团队改过）的内置技能绝不覆盖：MR 不带那条路径，正文也不变', async () => {
    seedTeamRepo(h);
    const edited = '# 团队定制版\n\n我们自己写的召回说明 EDITED7。\n';
    h.writeSeed(RECALL_PATH, edited);
    h.commitSeed('team already wrote its own recall skill');

    const member = h.member('readme-skills-team-edit');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);
    const branch = readmeBranches()[0] as string;
    const changed = mrPaths(member, branch);
    expect(changed).toContain('README.md');
    expect(changed, '团队已有的内置技能不该被重新提交').not.toContain(RECALL_PATH);
    for (const file of readBuiltinSkills().files.filter((f) => f.repoPath !== RECALL_PATH)) {
      expect(changed, `MR 该带上仓库还没有的 ${file.repoPath}`).toContain(file.repoPath);
    }

    h.mergeIntoMain(branch);
    expect(h.seedRead(RECALL_PATH)).toBe(edited);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    // 定制版就是团队的一份普通根技能：成员机器上拿到的也是它
    expect(member.read('.claude', 'skills', 'ejdrone-recall', 'SKILL.md')).toBe(edited);
  });
});

describe('与 push 保留名守卫的接口', () => {
  it('成员本地那份（pull 投递下来的内置技能）仍被 push 拒绝，仓库里的一份一字未动', async () => {
    const member = await memberWithRepo('readme-push-guard');
    const recall = readBuiltinSkills(['ejdrone-recall']).files[0] as { repoPath: string; content: string };
    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);
    h.mergeIntoMain(readmeBranches()[0] as string);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);

    const pushed = await member.run([
      'push',
      '--skill',
      member.path('.claude', 'skills', 'ejdrone-recall'),
      '--ns',
      'be',
    ]);
    expect(pushed.code, pushed.all).toBe(1);
    expect(pushed.all).toContain('保留名');
    expect(h.seedRead(recall.repoPath)).toBe(recall.content);
  });
});

describe('readme 把行尾约定一起带进仓库（2026-10-13 Windows 真机试验引出）', () => {
  // Git for Windows 安装器默认写 core.autocrlf=true：没有 .gitattributes 时，同一份团队仓库
  // 在 Windows 成员机器上检出 CRLF、mac/Linux 上 LF，成员换 OS 后所有投递内容会被判成
  // 「本地已修改」——全员静默收不到更新。这条钉子把它钉在引导提交里。
  it('仓库没有 .gitattributes → MR 带上它，内容钉死 eol=lf', async () => {
    const member = await memberWithRepo('readme-gitattributes-add');
    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);

    const branch = readmeBranches()[0] as string;
    expect(mrPaths(member, branch)).toContain('.gitattributes');

    h.mergeIntoMain(branch);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(h.seedRead('.gitattributes')).toContain('* text=auto eol=lf');
  });

  it('仓库已有 .gitattributes（团队定制过）→ 绝不覆盖，也不带进 MR', async () => {
    const member = await memberWithRepo('readme-gitattributes-keep');
    h.writeSeed('.gitattributes', '*.md eol=crlf\n');
    h.commitSeed('team pins its own line endings');
    // 成员侧的 checkout 要 pull 一次才看得到：readme 的判据读的是本地 checkout
    expect((await member.run(['pull'])).code).toBe(0);
    expect(member.exists('.ejdrone', 'repo', '.gitattributes')).toBe(true);

    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);
    const branch = readmeBranches()[0] as string;
    expect(mrPaths(member, branch)).not.toContain('.gitattributes');
    expect(h.seedRead('.gitattributes')).toBe('*.md eol=crlf\n');
  });
});
