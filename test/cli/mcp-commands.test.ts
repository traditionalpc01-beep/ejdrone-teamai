import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectMcpDefs } from '../../src/cli/mcpcollect.js';
import { defFromLocalEntry, scanLocalMcp } from '../../src/cli/mcpscan.js';
import {
  defToEntry,
  deleteMcpServers,
  externalizeSecrets,
  mcpRepoFile,
  upsertMcpServer,
} from '../../src/cli/mcprepo.js';
import { createContext } from '../../src/cli/context.js';
import type { McpServerDef } from '../../src/core/types.js';
import { TOOL_PATHS } from '../../src/agents/paths.js';

/**
 * M6 命令面的单元层：仓库 YAML 编辑、疑似密钥改写、反向采集的判歧义。
 * 端到端那部分在 test/integration/mcp-commands.test.ts。
 */

const SECRET = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAA_secretvalue';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(mkdtempSync('/tmp/'), 'ejdrone-mcp-unit-'));
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

function ctx(env: NodeJS.ProcessEnv = {}) {
  return createContext({ home, env, cwd: home, interactive: false, out: () => {}, err: () => {} });
}

function writeClaudeJson(servers: Record<string, unknown>): void {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------- 仓库 YAML 编辑

describe('mcp.yaml 编辑', () => {
  const base = [
    '# 团队约定：这条给后端用',
    'servers:',
    '  - name: shared-formatter',
    '    description: 统一格式化',
    '    transport: stdio',
    '    command: npx',
    '    args:',
    "      - '-y'",
    '',
  ].join('\n');

  it('追加条目时保留成员写的注释与既有条目顺序', () => {
    const edited = upsertMcpServer(mcpRepoFile(''), base, {
      name: 'second',
      transport: 'stdio',
      command: 'uvx',
    });
    expect(edited.ok).toBe(true);
    expect(edited.action).toBe('added');
    const text = edited.text as string;
    expect(text).toContain('# 团队约定：这条给后端用');
    expect(text.indexOf('shared-formatter')).toBeLessThan(text.indexOf('second'));
    expect(text).toContain("      - '-y'");
  });

  it('同名条目就地更新，不新增第二条', () => {
    const edited = upsertMcpServer(mcpRepoFile(''), base, { name: 'shared-formatter', transport: 'stdio', command: 'pnpm' });
    expect(edited.action).toBe('updated');
    const text = edited.text as string;
    expect(text).toContain('command: pnpm');
    expect(text.match(/shared-formatter/g)?.length).toBe(1);
  });

  it('就地更新时保留 tools / requires（仓库侧过滤器，本机文件里没有这个概念）', () => {
    const withFilters = [
      'servers:',
      '  - name: only-claude',
      '    transport: stdio',
      '    command: npx',
      '    requires:',
      '      - npx',
      '    tools:',
      '      - claude',
      '',
    ].join('\n');
    const edited = upsertMcpServer(mcpRepoFile(''), withFilters, { name: 'only-claude', transport: 'stdio', command: 'uvx' }, [
      'tools',
      'requires',
    ]);
    const text = edited.text as string;
    expect(text).toContain('command: uvx');
    expect(text).toContain('tools:');
    expect(text).toContain('requires:');
  });

  it('换 transport 时清掉另一套的字段', () => {
    const stdioText = ['servers:', '  - name: s', '    transport: stdio', '    command: npx', '    args:', "      - '-y'", ''].join(
      '\n',
    );
    const edited = upsertMcpServer(mcpRepoFile(''), stdioText, { name: 's', transport: 'http', url: 'https://x/mcp' });
    const text = edited.text as string;
    expect(text).toContain('url: https://x/mcp');
    expect(text).not.toContain('command');
    expect(text).not.toContain('args');
  });

  it('文件不存在时生成带头注释的新文件', () => {
    const edited = upsertMcpServer(mcpRepoFile('be'), null, { name: 'be-x', transport: 'stdio', command: 'npx' });
    const text = edited.text as string;
    expect(text.startsWith('# ')).toBe(true);
    expect(text).toContain('servers:');
    expect(mcpRepoFile('be')).toBe('mcp/be/mcp.yaml');
    expect(mcpRepoFile('')).toBe('mcp/mcp.yaml');
  });

  it.each([
    ['顶层不是映射', 'just a string\n'],
    ['缺 servers 键', '# 只有注释\nother: 1\n'],
    ['servers 不是列表', 'servers:\n  name: oops\n'],
    ['坏 YAML', 'servers:\n  - name: a\n   bad indent: [\n'],
  ])('认不出的形状一律拒绝改写（%s）', (_label, text) => {
    const edited = upsertMcpServer(mcpRepoFile(''), text, { name: 'new', transport: 'stdio', command: 'npx' });
    expect(edited.ok).toBe(false);
    expect(edited.error).toContain('mcp/mcp.yaml');
    expect(edited.text).toBeUndefined();
  });

  it('删除条目；删空了标 emptied，找不到的进 notFound', () => {
    const one = ['servers:', '  - name: solo', '    transport: stdio', '    command: npx', ''].join('\n');
    const deleted = deleteMcpServers(mcpRepoFile(''), one, ['solo']);
    expect(deleted.ok).toBe(true);
    expect(deleted.removed).toEqual(['solo']);
    expect(deleted.emptied).toBe(true);

    const two = [
      'servers:',
      '  - name: a',
      '    transport: stdio',
      '    command: npx',
      '  - name: b',
      '    transport: stdio',
      '    command: npx',
      '',
    ].join('\n');
    const partial = deleteMcpServers(mcpRepoFile(''), two, ['a', 'ghost']);
    expect(partial.removed).toEqual(['a']);
    expect(partial.notFound).toEqual(['ghost']);
    expect(partial.emptied).toBe(false);
    expect(partial.text).not.toContain('name: a');
    expect(partial.text).toContain('name: b');
  });

  it('defToEntry 不写空数组 / 空映射，键序固定', () => {
    const def: McpServerDef = { transport: 'stdio', command: 'npx', args: [], env: {}, requires: [], tools: [] };
    expect(Object.keys(defToEntry('x', def))).toEqual(['name', 'transport', 'command']);
  });
});

// ---------------------------------------------------------------- 疑似密钥改写

describe('疑似密钥 → ${VAR}', () => {
  it('键名以 TOKEN/KEY/SECRET/PASSWORD 结尾的明文值改写成生成变量名，且结果里不含原值', () => {
    const def: McpServerDef = {
      transport: 'stdio',
      command: 'npx',
      env: { WEATHER_API_TOKEN: SECRET, LANG: 'zh_CN.UTF-8' },
    };
    const scan = externalizeSecrets(def, 'local-weather', {});
    expect(scan.def.env).toEqual({ WEATHER_API_TOKEN: '${LOCAL_WEATHER_WEATHER_API_TOKEN}', LANG: 'zh_CN.UTF-8' });
    expect(scan.rewrites).toHaveLength(1);
    expect(scan.rewrites[0]).toMatchObject({ field: 'env', key: 'WEATHER_API_TOKEN', reused: false });
    expect(JSON.stringify(scan)).not.toContain(SECRET);
  });

  it('成员环境里已有同名变量时沿用那个名字（不再造新名）', () => {
    const scan = externalizeSecrets({ transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: SECRET } }, 'gh', {
      GITHUB_TOKEN: SECRET,
    });
    expect(scan.def.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
    expect(scan.rewrites[0]?.reused).toBe(true);
  });

  it('Authorization 这类按定义就是凭据的 header，键名不以它们结尾也算', () => {
    const scan = externalizeSecrets({ transport: 'http', url: 'https://x/mcp', headers: { Authorization: `Bearer ${SECRET}` } }, 'be-metrics', {});
    expect(scan.def.headers).toEqual({ Authorization: '${BE_METRICS_AUTHORIZATION}' });
    expect(scan.blocked).toEqual([]);
  });

  it('已经是 ${VAR} 的值不动它', () => {
    const scan = externalizeSecrets({ transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${BE_TOKEN}' } }, 's', {});
    expect(scan.def.headers).toEqual({ Authorization: 'Bearer ${BE_TOKEN}' });
    expect(scan.rewrites).toEqual([]);
  });

  it('command / args / url 里的凭据不改写、直接拒绝入库（改成 ${VAR} 会连命令与地址一起吞掉）', () => {
    const inArgs = externalizeSecrets({ transport: 'stdio', command: 'npx', args: ['--token=' + SECRET] }, 's', {});
    expect(inArgs.blocked.map((b) => b.field)).toEqual(['args']);
    const inUrl = externalizeSecrets({ transport: 'http', url: `https://x/mcp?key=${SECRET}` }, 's', {});
    expect(inUrl.blocked.map((b) => b.field)).toEqual(['url']);
    expect(JSON.stringify(inUrl)).not.toContain(SECRET);
  });

  it('普通 env（没有凭据形状）原样保留', () => {
    const scan = externalizeSecrets({ transport: 'stdio', command: 'npx', env: { NODE_ENV: 'production' } }, 's', {});
    expect(scan.def.env).toEqual({ NODE_ENV: 'production' });
    expect(scan.rewrites).toEqual([]);
  });
});

// ---------------------------------------------------------------- 反向采集

describe('push --mcp 的反向采集', () => {
  it('同一 server 在两个工具里内容一致 → 采一条，两个来源都点名', () => {
    writeClaudeJson({ dup: { command: 'npx', args: ['-y', 'p'] } });
    mkdirSync(join(home, TOOL_PATHS['qoder-cn'].rootRel), { recursive: true });
    writeFileSync(
      join(home, '.qoder-cn', 'settings.json'),
      JSON.stringify({ mcpServers: { dup: { command: 'npx', args: ['-y', 'p'] } } }),
      'utf8',
    );
    const out = collectMcpDefs(ctx(), ['claude', 'qoder-cn'], ['dup']);
    expect(out.ok, out.errors.join('\n')).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.origins).toHaveLength(2);
    expect(out.items[0]?.def).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'p'] });
  });

  it('同名不同内容 → 拒绝并列出两处文件，要求 --tool 缩范围（不猜）', () => {
    writeClaudeJson({ two: { command: 'npx' } });
    mkdirSync(join(home, '.qoder-cn'), { recursive: true });
    writeFileSync(join(home, '.qoder-cn', 'settings.json'), JSON.stringify({ mcpServers: { two: { command: 'uvx' } } }), 'utf8');
    const out = collectMcpDefs(ctx(), ['claude', 'qoder-cn'], ['two']);
    expect(out.ok).toBe(false);
    expect(out.errors.join('\n')).toContain('内容不同');
    expect(out.errors.join('\n')).toContain('--tool');
    expect(out.errors.join('\n')).toContain(join(home, '.claude.json'));
  });

  it('只在 TOML 落点里的 server：不做反向解析，给出仓库文件路径与条目形状', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.toml-only]\ncommand = "npx"\n', 'utf8');
    const out = collectMcpDefs(ctx(), ['codex'], ['toml-only']);
    expect(out.ok).toBe(false);
    const text = out.errors.join('\n');
    expect(text).toContain('TOML');
    expect(text).toContain('mcp/mcp.yaml');
    expect(text).toContain('transport: stdio');
  });

  it('采不到 / 名字不合法 / 一个工具都没选定：各自给一条错误', () => {
    writeClaudeJson({ present: { command: 'npx' } });
    const missing = collectMcpDefs(ctx(), ['claude'], ['absent-one']);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join('\n')).toContain('找不到 server「absent-one」');

    const badName = collectMcpDefs(ctx(), ['claude'], ['Bad Name']);
    expect(badName.errors.join('\n')).toContain('不合法');

    const noAgents = collectMcpDefs(ctx(), [], ['present']);
    expect(noAgents.ok).toBe(false);
  });

  it('采集时顺手把明文 token 改写成 ${VAR}，输出里不存在原值', () => {
    writeClaudeJson({ sneaky: { command: 'npx', env: { API_TOKEN: SECRET } } });
    const out = collectMcpDefs(ctx(), ['claude'], ['sneaky']);
    expect(out.ok, out.errors.join('\n')).toBe(true);
    expect(out.items[0]?.def.env).toEqual({ API_TOKEN: '${SNEAKY_API_TOKEN}' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('坏 JSON 只点名文件，不回显内容（V8 的解析错误会截取片段，那正是密钥所在地）', () => {
    writeFileSync(join(home, '.claude.json'), `{"mcpServers": {"broken": ${SECRET}},}`, 'utf8');
    const scan = scanLocalMcp(home, {}, ['claude']);
    expect(scan.entries).toHaveLength(0);
    expect(scan.notes.join('\n')).toContain('.claude.json');
    expect(scan.notes.join('\n')).not.toContain(SECRET);
  });
});

describe('条目形状逆映射', () => {
  function entryFor(id: 'opencode' | 'copilot', name: string, value: unknown) {
    const spec = TOOL_PATHS[id];
    const target = spec.mcpTarget;
    if (!target) throw new Error(`${id} 没有 mcpTarget`);
    return {
      agent: id,
      label: spec.label,
      style: target.style,
      format: target.format,
      file: join(home, `${name}.json`),
      name,
      collectable: true,
      value,
    };
  }

  it('opencode：type local 的 command 数组拆回 command/args，environment 变量名逆成 ${VAR}', () => {
    const r = defFromLocalEntry(
      entryFor('opencode', 'oc', { type: 'local', command: ['npx', '-y', 'pkg'], environment: ['MY_TOKEN', 'OTHER'] }),
    );
    expect(r.def).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { MY_TOKEN: '${MY_TOKEN}', OTHER: '${OTHER}' },
    });
  });

  it('opencode：type remote 走 url + headers', () => {
    const r = defFromLocalEntry(entryFor('opencode', 'oc2', { type: 'remote', url: 'https://x/mcp', headers: { A: 'B' } }));
    expect(r.def).toEqual({ transport: 'http', url: 'https://x/mcp', headers: { A: 'B' } });
  });

  it('copilot：单条命令行字符串按引号拆回参数，它的 tools 允许列表不入库', () => {
    const r = defFromLocalEntry(entryFor('copilot', 'cp', { type: 'local', command: 'npx -y "my pkg" --name="a b"', tools: ['*'] }));
    expect(r.def).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'my pkg', '--name=a b'] });
    expect(r.dropped).toEqual(['tools']);
  });

  it('认不出的形状给的是形状描述，不是猜', () => {
    expect(defFromLocalEntry(entryFor('opencode', 'bad', { url: 'https://x' })).error).toContain('type');
    expect(defFromLocalEntry(entryFor('copilot', 'bad2', { type: 'weird' })).error).toContain('只认');
  });
});
