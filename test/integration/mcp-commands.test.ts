import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { loadLedger } from '../../src/core/ledger.js';
import { ledgerPath } from '../../src/state.js';
import {
  createHarness,
  installTools,
  seedMcp,
  seedTeamRepo,
  type Harness,
  type Member,
} from './helpers.js';

/**
 * M6 命令面端到端：push --mcp 反向采集与 \${VAR} 改写、remove mcp 走 MR、list mcp 不回显值、
 * status 计入 mcp、doctor 的四个 mcp 检查项。
 *
 * 真实 git（origin 是 `git init --bare`），绝不 mock child_process。
 * 哨兵值 `SECRET-SENTINEL-…` 用来证明"任何输出 / 日志 / 仓库文件里都不出现已解析的凭据"。
 */

const SENTINEL = 'SECRET-SENTINEL-ghp_abcdefghijklmnop';

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
  seedMcp(h);
});

afterEach(() => {
  h.cleanup();
});

async function initMember(member: Member, ids: string[], role?: string): Promise<void> {
  installTools(member, ids);
  const args = ['init', h.origin, '--agent', ids.join(',')];
  if (role) args.push('--role', role);
  const result = await member.run(args);
  expect(result.code, result.all).toBe(0);
}

/** 往成员的本机 claude 配置里写两条 server：一条想入库（带明文 token），一条是成员自己的。 */
function seedLocalClaudeJson(member: Member, extra?: Record<string, unknown>): void {
  const file = member.path('.claude.json');
  const servers = {
    'local-weather': {
      command: 'npx',
      args: ['-y', '@acme/weather-mcp'],
      env: { WEATHER_API_TOKEN: SENTINEL },
    },
    'my-own-server': { command: 'uvx', args: ['personal'] },
    ...(extra ?? {}),
  };
  writeFileSync(file, JSON.stringify({ mcpServers: servers, otherToolState: { keep: true } }, null, 2) + '\n', 'utf8');
}

function claudeServers(member: Member): Record<string, unknown> {
  return JSON.parse(readFileSync(member.path('.claude.json'), 'utf8')).mcpServers as Record<string, unknown>;
}

function mcpBranch(harness: Harness, contains = ''): string {
  const branch = harness.remoteBranches().find((name) => name.startsWith('ejdrone/push-mcp-') && name.includes(contains));
  expect(branch, `远端分支：${harness.remoteBranches().join(', ')}`).toBeTruthy();
  return branch as string;
}

describe('push --mcp', () => {
  it('从 JSON 落点反向采集一条 server，写进 mcp/mcp.yaml 并开 MR', async () => {
    const member = h.member('push-mcp');
    await initMember(member, ['claude']);
    seedLocalClaudeJson(member);

    const pushed = await member.run(['push', '--mcp', 'local-weather']);
    expect(pushed.code, pushed.all).toBe(0);
    expect(pushed.all).toContain('待推送：');
    expect(pushed.all).toContain('local-weather');

    const branch = mcpBranch(h, 'local-weather');
    h.mergeIntoMain(branch);
    const text = h.seedRead('mcp/mcp.yaml');
    // 采集到的形状
    const doc = parseYaml(text) as { servers: Array<Record<string, unknown>> };
    const added = doc.servers.find((s) => s.name === 'local-weather');
    expect(added).toMatchObject({ transport: 'stdio', command: 'npx' });
    expect(added?.args).toEqual(['-y', '@acme/weather-mcp']);
    // seedMcp 写下的根条目还在，而且排在前面（追加，不重排）
    expect(doc.servers[0]?.name).toBe('shared-formatter');
  });

  it('疑似密钥自动改写成 ${VAR}：点名变量名与设置方法，值绝不出现在输出或仓库里', async () => {
    const member = h.member('push-mcp-secret');
    await initMember(member, ['claude']);
    seedLocalClaudeJson(member);

    const pushed = await member.run(['push', '--mcp', 'local-weather']);
    expect(pushed.code, pushed.all).toBe(0);
    expect(pushed.all).toContain('疑似密钥');
    expect(pushed.all).toContain('${LOCAL_WEATHER_WEATHER_API_TOKEN}');
    expect(pushed.all).toContain('export LOCAL_WEATHER_WEATHER_API_TOKEN=');
    // 值本身：stdout/stderr 与仓库文件里都不许出现
    expect(pushed.all).not.toContain(SENTINEL);

    const branch = mcpBranch(h, 'local-weather');
    h.mergeIntoMain(branch);
    expect(h.seedRead('mcp/mcp.yaml')).not.toContain(SENTINEL);
    expect(h.seedRead('mcp/mcp.yaml')).toContain('WEATHER_API_TOKEN: ${LOCAL_WEATHER_WEATHER_API_TOKEN}');

    // 别的成员没这个变量：pull 跳过这条并点名变量名，同样不回显值
    const other = h.member('push-mcp-other');
    await initMember(other, ['claude']);
    const pulled = await other.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(pulled.all).toContain('local-weather');
    expect(pulled.all).toContain('LOCAL_WEATHER_WEATHER_API_TOKEN');
    expect(pulled.all).not.toContain(SENTINEL);
    expect(claudeServers(other)).not.toHaveProperty('local-weather');
    expect(claudeServers(other)).toHaveProperty('shared-formatter');
  });

  it('成员环境里已有同名变量时沿用它，不再造新名字', async () => {
    const member = h.member('push-mcp-reuse');
    await initMember(member, ['claude']);
    seedLocalClaudeJson(member, {
      'gh-issues': { command: 'npx', args: ['@acme/gh'], env: { GITHUB_TOKEN: SENTINEL } },
    });

    const pushed = await member.run(['push', '--mcp', 'gh-issues'], {
      env: { ...member.env, GITHUB_TOKEN: SENTINEL },
    });
    expect(pushed.code, pushed.all).toBe(0);
    expect(pushed.all).toContain('${GITHUB_TOKEN}');
    expect(pushed.all).toContain('同名变量');
    expect(pushed.all).not.toContain(SENTINEL);
  });

  it('同名条目在两个工具里内容不同 → 拒绝并列出两处文件，要求 --tool 缩范围', async () => {
    const member = h.member('push-mcp-ambiguous');
    await initMember(member, ['claude', 'qoder-cn']);
    seedLocalClaudeJson(member);
    writeFileSync(
      member.path('.qoder-cn', 'settings.json'),
      JSON.stringify({ mcpServers: { 'local-weather': { command: 'uvx', args: ['other-pkg'] } } }, null, 2),
      'utf8',
    );

    const pushed = await member.run(['push', '--mcp', 'local-weather']);
    expect(pushed.code).toBe(1);
    expect(pushed.all).toContain('内容不同');
    expect(pushed.all).toContain(member.path('.claude.json'));
    expect(pushed.all).toContain(member.path('.qoder-cn', 'settings.json'));
    expect(pushed.all).toContain('--tool');
    expect(h.remoteBranches().filter((n) => n.includes('local-weather'))).toEqual([]);

    const narrowed = await member.run(['push', '--mcp', 'local-weather', '--tool', 'claude']);
    expect(narrowed.code, narrowed.all).toBe(0);
    expect(narrowed.all).toContain('疑似密钥');
  });

  it('只在 TOML 落点里的 server 不做反向解析：点名文件路径并给出条目形状', async () => {
    const member = h.member('push-mcp-toml');
    await initMember(member, ['codex']);
    member.write('.codex/config.toml', '[mcp_servers.toml-only]\ncommand = "npx"\n');

    const pushed = await member.run(['push', '--mcp', 'toml-only']);
    expect(pushed.code).toBe(1);
    expect(pushed.all).toContain('TOML');
    expect(pushed.all).toContain('mcp/mcp.yaml');
    expect(pushed.all).toContain('transport: stdio');
    expect(pushed.all).not.toContain(SENTINEL);
  });

  it('--all 不把本机 MCP server 捎进 MR（只含 skills/rules）', async () => {
    const member = h.member('push-all-no-mcp');
    await initMember(member, ['claude']);
    seedLocalClaudeJson(member);
    member.write('.claude/skills/my-local-skill/SKILL.md', '# My local skill\n\n只写了一份的技能。\n');

    const pushed = await member.run(['push', '--all']);
    expect(pushed.code, pushed.all).toBe(0);
    expect(pushed.all).toContain('my-local-skill');
    expect(pushed.all).not.toContain('local-weather');
    // 没有 mcp 分支：--all 一条 MCP 都不采
    expect(h.remoteBranches().filter((n) => n.startsWith('ejdrone/push-mcp-'))).toEqual([]);
    h.mergeIntoMain(h.remoteBranches().find((n) => n.includes('my-local-skill')) as string);
    // 仓库里的 mcp/mcp.yaml 一个字都没动
    expect(h.seedRead('mcp/mcp.yaml')).not.toContain('local-weather');
  });

  it('写坏过的 mcp.yaml（认不出形状）不会被 push 重写', async () => {
    const member = h.member('push-mcp-shape');
    await initMember(member, ['claude']);
    seedLocalClaudeJson(member);
    h.writeSeed('mcp/mcp.yaml', 'server:\n  - name: typo\n');
    h.commitSeed('break the mcp file');

    const pushed = await member.run(['push', '--mcp', 'local-weather']);
    expect(pushed.code, pushed.all).toBe(1);
    expect(pushed.all).toContain('mcp/mcp.yaml');
    expect(h.remoteBranches().filter((n) => n.startsWith('ejdrone/push-mcp-'))).toEqual([]);
  });

  it('有角色时进 mcp/<ns>/mcp.yaml（角色映射多个 namespace 时必须 --ns）', async () => {
    h.writeSeed('manifest/roles.yaml', 'version: 1\nroles:\n  - id: full\n    namespaces: [be, fe]\n');
    h.commitSeed('a role with two namespaces');

    const member = h.member('push-mcp-ns');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'full']);
    expect(init.code, init.all).toBe(0);
    seedLocalClaudeJson(member);

    const guessed = await member.run(['push', '--mcp', 'local-weather']);
    expect(guessed.code).toBe(1);
    expect(guessed.all).toContain('多个 namespace');

    const pushed = await member.run(['push', '--mcp', 'local-weather', '--ns', 'fe']);
    expect(pushed.code, pushed.all).toBe(0);
    h.mergeIntoMain(mcpBranch(h, 'local-weather'));
    expect(h.seedRead('mcp/fe/mcp.yaml')).toContain('local-weather');
    // 根文件一个字节都没动
    expect(h.seedRead('mcp/mcp.yaml')).not.toContain('local-weather');
  });

  it('--mcp 与 --skill 可以同一条 MR：两处文件都写、注释与顺序都不丢', async () => {
    const member = h.member('push-mcp-mixed');
    await initMember(member, ['claude']);
    seedLocalClaudeJson(member);
    member.write('.claude/skills/mixed-skill/SKILL.md', '# Mixed\n\n和技能同一条 MR。\n');

    const pushed = await member.run(['push', '--mcp', 'local-weather', '--skill', member.path('.claude/skills/mixed-skill')]);
    expect(pushed.code, pushed.all).toBe(0);
    expect(pushed.all).toContain('local-weather');
    expect(pushed.all).toContain('mixed-skill');
    const branch = h.remoteBranches().find((n) => n.startsWith('ejdrone/push-mixed-batch-'));
    expect(branch, h.remoteBranches().join(', ')).toBeTruthy();
    h.mergeIntoMain(branch as string);
    expect(h.seedRead('skills/mixed-skill/SKILL.md')).toContain('# Mixed');
    expect(h.seedRead('mcp/mcp.yaml')).toContain('local-weather');
    expect(h.seedRead('mcp/mcp.yaml')).toContain('shared-formatter');
  });
});

describe('kind 白名单接到 mcp', () => {
  it('remove / list 认得 mcp，不认识的 kind 报错时把可选值连 mcp 一起列出', async () => {
    const member = h.member('kind-mcp');
    await initMember(member, ['claude'], 'be');

    // 负例用 'widgets'：docs / agents / learnings 自 M7-M9 起是合法 kind，
    // 拿它们当负例测的是"白名单还没接上"，接上之后这条用例就会静默失效。
    const badRemove = await member.run(['remove', 'widgets', 'whatever']);
    expect(badRemove.code).toBe(1);
    expect(badRemove.all).toContain('mcp');
    expect(badRemove.all).toContain('agents');

    const badList = await member.run(['list', 'widgets']);
    expect(badList.code).toBe(1);
    expect(badList.all).toContain('mcp');

    const singular = await member.run(['remove', 'mcps', 'ghost-one']);
    expect(singular.code).toBe(1);
    // 单数别名被认下来了：走的不是"未知类型"分支，而是"找不到条目"分支
    expect(singular.all).toContain('找不到 mcp ghost-one');
  });
});

describe('remove mcp', () => {
  it('走 MR 删仓库条目，本机那份一个字都不动；合入后由 pull 撤掉', async () => {
    // 根文件里先塞第二条，这样"删一条"不会连带把文件删空（删空那条路径另有用例）
    h.writeSeed(
      'mcp/mcp.yaml',
      [
        'servers:',
        '  - name: shared-formatter',
        '    transport: stdio',
        '    command: npx',
        "    args: ['-y', '@acme/formatter-mcp']",
        '  - name: another-root',
        '    transport: stdio',
        '    command: uvx',
        '',
      ].join('\n'),
    );
    h.commitSeed('second root server');

    const member = h.member('remove-mcp');
    // 给 be 角色的那条 http server 备上变量，好让"删掉根条目时别动 ns 条目"这条能被观察到
    const withToken = { env: { ...member.env, BE_METRICS_TOKEN: 'test-only-value' } };
    installTools(member, ['claude', 'codex']);
    const init = await member.run(['init', h.origin, '--agent', 'claude,codex', '--role', 'be'], withToken);
    expect(init.code, init.all).toBe(0);
    expect(claudeServers(member)).toHaveProperty('shared-formatter');
    expect(claudeServers(member)).toHaveProperty('be-metrics');
    const claudeBefore = readFileSync(member.path('.claude.json'), 'utf8');
    const codexBefore = readFileSync(member.path('.codex', 'config.toml'), 'utf8');

    const removed = await member.run(['remove', 'mcp', 'shared-formatter']);
    expect(removed.code, removed.all).toBe(0);
    expect(removed.all).toContain('已提交删除 mcp');
    // 决定 3：只从仓库删（走 MR），绝不动成员本机
    expect(readFileSync(member.path('.claude.json'), 'utf8')).toBe(claudeBefore);
    expect(readFileSync(member.path('.codex', 'config.toml'), 'utf8')).toBe(codexBefore);

    const branch = mcpBranch(h, 'shared-formatter');
    h.mergeIntoMain(branch);
    const rest = parseYaml(h.seedRead('mcp/mcp.yaml')) as { servers: Array<{ name: string }> };
    expect(rest.servers.map((s) => s.name)).toEqual(['another-root']);

    const pulled = await member.run(['pull'], withToken);
    expect(pulled.code, pulled.all).toBe(0);
    expect(claudeServers(member)).not.toHaveProperty('shared-formatter');
    expect(claudeServers(member)).toHaveProperty('another-root');
    // 角色 be 的那条还在（只删了点名的那条）
    expect(claudeServers(member)).toHaveProperty('be-metrics');
  });

  it('根与 ns 两处同名 → 拒绝执行并列出两个文件，带 --ns 才动手', async () => {
    h.writeSeed(
      'mcp/be/mcp.yaml',
      ['servers:', '  - name: shared-formatter', '    transport: stdio', '    command: uvx', ''].join('\n'),
    );
    h.commitSeed('same name in root and be');

    const member = h.member('remove-mcp-dup');
    await initMember(member, ['claude'], 'be');

    const refused = await member.run(['remove', 'mcp', 'shared-formatter']);
    expect(refused.code).toBe(1);
    expect(refused.all).toContain('mcp/mcp.yaml');
    expect(refused.all).toContain('mcp/be/mcp.yaml');
    expect(refused.all).toContain('--ns');
    expect(h.remoteBranches().filter((n) => n.startsWith('ejdrone/push-mcp-'))).toEqual([]);

    const removed = await member.run(['remove', 'mcp', 'shared-formatter', '--ns', 'be']);
    expect(removed.code, removed.all).toBe(0);
    const branch = mcpBranch(h, 'shared-formatter');
    h.mergeIntoMain(branch);
    // ns 文件被整个删除（servers 删空了就走删除文件），根文件仍在
    expect(() => h.seedRead('mcp/be/mcp.yaml')).toThrow();
    expect(h.seedRead('mcp/mcp.yaml')).toContain('shared-formatter');
  });

  it('删掉最后一条时把整个 mcp/mcp.yaml 走删除，合入后各工具条目清空、成员条目不动', async () => {
    const member = h.member('remove-mcp-empty');
    await initMember(member, ['claude']);
    writeFileSync(
      member.path('.claude.json'),
      JSON.stringify({ mcpServers: { 'mine-personal': { command: 'uvx' } } }, null, 2),
      'utf8',
    );
    const pulled = await member.run(['pull']);
    expect(pulled.code, pulled.all).toBe(0);
    expect(claudeServers(member)).toHaveProperty('shared-formatter');

    const removed = await member.run(['remove', 'mcp', 'shared-formatter']);
    expect(removed.code, removed.all).toBe(0);
    h.mergeIntoMain(mcpBranch(h, 'shared-formatter'));
    expect(() => h.seedRead('mcp/mcp.yaml')).toThrow();

    const after = await member.run(['pull']);
    expect(after.code, after.all).toBe(0);
    const servers = claudeServers(member);
    expect(servers).not.toHaveProperty('shared-formatter');
    expect(servers).toHaveProperty('mine-personal');
    // 记账也一并撤掉：不留一条指向别人文件的账
    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => Object.keys(e.managedKeys ?? {}).includes('shared-formatter'))).toBe(false);
  });

  it('名字找不到只给提示，全都没有才失败', async () => {
    const member = h.member('remove-mcp-missing');
    await initMember(member, ['claude'], 'be');
    const removed = await member.run(['remove', 'mcp', 'ghost-server']);
    expect(removed.code).toBe(1);
    expect(removed.all).toContain('找不到 mcp ghost-server');
  });
});

describe('list mcp', () => {
  it('仓库源显示 name/namespace/transport 与本次是否会下发，不回显任何值', async () => {
    const member = h.member('list-mcp-repo');
    await initMember(member, ['claude'], 'be');
    writeFileSync(member.path('.claude.json'), JSON.stringify({ mcpServers: { 'mine-personal': { command: SENTINEL } } }), 'utf8');

    const listed = await member.run(['list', 'mcp']);
    expect(listed.code, listed.all).toBe(0);
    expect(listed.all).toContain('shared-formatter');
    expect(listed.all).toContain('stdio');
    expect(listed.all).toContain('be-metrics');
    expect(listed.all).toContain('http');
    // be 角色订阅了 be → 两条都会下发
    expect(listed.all).toContain('本次会下发');
    expect(listed.all).not.toContain(SENTINEL);
    expect(listed.all).not.toContain('npx');
    expect(listed.all).not.toContain('metrics.example.com');
  });

  it('条目写了 tools: 而成员没勾那个工具时，list mcp 说清"这次收不到"', async () => {
    h.writeSeed(
      'mcp/mcp.yaml',
      [
        'servers:',
        '  - name: shared-formatter',
        '    transport: stdio',
        '    command: npx',
        '  - name: codex-only',
        '    transport: stdio',
        '    command: uvx',
        '    tools: [codex]',
        '',
      ].join('\n'),
    );
    h.commitSeed('a server restricted to codex');

    const claudeOnly = h.member('list-mcp-tools');
    await initMember(claudeOnly, ['claude']);
    const listed = await claudeOnly.run(['list', 'mcp']);
    expect(listed.code, listed.all).toBe(0);
    expect(listed.all).toContain('codex-only');
    expect(listed.all).toContain('只发给 codex');
    expect(listed.all).toContain('本次收不到');
    // 没有限定的那条照常下发
    expect(listed.all).toContain('shared-formatter  根条目  stdio  本次会下发');

    const withCodex = h.member('list-mcp-tools-codex');
    await initMember(withCodex, ['claude', 'codex']);
    const both = await withCodex.run(['list', 'mcp']);
    expect(both.all).toContain('codex-only  根条目  stdio  本次会下发');
  });

  it('local 源只列 server 名、工具与文件路径，不列 command/args/env/headers/url 的值', async () => {
    const member = h.member('list-mcp-local');
    await initMember(member, ['claude', 'codex', 'trae'], 'be');
    seedLocalClaudeJson(member);
    member.write('.codex/config.toml', '[mcp_servers.toml-only]\ncommand = "npx"\n');

    const listed = await member.run(['list', 'mcp', '--source', 'local']);
    expect(listed.code, listed.all).toBe(0);
    expect(listed.all).toContain('local-weather');
    expect(listed.all).toContain(member.path('.claude.json'));
    expect(listed.all).toContain('toml-only');
    expect(listed.all).toContain('TOML');
    expect(listed.all).toContain('没有用户级 MCP 落点');
    expect(listed.all).not.toContain(SENTINEL);
    expect(listed.all).not.toContain('@acme/weather-mcp');
  });

  it('mcp.yaml 写坏时 list mcp 直接失败并说明停发，其他 kind 的 list 只给提示', async () => {
    const member = h.member('list-mcp-broken');
    await initMember(member, ['claude'], 'be');
    h.writeSeed('mcp/mcp.yaml', 'server: []\n');
    h.commitSeed('break the mcp file');

    const broken = await member.run(['list', 'mcp']);
    expect(broken.code).toBe(1);
    expect(broken.all).toContain('停发');

    const others = await member.run(['list', 'skills']);
    expect(others.code, others.all).toBe(0);
    expect(others.all).toContain('root-note');
    expect(others.all).toContain('mcp');
  });
});

describe('status 与 doctor 里的 mcp', () => {
  it('status 计入 mcp：待推送与落后都看得见，且不带值', async () => {
    const member = h.member('status-mcp');
    await initMember(member, ['claude'], 'be');
    seedLocalClaudeJson(member);

    const report = await member.run(['status']);
    expect(report.code, report.all).toBe(0);
    expect(report.all).toContain('MCP：仓库 2 条');
    expect(report.all).toContain('待推送：local-weather');
    expect(report.all).toContain('push --mcp');
    expect(report.all).not.toContain(SENTINEL);
  });

  it('doctor 四项：坏文件 FAIL、缺变量 WARN 给设置方法、条目被改过 WARN、无落点工具 WARN', async () => {
    const member = h.member('doctor-mcp');
    // trae 没有用户级 MCP 落点 → mcp:target WARN
    await initMember(member, ['claude', 'trae'], 'be');

    const missingVar = await member.run(['doctor', '--json']);
    const doc = JSON.parse(missingVar.out) as { ok: boolean; checks: Array<{ id: string; status: string; message: string; hint?: string }> };
    const byId = (id: string) => doc.checks.find((c) => c.id === id);
    expect(byId('mcp:parse')?.status).toBe('PASS');
    // BE_METRICS_TOKEN 没设 → be-metrics 整条跳过
    expect(byId('mcp:var')?.status).toBe('WARN');
    expect(byId('mcp:var')?.message).toContain('be-metrics');
    expect(byId('mcp:var')?.message).toContain('BE_METRICS_TOKEN');
    expect(byId('mcp:var')?.hint).toContain('export BE_METRICS_TOKEN=');
    expect(byId('mcp:var')?.message).not.toContain(SENTINEL);
    expect(byId('mcp:managed')?.status).toBe('PASS');
    expect(byId('mcp:target')?.status).toBe('WARN');
    expect(byId('mcp:target')?.message).toContain('trae');
    expect(missingVar.all).not.toContain(SENTINEL);

    // 文件级解析失败 → mcp:parse FAIL，并且真的把本次 mcp 停发（已装内容不动）
    h.writeSeed('mcp/mcp.yaml', 'servers:\n  name: not-a-list\n');
    h.commitSeed('break mcp.yaml');
    const broken = await member.run(['doctor', '--json']);
    expect(broken.code).toBe(1);
    const brokenDoc = JSON.parse(broken.out) as { checks: Array<{ id: string; status: string; message: string }> };
    const parse = brokenDoc.checks.find((c) => c.id === 'mcp:parse');
    expect(parse?.status).toBe('FAIL');
    expect(parse?.message).toContain('已停发');
    expect(parse?.message).toContain('已装内容不动');
  });

  it('成员改过我们投的那条 server → mcp:managed WARN 指到文件与条目名', async () => {
    const member = h.member('doctor-managed');
    await initMember(member, ['claude']);
    expect(claudeServers(member)).toHaveProperty('shared-formatter');

    const settings = JSON.parse(readFileSync(member.path('.claude.json'), 'utf8'));
    settings.mcpServers['shared-formatter'].command = 'pnpm';
    writeFileSync(member.path('.claude.json'), JSON.stringify(settings, null, 2), 'utf8');

    const report = await member.run(['doctor', '--json']);
    const doc = JSON.parse(report.out) as { checks: Array<{ id: string; status: string; message: string; hint?: string }> };
    const managed = doc.checks.find((c) => c.id === 'mcp:managed');
    expect(managed?.status).toBe('WARN');
    expect(managed?.message).toContain('与账本不一致');
    expect(managed?.hint).toContain('shared-formatter');
    expect(report.code, report.all).toBe(0);

    // 改过的那条不被覆盖：再 pull 也还是 pnpm
    const pulled = await member.run(['pull']);
    expect(pulled.all).toContain('shared-formatter');
    expect(claudeServers(member)['shared-formatter']).toMatchObject({ command: 'pnpm' });
  });
});
