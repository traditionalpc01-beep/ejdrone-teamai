import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadLedger } from '../../src/core/ledger.js';
import { ledgerPath } from '../../src/state.js';
import { createHarness, installTools, seedTags, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * 端到端（2.1 标签订阅）：带标条目跨 namespace 下发 / 退订清理 / 与角色的同名冲突 /
 * MCP 条目标签 / 管理员 tags add/remove 的 MR 产物。种子见 helpers.seedTags。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
  seedTags(h);
});

afterEach(() => {
  h.cleanup();
});

function parseSummary(text: string): { written: number; deleted: number; kept: number } {
  const match = /已投递 (\d+) 个文件到 \d+ 个工具；删除 (\d+)；保留 (\d+)/.exec(text);
  if (!match) throw new Error(`输出里没有投递摘要：\n${text}`);
  return { written: Number(match[1]), deleted: Number(match[2]), kept: Number(match[3]) };
}

async function initFe(member: Member, ids: string[] = ['claude']): Promise<void> {
  installTools(member, ids);
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', 'fe']);
  expect(result.code, result.all).toBe(0);
}

describe('标签订阅：下发与退订', () => {
  it('fe 成员订阅 ops-tools 后带标条目跨 ns 下发；同 ns 未带标的与根条目互不影响', async () => {
    const member = h.member('fe-subscriber');
    await initFe(member);

    // 订阅前：ops-* 都不在（be ns 未激活）
    expect(member.exists('.claude', 'skills', 'ops-helper')).toBe(false);
    const sub = await member.run(['tags', 'subscribe', 'ops-tools']);
    expect(sub.code, sub.all).toBe(0);
    expect(sub.all).toContain('已订阅标签：ops-tools');

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(member.exists('.claude', 'skills', 'ops-helper', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'rules', 'ops-runbook.md')).toBe(true);
    // 同 ns 未带标的对照：标签订阅是条目级豁免，不是把整个 namespace 放进来
    expect(member.exists('.claude', 'skills', 'ops-plain')).toBe(false);
    expect(member.exists('.claude', 'skills', 'be-deploy')).toBe(false);
    // 根条目照常
    expect(member.exists('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    expect(parseSummary(pulled.all).written).toBe(3); // skill + rule + ~/.claude.json 的 MCP 合并写

    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => e.resource === 'skills:ops-helper')).toBe(true);
    expect(ledger.entries.some((e) => e.resource === 'rules:ops-runbook')).toBe(true);
  });

  it('退订后 pull 撤走只因此标签下发的条目，账本清干净', async () => {
    const member = h.member('fe-unsubscriber');
    await initFe(member);
    await member.run(['tags', 'subscribe', 'ops-tools']);
    expect((await member.run(['pull'])).code).toBe(0);

    const unsub = await member.run(['tags', 'unsubscribe', 'ops-tools']);
    expect(unsub.code, unsub.all).toBe(0);
    expect(unsub.all).toContain('已退订：ops-tools');

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(member.exists('.claude', 'skills', 'ops-helper', 'SKILL.md')).toBe(false);
    expect(member.exists('.claude', 'rules', 'ops-runbook.md')).toBe(false);
    expect(parseSummary(pulled.all).deleted).toBe(2);
    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => e.resource === 'skills:ops-helper')).toBe(false);
    expect(ledger.entries.some((e) => e.resource === 'rules:ops-runbook')).toBe(false);
  });

  it('订阅仓库无人使用的标签：写入成功但 pull 点名不生效', async () => {
    const member = h.member('fe-ghost-tag');
    await initFe(member);
    const sub = await member.run(['tags', 'subscribe', 'ghost-tag']);
    expect(sub.code, sub.all).toBe(0);
    expect(sub.all).toContain('订阅暂不生效');

    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(pulled.all).toContain('ghost-tag');
    expect(parseSummary(pulled.all).written).toBe(0);
  });
});

describe('标签订阅：与角色的同名冲突', () => {
  it('tag 激活 be 份与角色激活 fe 份同名 → 停发 skills、退出码 1、已装不删', async () => {
    h.writeSeed('skills/fe/ops-helper/SKILL.md', '# FE ops-helper\n\n与 be 份同名：订阅后是冲突。\n');
    h.commitSeed('fe duplicate of ops-helper');

    const member = h.member('fe-conflict');
    await initFe(member);
    // 订阅前：fe 份经角色正常下发
    expect(member.read('.claude', 'skills', 'ops-helper', 'SKILL.md')).toContain('FE ops-helper');

    await member.run(['tags', 'subscribe', 'ops-tools']);
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(1);
    expect(pulled.all).toContain('冲突');
    // 停发 ≠ 删除：fe 份与根条目都留在原地
    expect(member.exists('.claude', 'skills', 'ops-helper', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => e.resource === 'skills:ops-helper')).toBe(true);
  });
});

describe('MCP 条目标签', () => {
  it('订阅后带标 server 跨 ns 合进 ~/.claude.json，退订后逐键撤走', async () => {
    const member = h.member('fe-mcp-tags');
    await initFe(member);

    await member.run(['tags', 'subscribe', 'ops-tools']);
    expect((await member.run(['pull'])).code).toBe(0);
    const afterSub = JSON.parse(member.read('.claude.json')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(afterSub.mcpServers)).toContain('ops-relay');

    await member.run(['tags', 'unsubscribe', 'ops-tools']);
    expect((await member.run(['pull'])).code).toBe(0);
    const afterUnsub = JSON.parse(member.read('.claude.json')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(afterUnsub.mcpServers)).not.toContain('ops-relay');
  });
});

describe('tags list / subscribe 校验', () => {
  it('list 显示标签来源与本地订阅；非法标签名被拒绝', async () => {
    const member = h.member('tags-list');
    await initFe(member);

    const list = await member.run(['tags', 'list']);
    expect(list.code, list.all).toBe(0);
    expect(list.all).toContain('ops-tools');
    expect(list.all).toContain('ops-helper');
    expect(list.all).toContain('本地订阅：（无）');

    const bad = await member.run(['tags', 'subscribe', 'Ops Tools!']);
    expect(bad.code, bad.all).toBe(1);
    expect(bad.all).toContain('标签名不合法');

    const sub = await member.run(['tags', 'subscribe', 'ops-tools,ci']);
    expect(sub.code, sub.all).toBe(0);
    const again = await member.run(['tags', 'list']);
    expect(again.all).toContain('已订阅');
    // ci 在仓库无人使用：list 也点名
    expect(again.all).toContain('ci');
  });
});

describe('管理员 tags add / remove（MR 改仓库 frontmatter）', () => {
  it('给 be-deploy 加标签开分支，合入后 frontmatter 带标；重复加同标不开新 MR；remove 删键', async () => {
    const admin = h.member('tags-admin');
    installTools(admin, ['claude']);
    const init = await admin.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    const added = await admin.run(['tags', 'add', 'skills', 'be-deploy', 'deploy-tools']);
    expect(added.code, added.all).toBe(0);
    const branch = h.remoteBranches().find((b) => b.startsWith('ejdrone/tags-add-skills-be-deploy-'));
    expect(branch, added.all).toBeTruthy();
    h.mergeIntoMain(branch as string);
    expect(h.seedRead('skills/be/be-deploy/SKILL.md')).toContain('tags:');
    expect(h.seedRead('skills/be/be-deploy/SKILL.md')).toContain('deploy-tools');
    // 其余键（name/description 由 push 补过或保留原样）与正文还在
    expect(h.seedRead('skills/be/be-deploy/SKILL.md')).toContain('# BE deploy');

    // no-op：再点一次同分支不开（快照已带标 → 无需提交）
    const noop = await admin.run(['tags', 'add', 'skills', 'be-deploy', 'deploy-tools']);
    expect(noop.code, noop.all).toBe(0);
    expect(noop.all).toContain('无需提交');

    const removed = await admin.run(['tags', 'remove', 'skills', 'be-deploy', 'deploy-tools']);
    expect(removed.code, removed.all).toBe(0);
    const rmBranch = h.remoteBranches().find((b) => b.startsWith('ejdrone/tags-remove-skills-be-deploy-'));
    expect(rmBranch, removed.all).toBeTruthy();
    h.mergeIntoMain(rmBranch as string);
    expect(h.seedRead('skills/be/be-deploy/SKILL.md')).not.toContain('deploy-tools');
  });

  it('mcp 条目：tags add 直接改 mcp/<ns>/mcp.yaml 的对应 server', async () => {
    const admin = h.member('tags-admin-mcp');
    installTools(admin, ['claude']);
    const init = await admin.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    const added = await admin.run(['tags', 'add', 'mcp', 'ops-relay', 'ci']);
    expect(added.code, added.all).toBe(0);
    const branch = h.remoteBranches().find((b) => b.startsWith('ejdrone/tags-add-mcp-ops-relay-'));
    expect(branch, added.all).toBeTruthy();
    h.mergeIntoMain(branch as string);
    const text = h.seedRead('mcp/be/mcp.yaml');
    expect(text).toContain('name: ops-relay');
    expect(text).toContain('tags:');
    expect(text).toContain('ci');
  });

  it('同名条目分布在根与 ns 时必须 --ns 挑一份；不存在的条目报错', async () => {
    h.writeSeed('skills/fe/be-deploy/SKILL.md', '# FE be-deploy\n\n与根下无、与 be 下同名的对照。\n');
    h.commitSeed('duplicate be-deploy in fe');

    const admin = h.member('tags-admin-amb');
    installTools(admin, ['claude']);
    const init = await admin.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    const ambiguous = await admin.run(['tags', 'add', 'skills', 'be-deploy', 'deploy-tools']);
    expect(ambiguous.code, ambiguous.all).toBe(1);
    expect(ambiguous.all).toContain('--ns');

    const withNs = await admin.run(['tags', 'add', 'skills', 'be-deploy', 'deploy-tools', '--ns', 'be']);
    expect(withNs.code, withNs.all).toBe(0);

    const missing = await admin.run(['tags', 'add', 'skills', 'no-such-skill', 'x']);
    expect(missing.code, missing.all).toBe(1);
    expect(missing.all).toContain('没有 skills「no-such-skill」');
  });
});
