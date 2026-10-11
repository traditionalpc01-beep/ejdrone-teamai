import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ledgerPath } from '../../src/state.js';
import { loadLedger } from '../../src/core/ledger.js';
import { createHarness, installTools, seedMcp, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * MCP 下发的端到端：真实 git origin + 伪造 HOME，跑「仓库声明 → pull → 条目落在各工具原生配置里，
 * 且成员自己的条目一根汗毛都不动」这条主链路。
 *
 * 这里盯的是单元测试测不到的东西：投递与成员内容的**共存**。JSON 侧要保住 ~/.claude.json 里
 * 成员那 4 条 server 和 22KB 的其他状态键，TOML 侧要保住成员手写的 [model_providers] 等表与注释。
 */

const SENTINEL = 'SENTINEL-resolved-secret-value';

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
  seedMcp(h);
});

afterEach(() => {
  h.cleanup();
});

async function initMember(member: Member, ids: string[], role = 'be', env: Record<string, string> = {}): Promise<void> {
  installTools(member, ids);
  // 成员已经在用的配置：里面有一条自己的 server，格式故意做得"不规范"（缩进、注释、多余键）
  member.write(
    '.claude.json',
    '{\n  "userID": "abc123",\n  "numStartings": 7,\n  "mcpServers": {\n    "mine": { "command": "my-own-bin", "args": ["--fast"] }\n  }\n}',
  );
  member.write(
    '.codex/config.toml',
    '# 我自己的注释\nmodel = "glm-latest"\n\n[mcp_servers]\n\n[features]\nshell = "basic"\n\n[mcp_servers.mine]\ncommand = "my-own-bin"\n\n[mcp_servers.mine.env]\nFOO = "bar"\n',
  );
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', role], {
    env: withEnv(member, env),
  });
  expect(result.code, result.all).toBe(0);
}

const TOKEN_ENV = { BE_METRICS_TOKEN: SENTINEL };

function withEnv(member: Member, extra: Record<string, string>): Record<string, string> {
  return { ...(member.env as Record<string, string>), ...extra };
}

describe('MCP 投递与成员内容共存', () => {
  it('stdio 进 JSON、http 进 TOML：我们的条目在，成员的一条不少、手写注释不动', async () => {
    const member = h.member('mcp-coexist');
    await initMember(member, ['claude', 'codex'], 'be', TOKEN_ENV);

    const claude = JSON.parse(member.read('.claude.json')) as {
      userID: string;
      numStartings: number;
      mcpServers: Record<string, { command?: string; args?: string[]; url?: string; headers?: Record<string, string> }>;
    };
    // 成员自己的 server 与其他状态键都还在
    expect(claude.userID).toBe('abc123');
    expect(claude.numStartings).toBe(7);
    expect(claude.mcpServers.mine).toEqual({ command: 'my-own-bin', args: ['--fast'] });
    // 根条目（全员）落进来了
    expect(claude.mcpServers['shared-formatter']?.command).toBe('npx');
    expect(claude.mcpServers['shared-formatter']?.args).toEqual(['-y', '@acme/formatter-mcp']);
    // be 角色的 http 条目也落进来了，${VAR} 已解析成明文
    expect(claude.mcpServers['be-metrics']?.url).toBe('https://metrics.example.com/mcp');
    expect(claude.mcpServers['be-metrics']?.headers?.Authorization).toBe(`Bearer ${SENTINEL}`);

    // TOML 侧：成员手写的表与注释逐行还在，我们的块加在旁边
    const toml = member.read('.codex', 'config.toml');
    expect(toml).toContain('# 我自己的注释');
    expect(toml).toContain('model = "glm-latest"');
    expect(toml).toContain('[features]');
    expect(toml).toContain('shell = "basic"');
    expect(toml).toContain('[mcp_servers.mine]');
    expect(toml).toContain('[mcp_servers.mine.env]');
    expect(toml).toContain('FOO = "bar"');
    expect(toml).toContain('[mcp_servers.shared-formatter]');
    expect(toml).toContain('command = "npx"');

    // 哨兵：已解析的值只允许出现在投递进配置文件的那一处
    const pull = await member.run(['pull'], { env: withEnv(member, TOKEN_ENV) });
    for (const text of [pull.out, pull.err]) expect(text).not.toContain(SENTINEL);
    const debugLog = member.exists('.ejdrone', 'debug.log') ? member.read('.ejdrone', 'debug.log') : '';
    expect(debugLog).not.toContain(SENTINEL);
    expect(readFileSync(ledgerPath(member.env), 'utf8')).not.toContain(SENTINEL);
  });

  it('二次 pull 零写入；账本记的是我们那几个条目而不是整文件', async () => {
    const member = h.member('mcp-idempotent');
    await initMember(member, ['claude', 'codex']);
    const first = member.read('.claude.json');
    const firstToml = member.read('.codex', 'config.toml');

    const second = await member.run(['pull']);
    expect(second.code, second.all).toBe(0);
    expect(member.read('.claude.json')).toBe(first);
    expect(member.read('.codex', 'config.toml')).toBe(firstToml);

    const { ledger } = loadLedger(ledgerPath(member.env));
    const mergeEntries = ledger.entries.filter((e) => e.resource.startsWith('mcp:'));
    expect(mergeEntries.map((e) => e.resource).sort()).toEqual(['mcp:claude-merge', 'mcp:codex-merge']);
    // managedKeys 记条目而不是整文件哈希 —— 整文件里还有成员自己的东西，比不中
    for (const entry of mergeEntries) {
      expect(Object.keys(entry.managedKeys ?? {}).length).toBeGreaterThan(0);
      expect(entry.managedKeys?.['shared-formatter']).toMatch(/^sha256:/);
    }
  });

  it('停用 be 角色后，只有 be 的那条被撤走，根条目与成员条目留下', async () => {
    const member = h.member('mcp-role-off');
    await initMember(member, ['claude'], 'be', TOKEN_ENV);
    const before = JSON.parse(member.read('.claude.json')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(before.mcpServers['be-metrics']).toBeDefined();

    const set = await member.run(['roles', 'set', 'fe']);
    expect(set.code, set.all).toBe(0);
    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(0);

    const after = JSON.parse(member.read('.claude.json')) as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers['be-metrics']).toBeUndefined();
    expect(after.mcpServers['shared-formatter']).toBeDefined();
    expect(after.mcpServers.mine).toBeDefined();

    const { ledger } = loadLedger(ledgerPath(member.env));
    const claudeEntry = ledger.entries.find((e) => e.resource === 'mcp:claude-merge');
    expect(Object.keys(claudeEntry?.managedKeys ?? {})).toEqual(['shared-formatter']);
    // 整文件从未被 unlink：它归成员
    expect(member.exists('.claude.json')).toBe(true);
  });

  it('成员改过我们那一条：不覆盖、只点名，他的版本原样留在文件里', async () => {
    const member = h.member('mcp-user-edited');
    await initMember(member, ['claude']);

    const doc = JSON.parse(member.read('.claude.json')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    doc.mcpServers['shared-formatter'] = { command: 'edited-locally', args: [] };
    member.write('.claude.json', JSON.stringify(doc, null, 2));

    const pull = await member.run(['pull']);
    // keep 类问题按 1.0 的既有语义：pull 退出码 1，不写文件
    expect(pull.code, pull.all).toBe(1);
    // 点名必须点到条目：一条 .claude.json 里挂着好几条 server，只报文件路径成员不知道该改哪一条
    expect(pull.all).toContain('"shared-formatter"');
    expect(pull.all).toContain('.claude.json');

    const after = JSON.parse(member.read('.claude.json')) as typeof doc;
    expect(after.mcpServers['shared-formatter']).toEqual({ command: 'edited-locally', args: [] });
  });

  it('两个订阅角色定义同名 server：mcp 整体停发，已装条目与成员文件逐字节不动', async () => {
    const member = h.member('mcp-conflict');
    await initMember(member, ['claude']);
    const before = member.read('.claude.json');

    // 让 be 与 fe 两个**都激活**的 namespace 各自定义同名 server（root + 单个 ns 只是普通覆盖，不算冲突）
    h.writeSeed(
      'mcp/be/mcp.yaml',
      'servers:\n  - name: shared-formatter\n    transport: stdio\n    command: from-be\n    args: []\n',
    );
    h.writeSeed('mcp/fe/mcp.yaml', 'servers:\n  - name: shared-formatter\n    transport: stdio\n    command: other\n');
    h.commitSeed('two active namespaces define the same server');
    // 成员同时订阅 be 与 fe，于是两条都进候选集
    const set = await member.run(['roles', 'set', 'be', '--add', 'fe']);
    expect(set.code, set.all).toBe(0);

    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(1);
    expect(pull.all).toContain('mcp:shared-formatter conflict');
    // 停发 ≠ 删除：文件逐字节没动
    expect(member.read('.claude.json')).toBe(before);
  });

  it('mcp.yaml 写坏：本次 mcp 停发并说清楚，已装的条目一条都不掉', async () => {
    const member = h.member('mcp-broken-file');
    await initMember(member, ['claude']);
    const delivered = JSON.parse(member.read('.claude.json')) as { mcpServers: Record<string, unknown> };
    expect(delivered.mcpServers['shared-formatter']).toBeDefined();
    const before = member.read('.claude.json');

    // 把 servers: 拼成 server: —— 团队真会犯的错误，绝不能被当成"仓库里没有 server 了"
    h.writeSeed('mcp/mcp.yaml', 'server:\n  - name: shared-formatter\n    transport: stdio\n    command: npx\n');
    h.commitSeed('typo in mcp.yaml');

    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(1);
    expect(pull.all).toContain('mcp/mcp.yaml');
    expect(pull.all).toContain('停发');

    expect(member.read('.claude.json')).toBe(before);
  });

  it('缺环境变量：整条跳过并点名，不写空值、不打印值', async () => {
    const member = h.member('mcp-missing-var');
    // 故意不给 BE_METRICS_TOKEN：这条 server 属于"成员自己没配好"，不是团队写错仓库，
    // 所以退出码保持 0（否则每个人都有 server 只发给部分角色时 pull 天天红）。
    await initMember(member, ['claude']);
    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(0);
    expect(pull.all).toContain('BE_METRICS_TOKEN');
    expect(pull.all).toContain('be-metrics');
    expect(pull.all).not.toContain(SENTINEL);

    const doc = JSON.parse(member.read('.claude.json')) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers['be-metrics']).toBeUndefined();
    expect(doc.mcpServers['shared-formatter']).toBeDefined();
  });

  it('hooks 与 MCP 落在同一个文件（Qoder CN）：两条写路径互不破坏', async () => {
    const member = h.member('mcp-shared-file');
    await initMember(member, ['qoder-cn']);

    const settings = JSON.parse(member.read('.qoder-cn', 'settings.json')) as {
      hooks?: Record<string, unknown>;
      mcpServers?: Record<string, unknown>;
    };
    expect(settings.hooks?.SessionStart).toBeDefined();
    expect(settings.mcpServers?.['shared-formatter']).toBeDefined();

    // 再跑一次只动 hook 的操作：mcpServers 不该被抹掉，反之亦然
    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(0);
    const after = JSON.parse(member.read('.qoder-cn', 'settings.json')) as typeof settings;
    expect(after.mcpServers?.['shared-formatter']).toBeDefined();
    expect(after.hooks?.SessionStart).toBeDefined();

    const un = await member.run(['uninstall', '--force']);
    expect(un.code, un.all).toBe(0);
    const gone = JSON.parse(member.read('.qoder-cn', 'settings.json')) as Record<string, unknown>;
    // 我们的两个键都撤了，但那是成员在用的文件，不该被 unlink
    expect(gone.hooks).toBeUndefined();
    expect(gone.mcpServers).toEqual({});
  });

  it('表里没有 mcpTarget 的工具收不到 mcp，也不会被凭空造出配置文件', async () => {
    const member = h.member('mcp-unsupported-tool');
    await initMember(member, ['trae']);

    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.some((e) => e.resource.startsWith('mcp:'))).toBe(false);
    // trae 有 skills，但没有用户级 MCP 落点
    expect(member.exists('.trae', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    expect(member.exists('.trae', 'mcp.json')).toBe(false);
    expect(member.exists('.trae', 'mcp', 'mcp.json')).toBe(false);
  });
});
