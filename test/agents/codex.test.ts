import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codexAdapter } from '../../src/agents/codex.js';
import { planMcpFor } from '../../src/agents/common.js';
import type { McpServerDef, Resource } from '../../src/core/types.js';

/**
 * 公共套件（含 planMcp 恒发一条）由 suite.test.ts 对本注册适配器统一跑；
 * 这里只钉 codex 在 MCP 上的真差异：sse 不支持（跳过 + 点名）与 toml 条目形状。
 */

const HOME_ENV: NodeJS.ProcessEnv = {};

function mcpRes(name: string, def: McpServerDef): Resource {
  return { kind: 'mcp', namespace: '', name, files: {}, payload: def };
}

describe('codex: planMcp 特例', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-codex-mcp-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('stdio 条目渲染成 [mcp_servers.<name>] 块（env 走子表），落点与 pointer 取自表', () => {
    const writes = codexAdapter.planMcp?.(
      [mcpRes('ctx', { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'v' } })],
      home,
      HOME_ENV,
    );
    expect(writes).toHaveLength(1);
    const w = writes?.[0];
    expect(w?.path).toBe(join(home, '.codex', 'config.toml'));
    expect(w?.resource).toBe('mcp:codex-merge');
    expect(w?.merge?.format).toBe('toml');
    expect(w?.merge?.pointer).toEqual(['mcp_servers']);
    expect(w?.merge?.entries['ctx']).toBe('[mcp_servers.ctx]\ncommand = "npx"\nargs = ["-y", "pkg"]\n\n[mcp_servers.ctx.env]\nTOKEN = "v"\n');
  });

  it('sse 不支持：整条跳过 + 点名（经 warnings 通道），但恒发的那条 merge write 仍在', () => {
    const warnings: string[] = [];
    const writes = planMcpFor(
      'codex',
      [mcpRes('live-sse', { transport: 'sse', url: 'https://example.com/sse' })],
      home,
      HOME_ENV,
      (m) => warnings.push(m),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.merge?.entries).toEqual({});
    expect(writes[0]?.resource).toBe('mcp:codex-merge');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"live-sse"');
    expect(warnings[0]).not.toContain('example.com');
  });
});
