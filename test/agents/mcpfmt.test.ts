import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { McpServerDef, PlannedWrite, Resource } from '../../src/core/types.js';
import { mergeEntries } from '../../src/core/merge.js';
import { planMcpFor } from '../../src/agents/common.js';
import { mcpMergeResourceKey, renderMcpEntries, renderMcpEntry, whichOn } from '../../src/agents/mcpfmt.js';
import type { McpTargetStyle } from '../../src/agents/paths.js';

/**
 * T6.5 的条目渲染 + planMcp 分派。四种目标形态各一条**逐字节**断言；
 * 另加 merge.ts 顶部「条目文本约定」的交叉校验（把渲染结果直接喂 mergeEntries 必须 ok）。
 */

const HOME_ENV: NodeJS.ProcessEnv = {};

function mcpRes(name: string, def: McpServerDef): Resource {
  return { kind: 'mcp', namespace: '', name, files: {}, payload: def };
}

const STDIO: McpServerDef = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp'],
  env: { TOKEN: 'plain-secret', REGION: 'cn' },
  timeoutMs: 30000,
};

const HTTP: McpServerDef = {
  transport: 'http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer resolved-token' },
  timeoutMs: 5000,
};

const SSE: McpServerDef = {
  transport: 'sse',
  url: 'https://example.com/sse',
  headers: { 'X-Api-Key': 'k' },
};

const POINTER_JSON = ['mcpServers'];
const POINTER_MCP = ['mcp'];
const POINTER_TOML = ['mcp_servers'];

function render(style: McpTargetStyle, pointer: string[], servers: Resource[], env: NodeJS.ProcessEnv = HOME_ENV) {
  const warnings: string[] = [];
  const entries = renderMcpEntries({ style, pointer, servers, env, toolLabel: 'Test Tool', warnings });
  return { entries, warnings };
}

// ---------------------------------------------------------------- json-mcpServers

describe('mcpfmt: json-mcpServers（Claude 兼容形）', () => {
  it('stdio：不写 type；command/args/env/timeout 逐字节', () => {
    const { entries, warnings } = render('json-mcpServers', POINTER_JSON, [mcpRes('context7', STDIO)]);
    expect(warnings).toEqual([]);
    expect(entries['context7']).toBe(
      '{"command":"npx","args":["-y","@upstash/context7-mcp"],"env":{"TOKEN":"plain-secret","REGION":"cn"},"timeout":30000}',
    );
  });

  it('http：type:"http" + url/headers/timeout 逐字节', () => {
    const { entries } = render('json-mcpServers', POINTER_JSON, [mcpRes('remote-api', HTTP)]);
    expect(entries['remote-api']).toBe(
      '{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer resolved-token"},"timeout":5000}',
    );
  });

  it('sse：type:"sse" 保留（Claude 兼容形支持）', () => {
    const { entries } = render('json-mcpServers', POINTER_JSON, [mcpRes('metrics', SSE)]);
    expect(entries['metrics']).toBe(
      '{"type":"sse","url":"https://example.com/sse","headers":{"X-Api-Key":"k"}}',
    );
  });

  it('空 args/env/headers 不落空键', () => {
    const { entries } = render('json-mcpServers', POINTER_JSON, [mcpRes('bare', { transport: 'stdio', command: 'srv' })]);
    expect(entries['bare']).toBe('{"command":"srv"}');
  });
});

// -------------------------------------------------------------------- toml-codex

describe('mcpfmt: toml-codex（[mcp_servers.<name>] + 子表）', () => {
  it('stdio：command/args + [mcp_servers.<name>.env] 子表逐字节', () => {
    const { entries, warnings } = render('toml-codex', POINTER_TOML, [mcpRes('context7', STDIO)]);
    expect(warnings).toEqual([]);
    expect(entries['context7']).toBe(
      [
        '[mcp_servers.context7]',
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp"]',
        '',
        '[mcp_servers.context7.env]',
        'TOKEN = "plain-secret"',
        'REGION = "cn"',
        '',
      ].join('\n'),
    );
  });

  it('http：url + [mcp_servers.<name>.http_headers] 子表逐字节', () => {
    const { entries } = render('toml-codex', POINTER_TOML, [mcpRes('remote-api', HTTP)]);
    expect(entries['remote-api']).toBe(
      ['[mcp_servers.remote-api]', 'url = "https://example.com/mcp"', '', '[mcp_servers.remote-api.http_headers]', 'Authorization = "Bearer resolved-token"', ''].join('\n'),
    );
  });

  it('sse：整条跳过 + 点名（含 server 名与 transport，不含 url 值）', () => {
    const { entries, warnings } = render('toml-codex', POINTER_TOML, [mcpRes('metrics', SSE)]);
    expect(entries).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"metrics"');
    expect(warnings[0]).toContain('sse');
    expect(warnings[0]).not.toContain('example.com');
  });

  it('非裸键的 env/headers 键名用字串引号包裹', () => {
    const def: McpServerDef = { transport: 'http', url: 'https://x/mcp', headers: { 'My.Header': 'v' } };
    const { entries } = render('toml-codex', POINTER_TOML, [mcpRes('dotted', def)]);
    expect(entries['dotted']).toContain("'My.Header' = \"v\"");
  });
});

// ------------------------------------------------------------------ json-opencode

describe('mcpfmt: json-opencode（mcp 键下 local/remote 形态）', () => {
  it('stdio → type:"local"，command 是含参数的数组，environment 只列变量名', () => {
    const { entries, warnings } = render('json-opencode', POINTER_MCP, [mcpRes('context7', STDIO)]);
    expect(warnings).toEqual([]);
    expect(entries['context7']).toBe(
      '{"type":"local","command":["npx","-y","@upstash/context7-mcp"],"environment":["REGION","TOKEN"]}',
    );
  });

  it('http → type:"remote" + url/headers', () => {
    const { entries } = render('json-opencode', POINTER_MCP, [mcpRes('remote-api', HTTP)]);
    expect(entries['remote-api']).toBe(
      '{"type":"remote","url":"https://example.com/mcp","headers":{"Authorization":"Bearer resolved-token"}}',
    );
  });
});

// ------------------------------------------------------------------- json-copilot

describe('mcpfmt: json-copilot（type:"local"/http/sse + 必须带 tools 允许列表）', () => {
  it('stdio → type:"local"，command 是单条命令行，且带 tools:["*"]', () => {
    const { entries, warnings } = render('json-copilot', POINTER_JSON, [mcpRes('context7', STDIO)]);
    expect(warnings).toEqual([]);
    expect(entries['context7']).toBe(
      '{"type":"local","command":"npx -y @upstash/context7-mcp","tools":["*"]}',
    );
  });

  it('含空白的参数按 shell 习惯加双引号', () => {
    const def: McpServerDef = { transport: 'stdio', command: 'docker', args: ['-c', 'hello world'] };
    const { entries } = render('json-copilot', POINTER_JSON, [mcpRes('runner', def)]);
    expect(entries['runner']).toBe('{"type":"local","command":"docker -c \\"hello world\\"","tools":["*"]}');
  });

  it('http/sse 保留 transport 类型，仍必须带 tools:["*"]', () => {
    const { entries } = render('json-copilot', POINTER_JSON, [mcpRes('remote-api', HTTP), mcpRes('metrics', SSE)]);
    expect(entries['remote-api']).toBe(
      '{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer resolved-token"},"tools":["*"]}',
    );
    expect(entries['metrics']).toBe(
      '{"type":"sse","url":"https://example.com/sse","headers":{"X-Api-Key":"k"},"tools":["*"]}',
    );
  });
});

// ------------------------------------------------- merge.ts 条目文本约定的交叉校验

describe('mcpfmt: 渲染结果满足 core/merge.ts 的条目文本约定', () => {
  it('json 条目直接喂 mergeEntries：成员已有条目与畸形键都不被动，我们的两条写入', () => {
    const { entries } = render('json-mcpServers', POINTER_JSON, [mcpRes('context7', STDIO), mcpRes('remote-api', HTTP)]);
    const current = JSON.stringify(
      {
        mcpServers: { 'user-server': { command: 'mine' }, 'mcpServers.mcpServers': {} },
        enabledPlugins: {},
      },
      null,
      2,
    );
    const outcome = mergeEntries({ format: 'json', pointer: POINTER_JSON, current, previous: {}, desired: entries });
    expect(outcome.ok).toBe(true);
    expect(outcome.written).toEqual(['context7', 'remote-api']);
    const merged = JSON.parse(outcome.text as string) as Record<string, { [k: string]: unknown }>;
    expect(Object.keys(merged.mcpServers as object).sort()).toEqual([
      'context7',
      'mcpServers.mcpServers',
      'remote-api',
      'user-server',
    ]);
    expect(merged.enabledPlugins).toEqual({});
  });

  it('toml 块直接喂 mergeEntries：成员手写表头/子表逐字节不变，我们的块追加', () => {
    const { entries } = render('toml-codex', POINTER_TOML, [mcpRes('context7', STDIO), mcpRes('remote-api', HTTP)]);
    const current = [
      'model = "gpt-5"',
      '',
      '[model_providers.foo]',
      'name = "foo"',
      '',
      '[mcp_servers.member]',
      'command = "echo"',
      '',
      '[notice]',
      'hide = true',
      '',
    ].join('\n');
    const outcome = mergeEntries({ format: 'toml', pointer: POINTER_TOML, current, previous: {}, desired: entries });
    expect(outcome.ok).toBe(true);
    expect(outcome.written).toEqual(['context7', 'remote-api']);
    const text = outcome.text as string;
    // 成员内容原样（顺序与字节都不动），我们的块落在 notice 之前
    expect(text.startsWith('model = "gpt-5"\n\n[model_providers.foo]\nname = "foo"\n\n[mcp_servers.member]\ncommand = "echo"\n')).toBe(true);
    expect(text).toContain('[mcp_servers.context7.env]\nTOKEN = "plain-secret"\nREGION = "cn"');
    expect(text).toContain('[mcp_servers.remote-api.http_headers]\nAuthorization = "Bearer resolved-token"');
    expect(text.indexOf('[notice]')).toBeGreaterThan(text.indexOf('[mcp_servers.context7]'));
  });

  it('renderMcpEntry 单条直出（不经 renderMcpEntries）与逐字节期望一致', () => {
    expect(renderMcpEntry('json-mcpServers', 'x', { transport: 'stdio', command: 'srv' }, POINTER_JSON)).toBe('{"command":"srv"}');
    expect(renderMcpEntry('toml-codex', 'x', SSE, POINTER_TOML)).toBeNull();
  });
});

// ------------------------------------------------------------------------ whichOn

describe('whichOn（requires 的 PATH 探测，POSIX 先行）', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ejdrone-which-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeBin(name: string, mode: number): string {
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(p, mode);
    return p;
  }

  it('PATH 上有可执行文件 → 返回其绝对路径', () => {
    makeBin('fake-tool', 0o755);
    expect(whichOn('fake-tool', { PATH: dir }, 'linux')).toBe(join(dir, 'fake-tool'));
  });

  it('不可执行 / 不存在 / PATH 缺席 → null', () => {
    makeBin('no-exec', 0o644);
    expect(whichOn('no-exec', { PATH: dir }, 'linux')).toBeNull();
    expect(whichOn('no-such-tool-xyz', { PATH: dir }, 'linux')).toBeNull();
    expect(whichOn('fake-tool', HOME_ENV, 'linux')).toBeNull();
  });

  it('目录同名不算可执行文件', () => {
    mkdirSync(join(dir, 'a-dir'), { recursive: true });
    expect(whichOn('a-dir', { PATH: dir }, 'linux')).toBeNull();
  });

  it('含 / 的 name 不做 PATH 拼接：绝对路径直接探测，相对路径判不存在', () => {
    const p = makeBin('abs-tool', 0o755);
    expect(whichOn(p, HOME_ENV, 'linux')).toBe(p);
    expect(whichOn('./fake', { PATH: dir }, 'linux')).toBeNull();
  });

  it('win32：走 platform 层的 PATHEXT 查找——.exe/.cmd 都认；PATH 上没有 → null', () => {
    writeFileSync(join(dir, 'fake.exe'), 'MZ', 'utf8');
    writeFileSync(join(dir, 'runner.cmd'), '@echo off', 'utf8');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' };
    expect(whichOn('fake', env, 'win32')).toBe(join(dir, 'fake.exe'));
    expect(whichOn('runner', env, 'win32')).toBe(join(dir, 'runner.cmd'));
    expect(whichOn('missing-tool', env, 'win32')).toBeNull();
  });

  it('空 name 直接 null（非法的可执行名）', () => {
    expect(whichOn('', { PATH: dir }, 'linux')).toBeNull();
  });
});

// --------------------------------------------------------------- planMcpFor 组装

describe('planMcpFor：恒发一条 + tools 过滤 + ${VAR} + requires 点名', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-planmcp-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function single(adapterId: string, servers: Resource[], env: NodeJS.ProcessEnv, warnings: string[] = []): PlannedWrite {
    // planMcpFor 的点名出口是回调（delivery 用它把消息推到 notes）；测试里收进数组再断言。
    const writes = planMcpFor(adapterId, servers, home, env, (m) => warnings.push(m));
    expect(writes).toHaveLength(1);
    return writes[0] as PlannedWrite;
  }

  it('合成 key 走 mcp:<tool>-merge 惯例（进 activeResources 的前提）', () => {
    expect(mcpMergeResourceKey('claude')).toBe('mcp:claude-merge');
    const w = single('claude', [], HOME_ENV);
    expect(w.resource).toBe('mcp:claude-merge');
  });

  it('空 server 列表也恒发一条 entries 为空的 merge write（最后一个 server 停投也能清掉）', () => {
    const w = single('codex', [], HOME_ENV);
    expect(w.merge).toEqual({ format: 'toml', pointer: ['mcp_servers'], entries: {} });
    expect(w.path).toBe(join(home, '.codex', 'config.toml'));
  });

  it('没有 mcpTarget 的工具返回空数组（dsh）', () => {
    expect(planMcpFor('dsh', [mcpRes('a', STDIO)], home, HOME_ENV)).toEqual([]);
  });

  it('Claude 的条目文本已完成 ${VAR} 解析；已解析值只在条目里，不进 warnings', () => {
    const def: McpServerDef = { transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } };
    const w = single('claude', [mcpRes('with-var', def)], { TOKEN: 's3cr3t-value' });
    const text = (w.merge as NonNullable<typeof w.merge>).entries['with-var'] as string;
    expect(text).toContain('Bearer s3cr3t-value');
    expect(text).not.toContain('${TOKEN}');
  });

  it('缺变量：整条跳过；点名含 server 名与变量名，不含任何值', () => {
    const def: McpServerDef = { transport: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${MISSING_KEY}' } };
    const warnings: string[] = [];
    const w = single('claude', [mcpRes('gpu-analysis', def)], HOME_ENV, warnings);
    expect(w.merge?.entries).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"gpu-analysis"');
    expect(warnings[0]).toContain('MISSING_KEY');
    expect(warnings[0]).not.toContain('Bearer');
  });

  it('tools: 过滤在入口统一做：别的工具点名不到我们', () => {
    const def: McpServerDef = { ...HTTP, tools: ['cursor'] };
    const claudeW = single('claude', [mcpRes('cursor-only', def)], HOME_ENV);
    expect(claudeW.merge?.entries).toEqual({});
    const cursorW = single('cursor', [mcpRes('cursor-only', def)], HOME_ENV);
    expect(Object.keys(cursorW.merge?.entries ?? {})).toEqual(['cursor-only']);
  });

  it('requires 命中：PATH 上有可执行才投递；缺失 → 跳过 + 点名（server 名 + 可执行名）', () => {
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    const def: McpServerDef = { ...STDIO, requires: ['fake-mcp-launcher'] };
    const missingEnv = { PATH: binDir };
    const warnings: string[] = [];
    const w = single('claude', [mcpRes('needs-bin', def)], missingEnv, warnings);
    expect(w.merge?.entries).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"needs-bin"');
    expect(warnings[0]).toContain('fake-mcp-launcher');

    writeFileSync(join(binDir, 'fake-mcp-launcher'), '#!/bin/sh\n', 'utf8');
    chmodSync(join(binDir, 'fake-mcp-launcher'), 0o755);
    const w2 = single('claude', [mcpRes('needs-bin', def)], missingEnv);
    expect(Object.keys(w2.merge?.entries ?? {})).toEqual(['needs-bin']);
  });

  it('codex：sse 跳过 + 点名，其余条目照常，仍然恒发一条', () => {
    const warnings: string[] = [];
    const w = single('codex', [mcpRes('metrics', SSE), mcpRes('context7', STDIO)], HOME_ENV, warnings);
    expect(Object.keys(w.merge?.entries ?? {})).toEqual(['context7']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"metrics"');
    expect(w.resource).toBe('mcp:codex-merge');
  });

  it('format/pointer 一律取自 paths.ts 的表（opencode 是 mcp 键、claude 锚 HOME）', () => {
    const oc = single('opencode', [], HOME_ENV);
    expect(oc.merge).toEqual({ format: 'json', pointer: ['mcp'], entries: {} });
    expect(oc.path).toBe(join(home, '.config', 'opencode', 'opencode.json'));
    const cl = single('claude', [], HOME_ENV);
    expect(cl.path).toBe(join(home, '.claude.json'));
  });
});
