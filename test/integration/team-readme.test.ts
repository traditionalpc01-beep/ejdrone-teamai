import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { teamReadme } from '../../src/cli/readme.js';
import { createHarness, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * 团队仓库必须自己解释自己：新同事打开仓库首页就能看到"这是什么、怎么加入、怎么退出"，
 * 而不是靠口头传。空仓库的引导提交自带 README.md，已有仓库用 ejdrone readme 补一份。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.cleanup();
});

const REPO = 'https://gitlab.example.com/team/ejdrone-teamai.git';

describe('README 模板', () => {
  it('包含仓库地址与加入命令，成员照着敲就能进', () => {
    const text = teamReadme(REPO, 'main');
    expect(text).toContain(REPO);
    expect(text).toContain('ejdrone init https://gitlab.example.com/team/ejdrone-teamai.git');
    expect(text).toContain('ejdrone doctor');
  });

  it('说明目录语义与"共享放根、差异放 namespace"这条最容易踩的规矩', () => {
    const text = teamReadme(REPO, 'main');
    expect(text).toContain('skills/');
    expect(text).toContain('rules/');
    expect(text).toContain('manifest/roles.yaml');
    expect(text).toMatch(/根目录/);
    expect(text).toMatch(/namespace/);
  });

  it('2.1：标签订阅小节教成员跨角色用个别条目，而不是新建 namespace', () => {
    const text = teamReadme(REPO, 'main');
    expect(text).toContain('## 标签订阅');
    expect(text).toContain('tags: [ops-tools]');
    expect(text).toContain('ejdrone tags list');
    expect(text).toContain('ejdrone tags subscribe');
    expect(text).toContain('多角色共用的内容（比如开发和运维都要用的工具）也放根目录');
  });

  it('交代投递落点与退出方式，并提醒不要把密钥写进技能', () => {
    const text = teamReadme(REPO, 'main');
    expect(text).toContain('ejdrone uninstall');
    expect(text).toContain('~/.claude');
    expect(text).toMatch(/密钥|token/i);
    expect(text).toContain('main');
  });
});

describe('空仓库引导提交', () => {
  it('第一笔提交就带上 README.md，成员打开仓库即见说明', async () => {
    const member = h.member('bootstrap-readme');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude']);
    expect(init.code, init.all).toBe(0);

    const added = await member.run(['roles', 'add', 'be', '--namespaces', 'be']);
    expect(added.code, added.all).toBe(0);

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    const readme = member.read('.ejdrone', 'repo', 'README.md');
    expect(readme).toContain(h.origin);
    expect(readme).toContain('ejdrone init');
  });
});

describe('ejdrone readme（给已有仓库补说明书）', () => {
  it('仓库还没有 README 时开分支生成并提交 MR', async () => {
    seedTeamRepo(h);
    const member = h.member('readme-mr');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);
    expect(member.exists('.ejdrone', 'repo', 'README.md')).toBe(false);

    const done = await member.run(['readme']);
    expect(done.code, done.all).toBe(0);
    const branch = h.remoteBranches().find((name) => name.startsWith('ejdrone/readme-'));
    expect(branch, done.all).toBeTruthy();

    h.mergeIntoMain(branch as string);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(member.read('.ejdrone', 'repo', 'README.md')).toContain('ejdrone init');
    // README 是仓库文档，不是投递资源：不该进投递记账
    expect(pulled.all).not.toContain('README.md');
  });
});
