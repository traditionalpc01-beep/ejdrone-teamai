import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { sep as SEP } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLOCK_END, BLOCK_START } from '../../src/agents/block.js';
import { ledgerPath } from '../../src/state.js';
import { loadLedger } from '../../src/core/ledger.js';
import { createHarness, expectedHookCommand, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * 端到端：真实 git origin + 伪造 HOME，跑通 init → push → 合入 → 成员 pull 的闭环，
 * 以及角色切换、本地改动保护、团队删除、幂等。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
});

afterEach(() => {
  h.cleanup();
});

function parseSummary(text: string): { written: number; deleted: number; kept: number } {
  const match = /已投递 (\d+) 个文件到 \d+ 个工具；删除 (\d+)；保留 (\d+)/.exec(text);
  if (!match) throw new Error(`输出里没有投递摘要：\n${text}`);
  return { written: Number(match[1]), deleted: Number(match[2]), kept: Number(match[3]) };
}

async function initMember(member: Member, ids: string[]): Promise<void> {
  installTools(member, ids);
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', 'be']);
  expect(result.code, result.all).toBe(0);
}

describe('init：选定工具 + hook 落盘 + 幂等', () => {
  it('装上 claude/codex 的 hook，重复 init 也只留一条', async () => {
    const member = h.member('init-hook');
    installTools(member, ['claude', 'codex']);
    const result = await member.run(['init', h.origin, '--agent', 'claude,codex', '--role', 'be']);
    expect(result.code, result.all).toBe(0);

    // 期望命令按当前平台推导：win32 且没有 Git for Windows 时 hook 一律不安装
    // （init 只打印安装指引），settings/hooks.json 根本不会出现；macOS CI 走非 null 分支。
    const expectedCmd = expectedHookCommand(member.env);
    if (expectedCmd === null) {
      expect(result.all).toContain('需要 Git for Windows');
      expect(member.exists('.claude', 'settings.json')).toBe(false);
      expect(member.exists('.codex', 'hooks.json')).toBe(false);
    } else {
      const settings = JSON.parse(member.read('.claude', 'settings.json')) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(settings.hooks.SessionStart).toHaveLength(1);
      // 绝对路径的 node + cli 入口：GUI 启动的 agent 常常拿不到 npm 全局 bin 的 PATH
      expect(settings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(expectedCmd);
      expect(member.exists('.codex', 'hooks.json')).toBe(true);
    }
    // 首次 init 末尾就完成投递（与有没有 Git Bash 无关）
    expect(member.exists('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(true);

    const again = await member.run(['init', h.origin, '--force', '--agent', 'claude,codex', '--role', 'be']);
    expect(again.code, again.all).toBe(0);
    if (expectedCmd !== null) {
      const after = JSON.parse(member.read('.claude', 'settings.json')) as {
        hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(after.hooks.SessionStart).toHaveLength(1);
      // 用户自己写在 settings 里的其他键不能被弄丢
      expect(after.hooks.SessionStart[0]?.hooks).toHaveLength(1);
    }
  });

  it('非交互且没有安装任何工具时不猜，直接给下一步', async () => {
    const member = h.member('init-nodetect');
    const result = await member.run(['init', h.origin]);
    expect(result.code).toBe(1);
    expect(result.all).toContain('--agent');
  });
});

describe('push → 合入 → 成员 pull', () => {
  it('作者 push，评审合入后另一个成员的 claude/codex 落点正确', async () => {
    const author = h.member('author');
    await initMember(author, ['claude', 'codex']);

    author.write('.claude/skills/my-skill/SKILL.md', '# My skill\n\n第一次写就该被补 frontmatter。\n');
    author.write('.claude/rules/my-rule.md', '# My private rule\n\n正文标记 MYRULEBODY7。\n');

    const pushed = await author.run(['push', '--skill', '.claude/skills/my-skill', '--rule', '.claude/rules/my-rule.md']);
    expect(pushed.code, pushed.all).toBe(0);
    const branches = h.remoteBranches().filter((b) => b.startsWith('ejdrone/push-'));
    expect(branches.length).toBeGreaterThan(0);
    const branch = branches[0] as string;

    h.mergeIntoMain(branch);

    // 第二个成员：AGENTS.md 里先有私有内容，标记外必须逐字节保留
    const mate = h.member('mate');
    installTools(mate, ['claude', 'codex']);
    const personal = '# 我的私有笔记\n\n这段不能被任何东西改动。\n\n';
    mate.write('.codex/AGENTS.md', personal);
    await initMember(mate, ['claude', 'codex']);
    expect(mate.read('.claude', 'skills', 'my-skill', 'SKILL.md')).toContain('name: my-skill');
    expect(mate.exists('.claude', 'rules', 'my-rule.md')).toBe(true);

    const agents = mate.read('.codex', 'AGENTS.md');
    expect(agents.startsWith(personal)).toBe(true);
    expect(agents).toContain(BLOCK_START);
    expect(agents).toContain('MYRULEBODY7');

    const inSeed = h.seedRead('skills/be/my-skill/SKILL.md');
    expect(inSeed).toContain('name: my-skill');
  });

  it('同一资源再次 push 就地更新未合并分支，不开重复分支', async () => {
    const author = h.member('author-reuse');
    await initMember(author, ['claude']);
    author.write('.claude/skills/reusable/SKILL.md', '# Reusable\n\n第一版。\n');

    const first = await author.run(['push', '--skill', '.claude/skills/reusable']);
    expect(first.code, first.all).toBe(0);
    const afterFirst = h.remoteBranches().filter((b) => b.includes('reusable'));
    expect(afterFirst).toHaveLength(1);

    author.write('.claude/skills/reusable/SKILL.md', '# Reusable\n\n第二版，改了不少。\n');
    const second = await author.run(['push', '--skill', '.claude/skills/reusable']);
    expect(second.code, second.all).toBe(0);
    expect(second.all).toContain('就地更新');

    const afterSecond = h.remoteBranches().filter((b) => b.includes('reusable'));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]).toBe(afterFirst[0]);
  });

  it('没有角色时推到仓库根目录', async () => {
    const author = h.member('author-root');
    installTools(author, ['claude']);
    const init = await author.run(['init', h.origin, '--agent', 'claude']);
    expect(init.code, init.all).toBe(0);
    expect(init.all).toContain('不设角色');

    author.write('.claude/skills/rootward/SKILL.md', '# Rootward\n\n根条目候选。\n');
    const pushed = await author.run(['push', '--skill', '.claude/skills/rootward']);
    expect(pushed.code, pushed.all).toBe(0);
    h.mergeIntoMain(h.remoteBranches().find((b) => b.includes('rootward')) as string);
    expect(h.seedRead('skills/rootward/SKILL.md')).toContain('name: rootward');
  });
});

describe('角色切换', () => {
  it('be → fe 后 fe 的条目出现、be 独有条目消失、根条目保留', async () => {
    const member = h.member('role-switch');
    await initMember(member, ['claude', 'codex']);

    expect(member.exists('.claude', 'skills', 'be-deploy', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(true);
    expect(member.exists('.claude', 'skills', 'fe-review')).toBe(false);

    const set = await member.run(['roles', 'set', 'fe']);
    expect(set.code, set.all).toBe(0);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);

    expect(member.exists('.claude', 'skills', 'fe-review', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'rules', 'react.md')).toBe(true);
    expect(member.exists('.claude', 'skills', 'be-deploy')).toBe(false);
    expect(member.exists('.claude', 'skills', 'be-deploy', 'SKILL.md')).toBe(false);
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(false);
    // 根条目始终保留
    expect(member.exists('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'rules', 'style.md')).toBe(true);

    const block = member.read('.codex', 'AGENTS.md');
    expect(block).toContain('React rule');
    expect(block).not.toContain('DB rule');
  });
});

describe('本地改动保护', () => {
  it('手改已投递的 skill 正文 → pull 不覆盖且出现在 kept', async () => {
    const member = h.member('keep');
    await initMember(member, ['claude']);

    const file = member.path('.claude', 'skills', 'root-note', 'SKILL.md');
    const edited = '# Root note\n\n我加的私人笔记，不能被覆盖。\n';
    member.write('.claude/skills/root-note/SKILL.md', edited);

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(1);
    expect(pulled.all).toContain('保留');
    expect(member.read('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(edited);
    expect(parseSummary(pulled.all)).toMatchObject({ kept: 1 });

    // 记账还在，且没有被改后的内容污染
    const { ledger } = loadLedger(ledgerPath(member.env));
    const entry = ledger.entries.find((e) => e.path === file);
    expect(entry?.resource).toBe('skills:root-note');
  });
});

describe('团队删除', () => {
  it('仓库删掉 rule → 成员 pull 后文件消失、AGENTS.md 区块同步更新', async () => {
    const member = h.member('team-delete');
    await initMember(member, ['claude', 'codex']);
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(true);

    h.removeSeed('rules/be/db.md');
    h.commitSeed('drop the db rule');

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(parseSummary(pulled.all).deleted).toBe(1);
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(false);

    const block = member.read('.codex', 'AGENTS.md');
    expect(block).not.toContain('DB rule');
    expect(block).toContain('Style');
    expect(block).toContain(BLOCK_START);
    expect(block).toContain(BLOCK_END);

    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => e.resource === 'rules:db')).toBe(false);
  });

  it('remove 命令走 MR 管道，且不动本地副本', async () => {
    const member = h.member('remove-cmd');
    await initMember(member, ['claude']);

    const removed = await member.run(['remove', 'rules', 'db']);
    expect(removed.code, removed.all).toBe(0);
    expect(removed.all).toContain('合入后 ejdrone pull 会自动从各工具移除');
    // 本机副本仍在（未合入就删会与团队不一致）
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(true);

    const branch = h.remoteBranches().find((b) => b.includes('roles') === false && b.includes('db'));
    expect(branch, `远端分支：${h.remoteBranches().join(', ')}`).toBeTruthy();
    h.mergeIntoMain(branch as string);
    expect(() => h.seedRead('rules/be/db.md')).toThrow();
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(false);
  });
});

describe('status 与冲突', () => {
  it('多文件 skill 全量投递（含 scripts/run.sh）', async () => {
    const member = h.member('multi-file');
    await initMember(member, ['claude', 'qoder-cn']);
    expect(member.read('.claude', 'skills', 'be-deploy', 'scripts', 'run.sh')).toContain('echo deploy');
    expect(member.read('.qoder-cn', 'skills', 'be-deploy', 'SKILL.md')).toContain('# BE deploy');
  });

  it('status 报出待推送与落后', async () => {
    const member = h.member('status');
    await initMember(member, ['claude']);

    // 本地新写一条、仓库里还没有
    member.write('.claude/skills/pending-one/SKILL.md', '# Pending one\n\n还没入库。\n');
    // 团队新增一条、本机因还没 pull 而落后
    h.writeSeed('rules/dev.md', '# Dev rule\n\n新入库的 rule。\n');
    h.commitSeed('team adds a rule');

    const report = await member.run(['status']);
    expect(report.code, report.all).toBe(0);
    expect(report.all).toContain('skills pending-one');
    expect(report.all).toContain('落后（仓库有、本机还没投递）：1');
    expect(report.all).toContain('rules:dev');
    expect(report.all).toContain('ejdrone pull');

    const after = await member.run(['pull']);
    expect(after.code, after.all).toBe(0);
    expect(member.exists('.claude', 'rules', 'dev.md')).toBe(true);
  });

  it('仓库没有 rules 时，codex 的合成区块不被 status 计成永久落后（2026-10-15 真实成员环境引出）', async () => {
    const bare = createHarness();
    try {
      bare.writeSeed(
        'manifest/roles.yaml',
        'version: 1\nroles:\n  - id: be\n    description: 后端\n    namespaces:\n      - be\n',
      );
      bare.writeSeed('skills/solo/SKILL.md', '# Solo\n\n唯一内容，仓库没有任何 rules。\n');
      bare.commitSeed('skills only, no rules');

      const member = bare.member('codex-norules');
      installTools(member, ['codex']);
      const init = await member.run(['init', bare.origin, '--agent', 'codex', '--role', 'be']);
      expect(init.code, init.all).toBe(0);

      const report = await member.run(['status']);
      expect(report.code, report.all).toBe(0);
      expect(report.all).toContain('落后（仓库有、本机还没投递）：0');
      expect(report.all).not.toContain('rules:team-rules-block');
    } finally {
      bare.cleanup();
    }
  });

  it('两个订阅角色定义同名条目 → 只停 skills、已装内容不被删、退出码 1', async () => {
    const member = h.member('conflict');
    await initMember(member, ['claude']);
    const before = member.read('.claude', 'skills', 'root-note', 'SKILL.md');

    h.writeSeed('skills/be/shared/SKILL.md', '# Shared\n\n后端版本。\n');
    h.writeSeed('skills/fe/shared/SKILL.md', '# Shared\n\n前端版本。\n');
    h.commitSeed('two namespaces define the same skill');

    const set = await member.run(['roles', 'set', 'be', '--add', 'fe']);
    expect(set.code, set.all).toBe(0);
    const pulled = await member.run(['pull']);
    expect(pulled.code).toBe(1);
    expect(pulled.all).toContain('conflict between');
    expect(pulled.all).toContain('该类型本次停发');
    // 停发 ≠ 删除：已装 skill 一字未动，rules 照常下发
    expect(member.read('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(before);
    expect(member.exists('.claude', 'skills', 'shared')).toBe(false);
    expect(member.exists('.claude', 'rules', 'react.md')).toBe(true);
  });
});

describe('--force 与 list', () => {
  it('pull --force 覆盖本地改过的整文件投递', async () => {
    const member = h.member('force');
    await initMember(member, ['claude']);
    const team = member.read('.claude', 'skills', 'root-note', 'SKILL.md');
    member.write('.claude/skills/root-note/SKILL.md', '# Root note\n\n我的临时改动。\n');

    const forced = await member.run(['pull', '--force']);
    expect(forced.code, forced.all).toBe(0);
    expect(forced.all).toContain('--force');
    expect(member.read('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(team);
  });

  it('list --source local 扫工具目录，repo 源标注 namespace 与根条目', async () => {
    const member = h.member('list');
    await initMember(member, ['claude', 'codex']);
    member.write('.claude/skills/mine-locally/SKILL.md', '# Mine\n\n只在本地。\n');

    const local = await member.run(['list', 'skills', '--source', 'local']);
    expect(local.code, local.all).toBe(0);
    expect(local.all).toContain('mine-locally');

    const repo = await member.run(['list', '--source', 'repo']);
    expect(repo.code, repo.all).toBe(0);
    expect(repo.all).toContain('root-note  根条目');
    expect(repo.all).toContain('namespace=be');

    const all = await member.run(['list', '--source', 'all']);
    expect(all.code, all.all).toBe(0);
    expect(all.all).toContain('本地（扫描');
    expect(all.all).toContain('团队仓库：');
  });
});

describe('幂等', () => {
  it('连续两次 pull 第二次零写入零删除', async () => {
    const member = h.member('idempotent');
    await initMember(member, ['claude', 'codex', 'qoder-cn']);

    const first = await member.run(['pull']);
    expect(first.code, first.all).toBe(0);
    const second = await member.run(['pull']);
    expect(second.code, second.all).toBe(0);
    expect(parseSummary(second.all)).toEqual({ written: 0, deleted: 0, kept: 0 });
  });
});

describe('MR 提交后的机器克隆状态（2026-10-13 Windows 真机试验引出）', () => {
  // createBranch 会把 checkout 切到临时分支；不还原的话，紧接着的只读命令
  // （status / list / contribute --dry-run）会把「还没合入的内容」当团队真相。
  // 真机实测过一次：contribute 之后立刻 `contribute --dry-run` 因「目标路径已存在」被拒。
  it('push 之后 checkout 仍停在默认分支，工作树里没有未合入内容', async () => {
    const member = h.member('push-head-main');
    await initMember(member, ['claude']);

    member.write('.claude/skills/mine/SKILL.md', '# Mine\n\n我的技能。\n');
    const pushed = await member.run(['push', '--skill', member.path('.claude', 'skills', 'mine'), '--ns', 'be']);
    expect(pushed.code, pushed.all).toBe(0);

    expect(headBranch(member)).toBe('main');
    expect(member.exists('.ejdrone', 'repo', 'skills', 'be', 'mine', 'SKILL.md')).toBe(false);

    // 未合入前，只读命令看到的必须仍是默认分支的真相
    const dry = await member.run(['status']);
    expect(dry.code, dry.all).toBe(0);
    expect(dry.all).not.toContain('mine：be');
  });

  it('推上去的内容与仓库一致（无需再提交）时，checkout 也回到默认分支', async () => {
    // submitMrChange 有两条不推送的提前返回：安全检查打回、isDirty=false。后者最容易在
    // 「重复推同一份内容」时命中，是最常见的那次退出，也必须把 checkout 还回去。
    const member = h.member('push-noop-restore');
    await initMember(member, ['claude']);
    member.write('.claude/skills/again/SKILL.md', '# Again\n\n推两次。\n');

    const first = await member.run(['push', '--skill', member.path('.claude', 'skills', 'again'), '--ns', 'be']);
    expect(first.code, first.all).toBe(0);
    const branch = first.all.match(/ejdrone\/push-[^\s（）]+/)?.[0];
    expect(branch, first.all).toBeTruthy();
    h.mergeIntoMain(branch as string);

    const second = await member.run(['push', '--skill', member.path('.claude', 'skills', 'again'), '--ns', 'be']);
    expect(second.code, second.all).toBe(0);
    expect(second.all).toContain('无需提交');
    expect(headBranch(member)).toBe('main');
    // 还原不能把已合入的内容从工作树里抹掉：下次 pull 还得能看到它
    expect(member.exists('.ejdrone', 'repo', 'skills', 'be', 'again', 'SKILL.md')).toBe(true);
  });
});

describe('uninstall 对区块文件的两种结局', () => {
  // 标记外有成员的私有内容 → 文件保留、只撤区块（既有覆盖）；
  // 文件本来就只为区块存在 → 撤完只剩空白，留着就是残留（真机：0 字节 .codex/AGENTS.md）。
  it('AGENTS.md 只为区块而存在时，撤完只剩空白：不删，但必须被点名', async () => {
    // 2026-10-13 Windows 真机试验：全新成员机器上 uninstall 之后留下一个 0 字节
    // `.codex/AGENTS.md` 且没有任何提示，成员以为已经清干净了。
    // 仍不删 —— 区块文件住在 `~/.codex/AGENTS.md` 这类工具原生路径上，分不清是不是工具自己要建的
    // （与「空目录只报告不删」同一条理由），但要说出来。
    const member = h.member('uninstall-blank-block');
    await initMember(member, ['codex']);
    expect(member.exists('.codex', 'AGENTS.md')).toBe(true);
    expect(member.read('.codex', 'AGENTS.md')).toContain(BLOCK_START);

    const out = await member.run(['uninstall', '--force']);
    expect(out.code, out.all).toBe(0);
    expect(out.all).toContain('留下空白文件');
    expect(member.exists('.codex', 'AGENTS.md')).toBe(true);
    expect(member.read('.codex', 'AGENTS.md').trim()).toBe('');
  });

  it('标记外有私有内容时，文件与标记外内容逐字节保留，也不报空白', async () => {
    const member = h.member('uninstall-kept-block');
    const personal = '# 我的私有说明\n\n别删我这行。\n\n';
    member.write('.codex/AGENTS.md', personal);
    await initMember(member, ['codex']);
    expect(member.read('.codex', 'AGENTS.md')).toContain(BLOCK_START);

    const out = await member.run(['uninstall', '--force']);
    expect(out.code, out.all).toBe(0);
    expect(member.read('.codex', 'AGENTS.md')).toBe(personal);
    expect(out.all).not.toContain('留下空白文件');
  });
});

/** checkout 当前停在哪个分支。 */
function headBranch(member: Member): string {
  return execFileSync('git', ['-C', member.path('.ejdrone', 'repo'), 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    env: member.env,
  }).trim();
}

/**
 * M10 / T10.2 的 Windows 专属产物：hook wrapper。
 *
 * 只在 win32 主机上跑（POSIX 上 `win32Hook()` 恒为 null，这条路根本不会执行）——
 * 这一层的代码此前只有单元测试从旁边描述它，没有一条用例真的把 wrapper 文件写出来过。
 */
describe.runIf(process.platform === 'win32')('Windows hook wrapper（init 落盘 / 降级 / 写失败 / 卸载）', () => {
  it('init 把 bash -lc 的 payload 写进 wrapper，工具配置里只留指向它的裸路径', async () => {
    const member = h.member('win-wrapper-init');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    const wrapper = member.read('.ejdrone', 'hooks', 'session-start.cmd');
    expect(wrapper).toMatch(/^@echo off\r\n/);
    expect(wrapper).toContain('-lc "EJDRONE_HOOK=1');
    expect(wrapper).toContain(`'${member.env.EJDRONE_CLI}' pull --silent`);

    const settings = JSON.parse(member.read('.claude', 'settings.json')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command ?? '';
    // 命令串里既没有引号包住的可执行路径、也没有 bash 段：那是 PowerShell 能跑起来的前提
      expect(command.split('/').join(SEP)).toBe(member.path('.ejdrone', 'hooks', 'session-start.cmd') + ' EJDRONE_HOOK=1');
    expect(command).not.toContain('-lc');

    const doctor = await member.run(['doctor', '--json']);
    expect(doctor.code, doctor.out).toBe(0);
  });

  it('状态目录路径含空格 → 退到 cmd.exe /c 包装并当场说出来，doctor 报 WARN', async () => {
    // 用户名带空格是 Windows 上的常见形态；唯一能同时喂饱 cmd 与 PowerShell 的写法
    // 会牺牲 Git Bash 那一路，所以必须可见，不能静默降级。
    const member = h.member('win wrapper spaced');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);
    expect(init.all).toContain('退到 cmd.exe /c');

    const settings = JSON.parse(member.read('.claude', 'settings.json')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.SessionStart[0]?.hooks[0]?.command ?? '').toContain('cmd.exe /c "');

    const doctor = await member.run(['doctor', '--json']);
    const report = JSON.parse(doctor.out) as { checks: Array<{ id: string; status: string; message: string }> };
    const bash = report.checks.find((c) => c.id === 'win:hookbash');
    expect(bash?.status, doctor.out).toBe('WARN');
    expect(bash?.message ?? '').toContain('含空格');
  });

  it('wrapper 写不出来时不装 hook，并给出「手动 pull 不受影响」的下一步', async () => {
    const member = h.member('win-wrapper-write-fail');
    installTools(member, ['claude']);
    // 把 hooks 那一层占成一个普通文件：mkdirSync 必然失败
    mkdirSync(member.path('.ejdrone'), { recursive: true });
    writeFileSync(member.path('.ejdrone', 'hooks'), 'not a directory\n', 'utf8');

    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);
    expect(init.all).toContain('hook wrapper 写不出来');
    expect(init.all).toContain('手动 ejdrone pull');
    expect(member.exists('.claude', 'settings.json')).toBe(false);
  });

  it('uninstall 删掉 wrapper 文件', async () => {
    const member = h.member('win-wrapper-uninstall');
    installTools(member, ['claude']);
    expect((await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be'])).code).toBe(0);
    expect(member.exists('.ejdrone', 'hooks', 'session-start.cmd')).toBe(true);

    const out = await member.run(['uninstall', '--force']);
    expect(out.code, out.all).toBe(0);
    expect(out.all).toContain('hook wrapper');
    expect(member.exists('.ejdrone', 'hooks', 'session-start.cmd')).toBe(false);
  });
});
