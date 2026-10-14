import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentPushCommand } from '../../src/cli/agentscollect.js';
import { createContext } from '../../src/cli/context.js';
import { ledgerPath } from '../../src/state.js';
import { loadLedger } from '../../src/core/ledger.js';
import {
  createHarness,
  installTools,
  NS_AGENT_MD,
  ROOT_AGENT_MD,
  seedAgents,
  seedTeamRepo,
  type Harness,
  type Member,
} from './helpers.js';

/**
 * M7 子 Agent 下发的端到端（T7.6）：真实 git origin + 伪造 HOME。
 * 主链路：仓库 agents/（根 + ns）→ pull → claude 收到逐字节 .md、codex 收到 .toml
 * → 角色切换移除 ns 条目保留根条目 → 二次 pull 幂等 → 成员改过的文件保留并点名 → uninstall 无残留。
 * 外加命令面三件：list agents、remove agents（同名两处拒绝并列出）、push --agent 反向采集。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
  seedAgents(h);
});

afterEach(() => {
  h.cleanup();
});

async function initMember(member: Member, ids: string[], role = 'be'): Promise<void> {
  installTools(member, ids);
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', role]);
  expect(result.code, result.all).toBe(0);
}

function cmdCtx(member: Member) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = createContext({
    env: member.env,
    home: member.home,
    cwd: member.home,
    interactive: false,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { ctx, text: () => `${out.join('\n')}\n${err.join('\n')}` };
}

describe('agents 投递', () => {
  it('pull 后 claude 收到逐字节 .md、codex 收到 .toml（无 tools 键）；ns 条目只给订阅 be 的成员', async () => {
    const member = h.member('agents-basic');
    await initMember(member, ['claude', 'codex'], 'be');

    // md：完整 frontmatter 的源文件逐字节投递（正文与封装都不动）
    expect(member.read('.claude', 'agents', 'review-assistant.md')).toBe(ROOT_AGENT_MD);
    expect(member.read('.claude', 'agents', 'be-deploy-bot.md')).toBe(NS_AGENT_MD);

    // toml：name/description/developer_instructions/model，**故意不写 tools**（§7.1）
    const toml = member.read('.codex', 'agents', 'review-assistant.toml');
    expect(toml).toContain('name = "review-assistant"');
    expect(toml).toContain('description = "评审助手"');
    expect(toml).toContain('model = "sonnet"');
    expect(toml).not.toContain('tools');
    const quoted = /developer_instructions = (.*)\n/.exec(toml)?.[1] ?? '';
    expect(JSON.parse(quoted)).toBe('\n# Review assistant\n\n逐步核对改动。\n');

    // 记账：2 个 agent × 2 个工具
    const { ledger } = loadLedger(ledgerPath(member.env));
    const agentEntries = ledger.entries.filter((e) => e.resource.startsWith('agents:'));
    expect(agentEntries.map((e) => e.resource).sort()).toEqual([
      'agents:be-deploy-bot',
      'agents:be-deploy-bot',
      'agents:review-assistant',
      'agents:review-assistant',
    ]);

    // list agents 认得新 kind（kinds.ts 的表 + list.ts 的通用行渲染）
    const list = await member.run(['list', 'agents']);
    expect(list.code, list.all).toBe(0);
    expect(list.all).toContain('agents  review-assistant  根条目  本次会下发');
    expect(list.all).toContain('agents  be-deploy-bot  namespace=be  本次会下发');
  });

  it('未订阅 be 的角色（fe）收不到 ns agent；切回 be 又拿到', async () => {
    const member = h.member('agents-role');
    await initMember(member, ['claude'], 'be');
    expect(member.exists('.claude', 'agents', 'be-deploy-bot.md')).toBe(true);

    const set = await member.run(['roles', 'set', 'fe']);
    expect(set.code, set.all).toBe(0);
    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(0);
    // ns agent 移除、根 agent 保留
    expect(member.exists('.claude', 'agents', 'be-deploy-bot.md')).toBe(false);
    expect(member.exists('.claude', 'agents', 'review-assistant.md')).toBe(true);

    const back = await member.run(['roles', 'set', 'be']);
    expect(back.code, back.all).toBe(0);
    const repull = await member.run(['pull']);
    expect(repull.code, repull.all).toBe(0);
    expect(member.read('.claude', 'agents', 'be-deploy-bot.md')).toBe(NS_AGENT_MD);
  });

  it('二次 pull 幂等：逐字节不动、零写入、退出码 0', async () => {
    const member = h.member('agents-idempotent');
    await initMember(member, ['claude', 'codex'], 'be');
    const md = member.read('.claude', 'agents', 'review-assistant.md');
    const toml = member.read('.codex', 'agents', 'review-assistant.toml');

    const second = await member.run(['pull']);
    expect(second.code, second.all).toBe(0);
    expect(second.all).toContain('已投递 0 个文件');
    expect(member.read('.claude', 'agents', 'review-assistant.md')).toBe(md);
    expect(member.read('.codex', 'agents', 'review-assistant.toml')).toBe(toml);
  });

  it('成员改过投递文件：pull 只点名不覆盖，他的版本逐字节留着', async () => {
    const member = h.member('agents-modified');
    await initMember(member, ['claude', 'codex'], 'be');
    const mine = ROOT_AGENT_MD.replace('逐步核对改动。', '我的私有核对清单。');
    member.write('.claude/agents/review-assistant.md', mine);

    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(1);
    expect(pull.all).toContain(join(member.home, '.claude', 'agents', 'review-assistant.md'));
    expect(pull.all).toContain('本地已修改');
    expect(member.read('.claude', 'agents', 'review-assistant.md')).toBe(mine);
    // 没改过的另一处（codex 的 toml）不受影响
    expect(member.read('.codex', 'agents', 'review-assistant.toml')).toContain('name = "review-assistant"');
  });

  it('uninstall 后 agents 文件没有残留（空目录按既有约定只报告不替用户删）', async () => {
    const member = h.member('agents-uninstall');
    await initMember(member, ['claude', 'codex'], 'be');
    expect(existsSync(join(member.home, '.claude', 'agents'))).toBe(true);

    const un = await member.run(['uninstall', '--force']);
    expect(un.code, un.all).toBe(0);
    expect(member.exists('.claude', 'agents', 'review-assistant.md')).toBe(false);
    expect(member.exists('.claude', 'agents', 'be-deploy-bot.md')).toBe(false);
    expect(member.exists('.codex', 'agents', 'review-assistant.toml')).toBe(false);
    // 落点目录里不再有任何我们记账的东西：要么被收掉，要么剩空壳并在报告里点名（§10：分不清谁建的不删）
    if (member.exists('.claude', 'agents')) {
      expect(readdirSync(join(member.home, '.claude', 'agents'))).toEqual([]);
      expect(un.all).toContain(join(member.home, '.claude', 'agents'));
    }
    if (member.exists('.codex', 'agents')) {
      expect(readdirSync(join(member.home, '.codex', 'agents'))).toEqual([]);
    }
    expect(existsSync(ledgerPath(member.env))).toBe(false);
  });

  it('没有 agents 落点的工具（trae）不会被凭空造出 agents 目录', async () => {
    const member = h.member('agents-no-target');
    await initMember(member, ['trae'], 'be');
    expect(member.exists('.trae', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    expect(member.exists('.trae', 'agents')).toBe(false);
    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => e.resource.startsWith('agents:'))).toBe(false);
  });
});

describe('doctor 的 agents 落点检查', () => {
  it('投递后 PASS；目录被删掉后 WARN 点名工具与路径', async () => {
    const member = h.member('agents-doctor');
    await initMember(member, ['claude'], 'be');

    const good = await member.run(['doctor', '--json']);
    const doc = JSON.parse(good.out) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const check = doc.checks.find((c) => c.id === 'agents:target');
    expect(check?.status, check?.message).toBe('PASS');

    rmSync(join(member.home, '.claude', 'agents'), { recursive: true, force: true });
    const bad = await member.run(['doctor', '--json']);
    const badDoc = JSON.parse(bad.out) as { checks: Array<{ id: string; status: string; message: string }> };
    const warn = badDoc.checks.find((c) => c.id === 'agents:target');
    expect(warn?.status).toBe('WARN');
    expect(warn?.message).toContain('claude');
    expect(warn?.message).toContain(join(member.home, '.claude', 'agents'));
  });
});

describe('remove agents 命令面', () => {
  it('根与 ns 同名：拒绝并列出两处路径；<ns>/<name> 表态后正常提 MR', async () => {
    const member = h.member('agents-remove');
    await initMember(member, ['claude'], 'be');

    // 让根与 be 各有一份同名 agent（ns 覆盖根，delivery 不冲突；删哪一处波及的人不同）
    h.writeSeed('agents/be/review-assistant.md', NS_AGENT_MD.replace('be-deploy-bot', 'review-assistant'));
    h.commitSeed('add ns duplicate of root agent');

    const refuse = await member.run(['remove', 'agents', 'review-assistant']);
    expect(refuse.code, refuse.all).toBe(1);
    expect(refuse.all).toContain('两处都有同名条目');
    expect(refuse.all).toContain('agents/review-assistant.md');
    expect(refuse.all).toContain('agents/be/review-assistant.md');
    expect(h.remoteBranches().filter((b) => b.startsWith('ejdrone/'))).toEqual([]);

    const chosen = await member.run(['remove', 'agents', 'be/review-assistant']);
    expect(chosen.code, chosen.all).toBe(0);
    const branch = h.remoteBranches().find((b) => b.startsWith('ejdrone/push-agents-review-assistant-remove-'));
    expect(branch).toBeDefined();
    // 仓库现状没有被就地改动（要等 MR 合入）
    expect(h.seedRead('agents/be/review-assistant.md')).toBeDefined();
  });
});

describe('push --agent 反向采集（agentPushCommand，命令注册由协调者收口）', () => {
  it('从 claude 的 agents 目录采一个新 agent 入库：补 frontmatter、走 MR、合入后别的工具也拿到', async () => {
    const member = h.member('agents-push');
    await initMember(member, ['claude', 'codex'], 'be');

    // 成员在自己工具里养成了一个没有 frontmatter 的 agent
    const body = '# Log splitter\n\n把日志切成可读段落。\n';
    member.write('.claude/agents/my-helper.md', body);

    const run = cmdCtx(member);
    const code = await agentPushCommand(run.ctx, 'my-helper');
    expect(code, run.text()).toBe(0);
    expect(run.text()).toContain('已为 my-helper.md 补全 frontmatter');
    const branch = h.remoteBranches().find((b) => b.startsWith('ejdrone/push-agents-my-helper-'));
    expect(branch).toBeDefined();

    h.mergeIntoMain(branch as string);
    // 成员本地那份**从未记账**的原文先被当成他人文件：pull 保留并点名，绝不覆盖（§10）
    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(1);
    expect(pull.all).toContain(join(member.home, '.claude', 'agents', 'my-helper.md'));
    expect(member.read('.claude', 'agents', 'my-helper.md')).toBe(body);
    // codex 侧没有本地副本，直接按 toml 形态拿到
    expect(member.exists('.codex', 'agents', 'my-helper.toml')).toBe(true);

    // 成员删掉自己那份后重新 pull：拿到仓库补全过 frontmatter 的团队版本
    rmSync(join(member.home, '.claude', 'agents', 'my-helper.md'), { force: true });
    const repull = await member.run(['pull']);
    expect(repull.code, repull.all).toBe(0);
    const delivered = member.read('.claude', 'agents', 'my-helper.md');
    expect(delivered).toContain('name: my-helper');
    expect(delivered.endsWith(body)).toBe(true);
    expect(delivered).toBe(h.seedRead('agents/be/my-helper.md'));
  });

  it('多工具同名且内容不同：拒绝并逐处点名；--tool 表态后成功', async () => {
    const member = h.member('agents-push-ambiguous');
    await initMember(member, ['claude', 'qoder'], 'be');
    member.write('.claude/agents/shared-one.md', '# v1\n内容 A\n');
    member.write('.qoder/agents/shared-one.md', '# v2\n内容 B\n');

    const run = cmdCtx(member);
    expect(await agentPushCommand(run.ctx, 'shared-one')).toBe(1);
    expect(run.text()).toContain('内容不同');
    expect(run.text()).toContain(join(member.home, '.claude', 'agents', 'shared-one.md'));
    expect(run.text()).toContain(join(member.home, '.qoder', 'agents', 'shared-one.md'));
    expect(h.remoteBranches().filter((b) => b.startsWith('ejdrone/'))).toEqual([]);

    const scoped = cmdCtx(member);
    expect(await agentPushCommand(scoped.ctx, 'shared-one', { tool: 'claude' })).toBe(0);
    expect(scoped.text()).toContain('claude');
    expect(h.remoteBranches().some((b) => b.startsWith('ejdrone/push-agents-shared-one-'))).toBe(true);
  });

  it('toml 落点不做反向解析：点名原因与出路', async () => {
    const member = h.member('agents-push-toml');
    await initMember(member, ['codex'], 'be');
    member.write('.codex/agents/hand-rolled.toml', 'name = "hand-rolled"\n');

    const run = cmdCtx(member);
    expect(await agentPushCommand(run.ctx, 'hand-rolled')).toBe(1);
    expect(run.text()).toContain('toml');
    expect(run.text()).toContain('反向');
  });
});
