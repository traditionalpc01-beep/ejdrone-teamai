import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { loadLedger } from '../../src/core/ledger.js';
import { ledgerPath } from '../../src/state.js';

import { createHarness, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * 故障面与管理员命令：坏 manifest 全量停发、--silent 恒 0、doctor 指到文件、
 * generic provider 的 MR 指引里绝不出现 token、roles/remove 走 MR 管道、uninstall 不伤人。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
});

afterEach(() => {
  h.cleanup();
});

async function initMember(member: Member, ids = ['claude', 'codex']): Promise<void> {
  installTools(member, ids);
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', 'be']);
  expect(result.code, result.all).toBe(0);
}

function breakManifest(harness: Harness): void {
  harness.writeSeed('manifest/roles.yaml', 'version: 1\nroles:\n  - id: BE!\n    namespaces: [be]\n  [oops\n');
  harness.commitSeed('break the manifest');
}

describe('manifest 写坏', () => {
  it('pull 全量停发、已装内容不变、退出码 1', async () => {
    const member = h.member('bad-manifest');
    await initMember(member);
    const before = member.read('.claude', 'skills', 'be-deploy', 'SKILL.md');

    breakManifest(h);

    const pulled = await member.run(['pull']);
    expect(pulled.code).toBe(1);
    expect(pulled.all).toContain('全量停发');
    expect(pulled.all).toContain('roles.yaml');
    expect(member.read('.claude', 'skills', 'be-deploy', 'SKILL.md')).toBe(before);
    expect(member.read('.claude', 'rules', 'style.md')).toContain('# Style');
    expect(member.read('.codex', 'AGENTS.md')).toContain('Style');
  });

  it('doctor 报 FAIL 并指向出错文件（含 --json）', async () => {
    const member = h.member('doctor-bad');
    await initMember(member);
    breakManifest(h);

    const report = await member.run(['doctor']);
    expect(report.code).toBe(1);
    expect(report.all.split('\n').some((line) => line.includes('[FAIL]') && line.includes('manifest'))).toBe(true);
    expect(report.all).toContain('roles.yaml');

    const asJson = await member.run(['doctor', '--json']);
    expect(asJson.code).toBe(1);
    const doc = JSON.parse(asJson.out) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; message: string; hint?: string }>;
    };
    expect(doc.ok).toBe(false);
    const manifest = doc.checks.find((c) => c.id === 'manifest');
    expect(manifest?.status).toBe('FAIL');
    expect(manifest?.message).toContain('roles.yaml');
    expect(manifest?.hint).toContain('ejdrone pull');
  });

  it('--silent pull 恒返回 0，问题进 debug.log', async () => {
    const member = h.member('silent-bad');
    await initMember(member);
    breakManifest(h);

    const pulled = await member.run(['pull', '--silent']);
    expect(pulled.code).toBe(0);
    expect(pulled.out).toBe('');

    const log = readFileSync(member.path('.ejdrone', 'debug.log'), 'utf8');
    expect(log).toContain('pull --silent');
    expect(log).toContain('roles.yaml');
    expect(member.exists('.claude', 'skills', 'be-deploy', 'SKILL.md')).toBe(true);
  });

  it('manifest 修好后 pull 自动恢复下发', async () => {
    const member = h.member('manifest-fixed');
    await initMember(member, ['claude']);
    breakManifest(h);
    expect((await member.run(['pull'])).code).toBe(1);

    h.writeSeed('manifest/roles.yaml', 'version: 1\nroles:\n  - id: be\n    namespaces: [be]\n');
    h.commitSeed('fix the manifest');
    const recovered = await member.run(['pull']);
    expect(recovered.code, recovered.all).toBe(0);
    expect(member.exists('.claude', 'skills', 'be-deploy', 'SKILL.md')).toBe(true);
  });
});

describe('仓库不可达', () => {
  it('没有 config 时 pull/status/list/doctor 都提示先 init', async () => {
    const member = h.member('no-config');
    for (const args of [['pull'], ['status'], ['list'], ['doctor']]) {
      const result = await member.run(args);
      expect(result.code, `${args.join(' ')} → ${result.all}`).toBe(1);
      expect(result.all).toContain('ejdrone init');
    }
  });

  it('pull 给出下一步，已装内容不变', async () => {
    const member = h.member('unreachable');
    await initMember(member, ['claude']);
    const installed = member.read('.claude', 'rules', 'style.md');

    h.writeSeed('rules/extra.md', '# Extra\n\n不该被拿到。\n');
    h.commitSeed('add extra rule');
    rmSync(h.origin, { recursive: true, force: true });

    const pulled = await member.run(['pull']);
    expect(pulled.code).toBe(1);
    expect(pulled.all).toContain('下一步');
    expect(member.read('.claude', 'rules', 'style.md')).toBe(installed);
    expect(member.exists('.claude', 'rules', 'extra.md')).toBe(false);
  });
});

describe('push 在 generic provider 下', () => {
  it('分支已推送 + 打印手动 MR 指引，输出里没有 token 字样', async () => {
    const member = h.member('push-generic');
    await initMember(member, ['claude']);
    member.write('.claude/skills/secret-hunter/SKILL.md', '# Secret hunter\n\n正文里也不能带凭据。\n');

    // 环境里有 GitLab token：generic provider 的输出不能把它带出来
    const pushed = await member.run(['push', '--skill', '.claude/skills/secret-hunter'], {
      env: { ...member.env, EJDRONE_GITLAB_TOKEN: 'glpat-SUPERSECRET123', GL_TOKEN: 'glpat-SUPERSECRET123' },
    });
    expect(pushed.code, pushed.all).toBe(0);
    expect(pushed.all).toContain('已推送到远端');
    expect(pushed.all).toContain('手动创建 MR');
    expect(pushed.all.toLowerCase()).not.toContain('token');
    expect(pushed.all).not.toContain('SUPERSECRET123');

    const branch = h.remoteBranches().find((b) => b.includes('secret-hunter'));
    expect(branch, `远端分支：${h.remoteBranches().join(', ')}`).toBeTruthy();
    expect(branch).toMatch(/^ejdrone\/push-skills-secret-hunter-\d{8}T\d{6}Z$/);
  });
});

describe('--silent 只记问题', () => {
  it('一切正常时不写 debug.log；有 kept 时把问题写进去且仍返回 0', async () => {
    const member = h.member('silent-clean');
    await initMember(member, ['claude']);

    const clean = await member.run(['pull', '--silent']);
    expect(clean.code).toBe(0);
    expect(clean.out).toBe('');
    expect(member.exists('.ejdrone', 'debug.log')).toBe(false);

    member.write('.claude/rules/style.md', '# Style\n\n我自己的版本。\n');
    const keptRun = await member.run(['pull', '--silent']);
    expect(keptRun.code).toBe(0);
    expect(keptRun.out).toBe('');
    const log = readFileSync(member.path('.ejdrone', 'debug.log'), 'utf8');
    expect(log).toContain('保留');
    expect(log).toContain('style.md');
    expect(member.read('.claude', 'rules', 'style.md')).toContain('我自己的版本');
  });
});

describe('管理员命令走 MR', () => {
  it('roles add 改写 manifest/roles.yaml 并开分支', async () => {
    const member = h.member('roles-add');
    await initMember(member, ['claude']);

    const added = await member.run(['roles', 'add', 'qa', '--namespaces', 'qa', '-d', '测试']);
    expect(added.code, added.all).toBe(0);
    expect(added.all).toContain('chore(roles): add qa');

    const branch = h.remoteBranches().find((b) => b.includes('roles-add-qa'));
    expect(branch, `远端分支：${h.remoteBranches().join(', ')}`).toBeTruthy();
    h.mergeIntoMain(branch as string);

    const doc = parseYaml(h.seedRead('manifest/roles.yaml')) as {
      version: number;
      roles: Array<{ id: string; namespaces: string[]; description?: string }>;
    };
    expect(doc.roles.map((r) => r.id).sort()).toEqual(['be', 'fe', 'qa']);
    expect(doc.roles.find((r) => r.id === 'qa')?.namespaces).toEqual(['qa']);

    // 新角色能被订阅
    const listed = await member.run(['roles', 'list']);
    expect(listed.code, listed.all).toBe(0);
    expect(listed.all).toContain('qa');
  });

  it('roles remove 只删角色表条目，不动 namespace 目录', async () => {
    const member = h.member('roles-remove');
    await initMember(member, ['claude']);

    const removed = await member.run(['roles', 'remove', 'fe']);
    expect(removed.code, removed.all).toBe(0);
    const branch = h.remoteBranches().find((b) => b.includes('roles-remove-fe'));
    expect(branch, `远端分支：${h.remoteBranches().join(', ')}`).toBeTruthy();
    h.mergeIntoMain(branch as string);

    const doc = parseYaml(h.seedRead('manifest/roles.yaml')) as { roles: Array<{ id: string }> };
    expect(doc.roles.map((r) => r.id)).toEqual(['be']);
    expect(h.seedRead('skills/fe/fe-review/SKILL.md')).toContain('# FE review');
  });
});

describe('uninstall', () => {
  it('删掉记账匹配的文件、保留改过的、留住 config 与 AGENTS.md 私有内容', async () => {
    const member = h.member('uninstall');
    await initMember(member, ['claude', 'codex']);
    member.write('.claude/rules/style.md', '# Style\n\n我自己改过的版本。\n');
    const personal = member.read('.codex', 'AGENTS.md');

    const refused = await member.run(['uninstall']);
    expect(refused.code, refused.all).toBe(1);
    expect(refused.all).toContain('--force');

    const done = await member.run(['uninstall', '--force']);
    expect(done.code, done.all).toBe(0);

    expect(member.exists('.claude', 'skills', 'be-deploy', 'SKILL.md')).toBe(false);
    expect(member.exists('.claude', 'rules', 'style.md')).toBe(true);
    expect(done.all).toContain('保留');
    // 区块文件属于用户，绝不整文件删除
    expect(member.read('.codex', 'AGENTS.md')).toBe(personal);
    expect(member.exists('.ejdrone', 'config.yaml')).toBe(true);
    const { ledger } = loadLedger(ledgerPath(member.env));
    // 记账被删的只剩"保留下来"的两条：AGENTS.md 区块 + 我改过的 style.md
    expect(ledger.entries.map((e) => e.resource).sort()).toEqual(['rules:style', 'rules:team-rules-block']);

    const settings = JSON.parse(member.read('.claude', 'settings.json')) as { hooks?: unknown };
    expect(settings.hooks).toBeUndefined();
  });
});
