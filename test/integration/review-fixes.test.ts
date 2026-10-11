import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLOCK_END, BLOCK_START } from '../../src/agents/block.js';
import { acquireLock } from '../../src/cli/lock.js';
import { createHarness, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * 终审发现的四条真缺陷的回归用例。每条都对应一次"能让用户或团队内容被吃掉"的路径。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
});

afterEach(() => {
  h.cleanup();
});

async function initMember(member: Member, ids: string[]): Promise<void> {
  installTools(member, ids);
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', 'be']);
  expect(result.code, result.all).toBe(0);
}

describe('停发 ≠ 清空区块', () => {
  it('rules 命名空间冲突时，codex 的 AGENTS.md 团队区块一字不动', async () => {
    const member = h.member('block-conflict');
    await initMember(member, ['codex']);

    const before = member.read('.codex', 'AGENTS.md');
    expect(before).toContain(BLOCK_START);
    expect(before).toContain(BLOCK_END);

    h.writeSeed('rules/be/shared.md', '# Shared rule\n\n后端版本。\n');
    h.writeSeed('rules/fe/shared.md', '# Shared rule\n\n前端版本。\n');
    h.commitSeed('two namespaces define the same rule');

    const set = await member.run(['roles', 'set', 'be', '--add', 'fe']);
    expect(set.code, set.all).toBe(0);

    const pulled = await member.run(['pull']);
    expect(pulled.code).toBe(1);
    expect(pulled.all).toContain('rules:shared conflict between');
    expect(pulled.all).toContain('该类型本次停发');

    // 空数组会让 block 适配器产出"清空区块"的投递；停发时必须整个跳过
    expect(member.read('.codex', 'AGENTS.md')).toBe(before);
  });
});

describe('--force 不越界', () => {
  it('从未记账的同名文件是用户自己的东西，--force 也不能删', async () => {
    const member = h.member('force-foreign');
    await initMember(member, ['claude']);

    h.writeSeed('skills/mine/SKILL.md', '# Mine\n\n团队后来新增的同名条目。\n');
    h.commitSeed('team adds a skill that collides with a local private file');

    // 本地先有一份同名文件，ledger 里没有任何记账
    member.write('.claude/skills/mine/SKILL.md', '# Mine\n\n我自己写的同名文件，不是团队投递。\n');

    const forced = await member.run(['pull', '--force']);
    expect(forced.all).toContain('保留');

    const kept = member.read('.claude', 'skills', 'mine', 'SKILL.md');
    expect(kept).toContain('我自己写的同名文件');
    expect(kept).not.toContain('团队后来新增');
  });

  it('--force 仍会覆盖我们投递过且被本地改动的文件', async () => {
    const member = h.member('force-owned');
    await initMember(member, ['claude']);
    const team = member.read('.claude', 'skills', 'root-note', 'SKILL.md');
    member.write('.claude/skills/root-note/SKILL.md', '# Root note\n\n我的临时改动。\n');

    const forced = await member.run(['pull', '--force']);
    expect(forced.code, forced.all).toBe(0);
    expect(member.read('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(team);
  });
});

describe('hook 失效要能被看见', () => {
  it('hook 指向已消失的入口时 doctor 报 FAIL 并给出重跑 init 的指引', async () => {
    const member = h.member('hook-stale');
    await initMember(member, ['claude']);

    const green = await member.run(['doctor']);
    expect(green.code, green.all).toBe(0);

    const settingsPath = member.path('.claude', 'settings.json');
    const dead = `EJDRONE_HOOK=1 '${member.env.EJDRONE_NODE}' '/no/such/ejdrone-cli.js' pull --silent`;
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: dead }] }] } }), 'utf8');

    const report = await member.run(['doctor']);
    expect(report.code).toBe(1);
    expect(report.all).toContain('/no/such/ejdrone-cli.js');
    expect(report.all).toContain('自动 pull 已失效');
    expect(report.all).toContain('ejdrone init');
  });

  it('hook 指向另一份安装时 WARN（升级后最常见）', async () => {
    const member = h.member('hook-other-install');
    await initMember(member, ['claude']);

    const other = member.path('another-install.js');
    writeFileSync(other, '// 另一份安装\n', 'utf8');
    const cmd = `EJDRONE_HOOK=1 '${member.env.EJDRONE_NODE}' '${other}' pull --silent`;
    writeFileSync(member.path('.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }] } }), 'utf8');

    const report = await member.run(['doctor']);
    expect(report.all).toContain('不是同一份');
    expect(report.all).not.toContain('自动 pull 已失效');
  });
});

describe('并发同步', () => {
  it('别的进程持锁时：静默 pull 跳过且返回 0，交互 pull 报错并给出锁文件路径', async () => {
    const member = h.member('locked');
    await initMember(member, ['claude']);

    const lock = acquireLock(member.env);
    expect(lock.ok).toBe(true);

    const silent = await member.run(['pull', '--silent']);
    expect(silent.code).toBe(0);
    expect(silent.out).toBe('');
    expect(silent.err).toBe('');

    const interactive = await member.run(['pull']);
    expect(interactive.code).toBe(1);
    expect(interactive.err).toContain('已有 ejdrone 进程正在同步团队仓库');
    expect(interactive.err).toContain('sync.lock');

    if (lock.ok) lock.release();
    const after = await member.run(['pull']);
    expect(after.code, after.all).toBe(0);
  });

  it('push 期间 pull 想插进来会被挡住，工作树不会被 fetchReset 清空', async () => {
    const author = h.member('locked-push');
    await initMember(author, ['claude']);

    const lock = acquireLock(author.env);
    expect(lock.ok).toBe(true);

    author.write('.claude/skills/new-one/SKILL.md', '# New one\n\n要推给团队的技能。\n');
    const pushed = await author.run(['push', '--skill', author.path('.claude/skills/new-one')]);
    expect(pushed.code).toBe(1);
    expect(pushed.err).toContain('已有 ejdrone 进程正在同步团队仓库');

    if (lock.ok) lock.release();
    const ok = await author.run(['push', '--skill', author.path('.claude/skills/new-one')]);
    expect(ok.code, ok.all).toBe(0);
    expect(h.remoteBranches().some((b) => b.startsWith('ejdrone/push-skills-new-one-'))).toBe(true);
  });
});

describe('孤儿标记', () => {
  it('AGENTS.md 里只剩半个标记时不动这个文件，也不反复堆叠新区块', async () => {
    const member = h.member('orphan-marker');
    await initMember(member, ['codex']);

    const path = member.path('.codex', 'AGENTS.md');
    const broken = `${readFileSync(path, 'utf8').replace(BLOCK_END, '')}我删掉了结束标记\n`;
    writeFileSync(path, broken, 'utf8');

    const first = await member.run(['pull']);
    expect(first.all).toContain('保留');
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(broken);
    // 第二次 pull 同样不动它：不会追加第二个区块
    await member.run(['pull']);
    expect(readFileSync(path, 'utf8')).toBe(after);
    expect(existsSync(path)).toBe(true);
  });
});
