import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectMcp,
  referencesEnvVar,
  resolveMcpResources,
  resolveServerDef,
  resolveVars,
} from '../../src/core/mcp.js';
import { collectResources } from '../../src/core/resources.js';
import { resolve } from '../../src/core/plan.js';
import { emptyKinds, type Resource } from '../../src/core/types.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function tmp(): string {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-'));
  return root;
}

function file(base: string, rel: string, content = 'x'): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

const yaml = (...lines: string[]): string => `${lines.join('\n')}\n`;

const manifestWith = (...namespaces: string[]) => ({
  version: 1,
  roles: [{ id: 'r1', namespaces }],
});

/** 人类可读文本的总和：哨兵断言用它确认已解析值不外泄。 */
function humanText(parts: Array<string[] | string | null>): string {
  return parts
    .flatMap((p) => (Array.isArray(p) ? p : p === null ? [] : [p]))
    .join('\n');
}

describe('collectMcp: 合法文件', () => {
  it('解析 stdio 与 http 两条 server 为 Resource，字段原样保留', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml(
        'servers:',
        '  - name: gpu-analysis',
        '    description: GPU 存量与价格查询',
        '    transport: http',
        '    url: https://example.com/api/mcp',
        '    headers:',
        '      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}',
        '    timeout: 600000',
        '  - name: local-formatter',
        '    transport: stdio',
        '    command: npx',
        "    args: ['-y', '@acme/formatter-mcp']",
        '    env: { FORMATTER_MODE: strict }',
        '    requires: [npx]',
        '    tools: [claude, cursor]',
      ),
    );
    const res = collectMcp(base, new Set());
    expect(res).toEqual({
      servers: [
        {
          kind: 'mcp',
          namespace: '',
          name: 'gpu-analysis',
          files: {},
          payload: {
            transport: 'http',
            description: 'GPU 存量与价格查询',
            url: 'https://example.com/api/mcp',
            headers: { Authorization: 'Bearer ${GPU_ANALYSIS_TOKEN}' },
            timeoutMs: 600000,
          },
        },
        {
          kind: 'mcp',
          namespace: '',
          name: 'local-formatter',
          files: {},
          payload: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@acme/formatter-mcp'],
            env: { FORMATTER_MODE: 'strict' },
            requires: ['npx'],
            tools: ['claude', 'cursor'],
          },
        },
      ],
      warnings: [],
      fileError: null,
    });
  });

  it('servers: [] 是合法的零条目，不是文件级失败', () => {
    const base = tmp();
    file(base, 'mcp/mcp.yaml', yaml('servers: []'));
    expect(collectMcp(base, new Set())).toEqual({ servers: [], warnings: [], fileError: null });
  });

  it('mcp/ 目录缺席 = 空集，零告警', () => {
    const base = tmp();
    expect(collectMcp(base, new Set())).toEqual({ servers: [], warnings: [], fileError: null });
  });

  it('只读 manifest 声明的 ns 目录，未声明的点名跳过且不解析', () => {
    const base = tmp();
    file(base, 'mcp/fe/mcp.yaml', yaml('servers:', '  - name: fe-mcp', '    transport: stdio', '    command: a'));
    // ghost 里的坏 YAML 若被解析就会停发整个 kind —— 未声明的 ns 不该有这种威力
    file(base, 'mcp/ghost/mcp.yaml', yaml('server:', '  - name: x'));
    const res = collectMcp(base, new Set(['fe']));
    expect(res.servers.map((s) => `${s.namespace}/${s.name}`)).toEqual(['fe/fe-mcp']);
    expect(res.fileError).toBeNull();
    expect(res.warnings).toEqual(['mcp/ghost is not a declared namespace; skipped']);
  });
});

describe('collectMcp: 文件级失败（整体停发，不能当成空集）', () => {
  it('坏 YAML → fileError 点名文件，servers 为空', () => {
    const base = tmp();
    file(base, 'mcp/mcp.yaml', 'servers: [\n');
    const res = collectMcp(base, new Set());
    expect(res.servers).toEqual([]);
    expect(res.fileError).toContain('Invalid YAML');
    expect(res.fileError).toContain('mcp.yaml');
  });

  it('顶层把 servers: 拼成 server: → fileError 同时点名两个 key', () => {
    const base = tmp();
    file(base, 'mcp/mcp.yaml', yaml('server:', '  - name: gpu', '    transport: stdio', '    command: npx'));
    const res = collectMcp(base, new Set());
    expect(res.servers).toEqual([]);
    expect(res.fileError).toContain('missing "servers:" key');
    expect(res.fileError).toContain('server');
  });

  it('servers: 键在但值空（YAML null）也是文件级失败，不是"团队删光了"', () => {
    const base = tmp();
    file(base, 'mcp/mcp.yaml', 'servers:\n');
    const res = collectMcp(base, new Set());
    expect(res.servers).toEqual([]);
    expect(res.fileError).toContain('"servers" must be a list');
  });

  it('同一文件内重名 → 文件级失败（选哪条都是猜）', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml(
        'servers:',
        '  - name: dup',
        '    transport: stdio',
        '    command: a',
        '  - name: dup',
        '    transport: stdio',
        '    command: b',
      ),
    );
    const res = collectMcp(base, new Set());
    expect(res.servers).toEqual([]);
    expect(res.fileError).toContain('duplicate server name(s): "dup"');
  });

  it('ns 文件的失败同样进 fileError，并带相对路径定位', () => {
    const base = tmp();
    file(base, 'mcp/fe/mcp.yaml', 'servers: [\n');
    const res = collectMcp(base, new Set(['fe']));
    expect(res.fileError).toContain('Invalid YAML');
    expect(res.servers).toEqual([]);
  });
});

describe('collectMcp: 条目级失败（跳过该条并点名）', () => {
  it('timeout 是唯一拼法：写成 timeoutMs 的条目被点名跳过，不会两种都收', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml(
        'servers:',
        '  - name: good',
        '    transport: stdio',
        '    command: npx',
        '    timeout: 600000',
        '  - name: typo',
        '    transport: stdio',
        '    command: npx',
        '    timeoutMs: 600000',
      ),
    );
    const res = collectMcp(base, new Set());
    expect(res.fileError).toBeNull();
    expect(res.servers.map((s) => s.name)).toEqual(['good']);
    expect(res.warnings[0]).toContain('timeoutMs');
    expect(res.servers[0]?.payload?.timeoutMs).toBe(600000);
  });

  it('server 条目里的未知 key 逐个点名文件与 key，其余条目照常', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml(
        'servers:',
        '  - name: gpu',
        '    transport: stdio',
        '    command: npx',
        '    roles: [dev]',
        '  - name: ok',
        '    transport: stdio',
        '    command: y',
      ),
    );
    const res = collectMcp(base, new Set());
    expect(res.fileError).toBeNull();
    expect(res.servers.map((s) => s.name)).toEqual(['ok']);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('mcp/mcp.yaml');
    expect(res.warnings[0]).toContain('"gpu"');
    expect(res.warnings[0]).toContain('roles');
  });

  it('transport 缺对应字段时跳过该条并点名 url/command', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml(
        'servers:',
        '  - name: remote',
        '    transport: http',
        '  - name: local',
        '    transport: stdio',
      ),
    );
    const res = collectMcp(base, new Set());
    expect(res.servers).toEqual([]);
    expect(res.fileError).toBeNull();
    expect(humanText(res.warnings)).toContain('url');
    expect(humanText(res.warnings)).toContain('command');
  });
});

describe('collectMcp: namespace 覆盖语义（裁决归 resolve）', () => {
  it('采集保留根与 ns 两条同名条目，resolve 后 ns 条目整体替换根条目', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml('servers:', '  - name: formatter', '    transport: stdio', '    command: npx', '    args: [--mode, loose]'),
    );
    file(
      base,
      'mcp/fe/mcp.yaml',
      yaml('servers:', '  - name: formatter', '    description: 前端专用', '    transport: http', '    url: https://fe.example/mcp'),
    );
    const res = collectMcp(base, new Set(['fe']));
    expect(res.servers.map((s) => `${s.namespace || '<root>'}/${s.name}`)).toEqual([
      '<root>/formatter',
      'fe/formatter',
    ]);

    const kinds = emptyKinds();
    kinds.mcp = res.servers;
    const resolution = resolve({ kinds, activeNamespaces: ['fe'] });
    expect(resolution.haltedKinds).toEqual([]);
    // 整体替换：command/args 不合并进来，payload 就是 ns 文件那一条
    expect(resolution.kinds.mcp).toEqual([
      {
        kind: 'mcp',
        namespace: 'fe',
        name: 'formatter',
        files: {},
        payload: {
          transport: 'http',
          description: '前端专用',
          url: 'https://fe.example/mcp',
        },
      },
    ]);
  });

  it('两个激活 ns 定义同名 server → 采集层照单全收，冲突交给裁决', () => {
    const base = tmp();
    file(base, 'mcp/fe/mcp.yaml', yaml('servers:', '  - name: shared', '    transport: stdio', '    command: a'));
    file(base, 'mcp/be/mcp.yaml', yaml('servers:', '  - name: shared', '    transport: stdio', '    command: b'));
    const res = collectMcp(base, new Set(['fe', 'be']));
    expect(res).toEqual({
      servers: [
        { kind: 'mcp', namespace: 'be', name: 'shared', files: {}, payload: { transport: 'stdio', command: 'b' } },
        { kind: 'mcp', namespace: 'fe', name: 'shared', files: {}, payload: { transport: 'stdio', command: 'a' } },
      ],
      warnings: [],
      fileError: null,
    });
  });
});

describe('resolveVars / resolveServerDef', () => {
  it('${VAR} 只从注入的 env 取值；缺失变量保留占位符并收进 missing', () => {
    expect(resolveVars('Bearer ${TOKEN}', { TOKEN: 'abc' })).toEqual({ value: 'Bearer abc', missing: [] });
    expect(resolveVars('${A}-${B}-${A}', { A: '1' })).toEqual({ value: '1-${B}-1', missing: ['B'] });
    expect(resolveVars('no vars here', {})).toEqual({ value: 'no vars here', missing: [] });
  });

  it('替换值原样写入，不做二次展开', () => {
    expect(resolveVars('${A}', { A: '${B}', B: 'x' })).toEqual({ value: '${B}', missing: [] });
  });

  it('resolveServerDef 把 payload 的每个字符串字段都过一遍', () => {
    const res = resolveServerDef(
      {
        transport: 'stdio',
        description: '${DESC}',
        command: '${BIN}',
        args: ['--token', '${TOKEN}'],
        env: { FORMATTER_MODE: '${MODE}' },
        requires: ['${BIN}'],
        tools: ['claude'],
        timeoutMs: 5000,
      },
      { DESC: 'd', BIN: 'npx', TOKEN: 'SENTINEL_SECRET', MODE: 'strict' },
    );
    expect(res.missing).toEqual([]);
    expect(res.resolved).toEqual({
      transport: 'stdio',
      description: 'd',
      command: 'npx',
      args: ['--token', 'SENTINEL_SECRET'],
      env: { FORMATTER_MODE: 'strict' },
      requires: ['npx'],
      tools: ['claude'],
      timeoutMs: 5000,
    });
  });

  it('缺变量时 missing 收名，resolved 里保留占位符（消费方必须整条丢弃）', () => {
    const res = resolveServerDef(
      { transport: 'http', url: 'https://example.com/${PATH}/mcp' },
      { OTHER: 'x' },
    );
    expect(res.missing).toEqual(['PATH']);
    expect(res.resolved.url).toBe('https://example.com/${PATH}/mcp');
  });
});

describe('resolveMcpResources: 缺变量的整条 server 跳过并点名', () => {
  const gpu: Resource = {
    kind: 'mcp',
    namespace: '',
    name: 'gpu-analysis',
    files: {},
    payload: {
      transport: 'http',
      url: 'https://example.com/api/mcp',
      headers: { Authorization: 'Bearer ${GPU_ANALYSIS_TOKEN}' },
    },
  };
  const formatter: Resource = {
    kind: 'mcp',
    namespace: '',
    name: 'local-formatter',
    files: {},
    payload: { transport: 'stdio', command: 'npx', env: { FORMATTER_MODE: '${FORMATTER_MODE}' } },
  };

  it('已解析值出现在 payload 里，但绝不进任何人类可读文本（哨兵）', () => {
    const res = resolveMcpResources([gpu, formatter], { FORMATTER_MODE: 'SENTINEL_SECRET' });
    expect(res.servers).toEqual([
      {
        ...formatter,
        payload: { transport: 'stdio', command: 'npx', env: { FORMATTER_MODE: 'SENTINEL_SECRET' } },
      },
    ]);
    expect(res.skipped).toEqual([{ name: 'gpu-analysis', missing: ['GPU_ANALYSIS_TOKEN'] }]);
    // skipped 只含变量名；把它拼给人看的点名文案，也不会有值
    const skippedText = res.skipped.map((s) => `${s.name}: missing ${s.missing.join(', ')}`).join('\n');
    expect(skippedText).not.toContain('SENTINEL_SECRET');
    expect(humanText([res.skipped.flatMap((s) => [s.name, s.missing])])).not.toContain('SENTINEL_SECRET');
  });

  it('变量齐全时按原顺序全部通过', () => {
    const res = resolveMcpResources([gpu, formatter], {
      GPU_ANALYSIS_TOKEN: 'SENTINEL_SECRET',
      FORMATTER_MODE: 'strict',
    });
    expect(res.skipped).toEqual([]);
    expect(res.servers[0]?.payload?.headers?.Authorization).toBe('Bearer SENTINEL_SECRET');
    expect(res.servers[1]?.payload?.env?.FORMATTER_MODE).toBe('strict');
  });

  it('collectMcp 全程不接触 env：warnings/fileError 里连占位符值都不可能出现', () => {
    const base = tmp();
    file(
      base,
      'mcp/mcp.yaml',
      yaml(
        'servers:',
        '  - name: gpu',
        '    transport: http',
        '    url: https://example.com/${MISSING_PATH}/mcp',
        '  - name: broken',
        '    transport: stdio',
        '    roles: [dev]',
      ),
    );
    const collected = collectMcp(base, new Set());
    expect(collected.servers.map((s) => s.name)).toEqual(['gpu']);
    const text = humanText([collected.warnings, collected.fileError]);
    expect(text).not.toContain('SENTINEL_SECRET');
    const resolved = resolveMcpResources(collected.servers, {});
    expect(resolved.skipped).toEqual([{ name: 'gpu', missing: ['MISSING_PATH'] }]);
    expect(humanText([resolved.skipped.map((s) => `${s.name} ${s.missing.join(' ')}`)])).not.toContain(
      'SENTINEL_SECRET',
    );
  });
});

describe('collectResources 接线', () => {
  it('kinds.mcp 被填上，其他 kind 不受影响', () => {
    const base = tmp();
    file(base, 'skills/team-a/SKILL.md', '# A');
    file(base, 'rules/r.md', '# rule');
    file(base, 'mcp/mcp.yaml', yaml('servers:', '  - name: gpu', '    transport: stdio', '    command: npx'));
    const res = collectResources(base, null);
    expect(res.mcpFileError).toBeNull();
    expect(res.warnings).toEqual([]);
    expect(res.kinds.skills.map((r) => r.name)).toEqual(['team-a']);
    expect(res.kinds.rules.map((r) => r.name)).toEqual(['r']);
    expect(res.kinds.mcp.map((r) => r.name)).toEqual(['gpu']);
  });

  it('mcp 文件级失败只波及 mcp：mcpFileError 非空、kinds.mcp 空、skills/rules 照常', () => {
    const base = tmp();
    file(base, 'rules/r.md', '# rule');
    file(base, 'mcp/mcp.yaml', yaml('server:', '  - name: gpu'));
    const res = collectResources(base, null);
    expect(res.kinds.mcp).toEqual([]);
    expect(res.kinds.rules.map((r) => r.name)).toEqual(['r']);
    expect(res.mcpFileError).toContain('missing "servers:" key');
  });

  it('mcp 采集遵循 manifest 声明的 namespace 集合', () => {
    const base = tmp();
    file(base, 'mcp/fe/mcp.yaml', yaml('servers:', '  - name: fe-mcp', '    transport: stdio', '    command: a'));
    const declared = collectResources(base, manifestWith('fe'));
    expect(declared.kinds.mcp.map((r) => `${r.namespace}/${r.name}`)).toEqual(['fe/fe-mcp']);
    const undeclared = collectResources(base, manifestWith('qa'));
    expect(undeclared.kinds.mcp).toEqual([]);
    expect(undeclared.warnings).toEqual(['mcp/fe is not a declared namespace; skipped']);
    expect(undeclared.mcpFileError).toBeNull();
  });
});

describe('referencesEnvVar：哪些条目算"含已解析值"', () => {
  it('url / headers / env / args 里的 ${VAR} 都认；连续调用不得因全局正则漏判', () => {
    const withHeader = { transport: 'http', url: 'https://x', headers: { Authorization: 'Bearer ${T}' } } as const;
    const plain = { transport: 'stdio', command: 'npx', args: ['-y', 'p'] } as const;
    for (let i = 0; i < 3; i += 1) {
      expect(referencesEnvVar(withHeader)).toBe(true);
      expect(referencesEnvVar(plain)).toBe(false);
      expect(referencesEnvVar({ transport: 'stdio', command: 'run', env: { K: '${V}' } } as never)).toBe(true);
      expect(referencesEnvVar({ transport: 'stdio', command: 'run ${BIN}' } as never)).toBe(true);
    }
  });
});
