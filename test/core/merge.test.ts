import { describe, expect, it } from 'vitest';
import { currentEntryHashes, mergeEntries } from '../../src/core/merge.js';
import type { MergeInput } from '../../src/core/merge.js';

// ---------------------------------------------------------------- JSON 夹具

/** ~/.claude.json 的真实形状：成员状态键 + mcpServers 里的成员条目 + 别家工具整对象合并留下的畸形键。 */
function claudeFile(): string {
  return `${JSON.stringify(
    {
      userID: 'user-1',
      tipsHistory: ['tip-a', 'tip-b'],
      cachedGrowthBookFeatures: { 'flag-a': true, 'flag-b': 1.25 },
      mcpServers: {
        mcpServers: { command: 'scar-other-tool' },
        personal: { command: 'mine', args: ['--fast'] },
      },
      projects: { '/repo': { allowedTools: [] } },
    },
    null,
    2,
  )}\n`;
}

const jsonInput = (over: Partial<MergeInput>): MergeInput => ({
  format: 'json',
  pointer: ['mcpServers'],
  current: null,
  previous: {},
  desired: {},
  ...over,
});

// ---------------------------------------------------------------- TOML 夹具

/** ~/.codex/config.toml 的真实形状：成员手写表 + [mcp_servers.mcpServers] 伤疤 + 引号键。 */
const MEMBER_TOML = [
  '# member top comment',
  'model = "gpt-5"',
  '',
  '[features]',
  'shell_tool = true  # inline comment',
  '',
  '[model_providers.openai]',
  'name = "OpenAI"',
  'base_url = "https://example.internal/v1"',
  '',
  '[mcp_servers.mcpServers]',
  'url = "https://scar.example"',
  '',
  '[notice.model_migrations]',
  '"gpt-3.5" = "gpt-4"',
  '',
].join('\n');

const tomlInput = (over: Partial<MergeInput>): MergeInput => ({
  format: 'toml',
  pointer: ['mcp_servers'],
  current: null,
  previous: {},
  desired: {},
  ...over,
});

const tomlBlock = (key: string, body: string): string => `[mcp_servers.${key}]\n${body}`;

// ---------------------------------------------------------------- 六条规则：JSON

describe('mergeEntries json', () => {
  it('规则 1/5：新建文件只含我们的条目；delivered 是下次 previous 的唯一来源', () => {
    const desired = {
      firecrawl: '{"command":"npx","args":["-y","firecrawl-mcp"]}',
      deepwiki: '{"url":"https://mcp.deepwiki.com/mcp"}',
    };
    const r1 = mergeEntries(jsonInput({ desired }));
    expect(r1.ok).toBe(true);
    expect(r1.changed).toBe(true);
    expect(r1.written).toEqual(['firecrawl', 'deepwiki']);
    const doc = JSON.parse(r1.text as string) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['mcpServers']); // 新建内容只有我们
    expect(doc.mcpServers).toEqual({
      firecrawl: { command: 'npx', args: ['-y', 'firecrawl-mcp'] },
      deepwiki: { url: 'https://mcp.deepwiki.com/mcp' },
    });
    expect(r1.text?.endsWith('\n')).toBe(true);
    expect(Object.keys(r1.delivered ?? {})).toEqual(['firecrawl', 'deepwiki']);

    // 第二次同样投递：previous 换成上次的 delivered —— 无增删改，逐字节不动。
    const r2 = mergeEntries(jsonInput({ current: r1.text ?? null, previous: r1.delivered ?? {}, desired }));
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false);
    expect(r2.text).toBe(r1.text);
    expect(r2.removed).toEqual([]);
    expect(r2.kept).toEqual([]);
    expect(r2.delivered).toEqual(r1.delivered);
  });

  it('规则 2：与上次投递相符 → 覆写；键序/缩进抖动不算"成员改过"', () => {
    const deliveredText = '{"command":"npx","args":["-y","firecrawl-mcp"]}';
    const r1 = mergeEntries(jsonInput({ desired: { ours: deliveredText } }));

    // 成员的工具把同一条目重新序列化：键序颠倒、缩进变 4 空格 —— 规范化后仍是同一份。
    const jittered = `${JSON.stringify(
      { mcpServers: { ours: { args: ['-y', 'firecrawl-mcp'], command: 'npx' } }, userID: 'user-1' },
      null,
      4,
    )}\n`;
    const updated = '{"command":"npx","args":["-y","firecrawl-mcp","--new"]}';
    const r = mergeEntries(jsonInput({ current: jittered, previous: r1.delivered ?? {}, desired: { ours: updated } }));
    expect(r.ok).toBe(true);
    expect(r.kept).toEqual([]); // 抖动没有被误判
    expect(r.written).toEqual(['ours']);
    const doc = JSON.parse(r.text as string) as { mcpServers: Record<string, unknown>; userID: string };
    expect(doc.mcpServers.ours).toEqual(JSON.parse(updated));
    expect(doc.userID).toBe('user-1'); // pointer 层之外照常保留
  });

  it('规则 2：条目与上次投递不相符（成员改过值）→ kept(modified-locally)，不动、继续记账', () => {
    const r1 = mergeEntries(
      jsonInput({ current: claudeFile(), desired: { ours: '{"command":"ORIGINAL"}' } }),
    );
    expect(r1.written).toEqual(['ours']);
    const memberEdited = (r1.text as string).replace('ORIGINAL', 'EDITED-BY-MEMBER');
    const r = mergeEntries(
      jsonInput({
        current: memberEdited,
        previous: r1.delivered ?? {},
        desired: { ours: '{"command":"NEW-TEAM-VERSION"}' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.kept).toEqual([{ key: 'ours', reason: 'modified-locally' }]);
    expect(r.written).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.text).toBeUndefined(); // 只有 kept：整份文件一个字都不重写
    expect(r.delivered).toEqual({ ours: (r1.delivered as Record<string, string>).ours }); // 旧哈希继续追踪
  });

  it('规则 3：本次不再投、成员没改 → 删除该条目；成员条目与其余顶层键原样、不重排', () => {
    const r1 = mergeEntries(
      jsonInput({
        current: claudeFile(),
        desired: { alpha: '{"command":"a"}', beta: '{"command":"b"}' },
      }),
    );
    const r = mergeEntries(
      jsonInput({
        current: r1.text ?? null,
        previous: r1.delivered ?? {},
        desired: { beta: '{"command":"b"}' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(['alpha']);
    expect(r.written).toEqual(['beta']);
    const doc = JSON.parse(r.text as string) as {
      userID: string;
      mcpServers: Record<string, unknown>;
      projects: unknown;
    };
    expect('alpha' in doc.mcpServers).toBe(false);
    // 规则 4：两次都没出现的键 —— 永不触碰、永不重排
    expect(Object.keys(doc.mcpServers)).toEqual(['mcpServers', 'personal', 'beta']);
    expect(doc.mcpServers.personal).toEqual({ command: 'mine', args: ['--fast'] });
    expect(doc.mcpServers.mcpServers).toEqual({ command: 'scar-other-tool' });
    expect(doc.userID).toBe('user-1');
    expect(doc.projects).toEqual({ '/repo': { allowedTools: [] } });
    expect(Object.keys(doc)).toEqual([
      'userID',
      'tipsHistory',
      'cachedGrowthBookFeatures',
      'mcpServers',
      'projects',
    ]);
  });

  it('规则 3：本次不再投、但成员改过 → kept，条目留在文件里', () => {
    const r1 = mergeEntries(jsonInput({ current: claudeFile(), desired: { alpha: '{"command":"a"}' } }));
    const memberEdited = (r1.text as string).replace('"command": "a"', '"command": "MEMBER-TWEAK"');
    const r = mergeEntries(jsonInput({ current: memberEdited, previous: r1.delivered ?? {}, desired: {} }));
    expect(r.kept).toEqual([{ key: 'alpha', reason: 'modified-locally' }]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.text).toBeUndefined();
    expect(r.delivered).toEqual({ alpha: (r1.delivered as Record<string, string>).alpha });
  });

  it('规则 4/6：desired 的键在文件里已有同名成员条目且账本不认 → kept(foreign-entry)，不覆盖', () => {
    const current = claudeFile();
    const r = mergeEntries(jsonInput({ current, desired: { personal: '{"command":"TEAM-VERSION"}' } }));
    expect(r.ok).toBe(true);
    expect(r.kept).toEqual([{ key: 'personal', reason: 'foreign-entry' }]);
    expect(r.changed).toBe(false);
    expect(r.text).toBeUndefined();
    expect(r.delivered).toEqual({}); // 不是我们的键，绝不记账

    // force 口子：apply 层目前不设置；显式 force 才覆盖成员条目。
    const forced = mergeEntries(
      jsonInput({ current, desired: { personal: '{"command":"TEAM-VERSION"}' }, force: true }),
    );
    expect(forced.written).toEqual(['personal']);
    expect((JSON.parse(forced.text as string).mcpServers as Record<string, unknown>).personal).toEqual({
      command: 'TEAM-VERSION',
    });
  });

  it('规则 5：解析失败 / 结构对不上 → ok:false 且无 text；错误文案不含文件内容', () => {
    const corrupt = '{"userID":"u","mcpServers":{ LEAK-CANARY-VALUE }';
    const r = mergeEntries(jsonInput({ current: corrupt, desired: { x: '{"command":"x"}' } }));
    expect(r.ok).toBe(false);
    expect(r.text).toBeUndefined();
    expect(r.error).toContain('not valid JSON');
    expect(r.error).not.toContain('LEAK-CANARY-VALUE'); // 已解析值永不进错误信息

    const some = { desired: { x: '{}' } };
    expect(mergeEntries(jsonInput({ ...some, current: '[1,2,3]' })).ok).toBe(false); // 根不是对象
    expect(mergeEntries(jsonInput({ ...some, current: '{"mcpServers":"a string"}' })).ok).toBe(false); // 条目层不是对象
    expect(mergeEntries(jsonInput({ ...some, current: '{"plugins":5}', pointer: ['plugins', 'mcp'] })).ok).toBe(
      false,
    ); // pointer 中间段不是对象
    expect(mergeEntries(jsonInput({ ...some, current: claudeFile(), desired: { x: 'not json' } })).ok).toBe(false); // desired 文本解析失败
    expect(mergeEntries(jsonInput({ pointer: [], desired: { x: '{}' } })).ok).toBe(false); // 空 pointer
  });

  it('规则 5：文件不存在 + 多级 pointer → 逐层建出来；desired/previous 全空时不建层不产出 text', () => {
    const r = mergeEntries(jsonInput({ pointer: ['plugins', 'mcp'], desired: { s: '{"command":"s"}' } }));
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text as string)).toEqual({ plugins: { mcp: { s: { command: 's' } } } });

    const idle = mergeEntries(jsonInput({ pointer: ['plugins', 'mcp'] }));
    expect(idle.ok).toBe(true);
    expect(idle.changed).toBe(false);
    expect(idle.text).toBeUndefined();
  });

  it('上次投递的键已从文件里消失（成员整条删了）→ 只忘账，不报错、不重建', () => {
    const r1 = mergeEntries(
      jsonInput({ desired: { gone: '{"command":"g"}', stay: '{"command":"s"}' } }),
    );
    const r = mergeEntries(
      jsonInput({
        current: claudeFile(),
        previous: r1.delivered ?? {},
        desired: { stay: '{"command":"s"}' },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual([]); // 没东西可删
    expect(r.written).toEqual(['stay']);
  });

  it('desired 键带点也允许（JSON 键无裸名限制，TOML 才限制）', () => {
    const r = mergeEntries(jsonInput({ current: null, desired: { 'a.b': '{"command":"dotted"}' } }));
    expect(r.ok).toBe(true);
    expect((JSON.parse(r.text as string).mcpServers as Record<string, unknown>)['a.b']).toEqual({
      command: 'dotted',
    });
  });
});

// ---------------------------------------------------------------- 六条规则：TOML

describe('mergeEntries toml', () => {
  it('规则 1/2/5：新建 → 覆写 → 幂等回环，逐字节稳定', () => {
    const desired = {
      alpha: tomlBlock('alpha', 'command = "npx"\nargs = ["-y", "alpha-pkg"]\n'),
      beta: tomlBlock('beta', 'url = "https://beta.example"\n\n[mcp_servers.beta.headers]\nAuthorization = "Bearer LEAK-CANARY"\n'),
    };
    const r1 = mergeEntries(tomlInput({ desired }));
    expect(r1.ok).toBe(true);
    expect(r1.changed).toBe(true);
    expect(r1.written).toEqual(['alpha', 'beta']);
    expect(r1.text).toBe(
      '[mcp_servers.alpha]\ncommand = "npx"\nargs = ["-y", "alpha-pkg"]\n' +
        '\n' +
        '[mcp_servers.beta]\nurl = "https://beta.example"\n\n[mcp_servers.beta.headers]\nAuthorization = "Bearer LEAK-CANARY"\n',
    );

    const r2 = mergeEntries(tomlInput({ current: r1.text ?? null, previous: r1.delivered ?? {}, desired }));
    expect(r2.changed).toBe(false); // 覆写回原文 → 逐字节一致
    expect(r2.text).toBe(r1.text);
  });

  it('规则 2：覆写我们的块，块外成员字节逐行不变（注释、表序、引号键都保留）', () => {
    const r1 = mergeEntries(
      tomlInput({ current: MEMBER_TOML, desired: { ours: tomlBlock('ours', 'command = "npx"\n') } }),
    );
    expect(r1.ok).toBe(true);
    expect(r1.written).toEqual(['ours']);

    const r2 = mergeEntries(
      tomlInput({
        current: r1.text ?? null,
        previous: r1.delivered ?? {},
        desired: { ours: tomlBlock('ours', 'command = "node"\nargs = ["server.js"]\n') },
      }),
    );
    expect(r2.changed).toBe(true);
    const before = MEMBER_TOML.split('\n');
    const after = (r2.text ?? '').split('\n');
    // 我们的块插在 [mcp_servers.mcpServers] 之后、[notice.model_migrations] 之前；
    // 插入点之前与之后（从 notice 起）的每一个成员字节行都原样。
    const cutBefore = before.indexOf('[notice.model_migrations]');
    for (let i = 0; i < cutBefore; i += 1) expect(after[i]).toBe(before[i]);
    const afterCut = after.indexOf('[notice.model_migrations]');
    for (let i = 0; i < before.length - cutBefore; i += 1) {
      expect(after[afterCut + i]).toBe(before[cutBefore + i]);
    }
    expect(r2.text).toContain('# member top comment');
    expect(r2.text).toContain('shell_tool = true  # inline comment');
    expect(r2.text).toContain('"gpt-3.5" = "gpt-4"');
    expect(r2.text).toContain('args = ["server.js"]');
  });

  it('规则 2：块原文逐字节 —— 成员在我们块里加个尾注 → kept(modified-locally)', () => {
    const r1 = mergeEntries(
      tomlInput({ current: MEMBER_TOML, desired: { ours: tomlBlock('ours', 'command = "npx"\n') } }),
    );
    const memberEdited = (r1.text ?? '').replace('command = "npx"', 'command = "npx"  # 成员加了注');
    const r = mergeEntries(
      tomlInput({
        current: memberEdited,
        previous: r1.delivered ?? {},
        desired: { ours: tomlBlock('ours', 'command = "node"\n') },
      }),
    );
    expect(r.kept).toEqual([{ key: 'ours', reason: 'modified-locally' }]);
    expect(r.changed).toBe(false);
    expect(r.text).toBeUndefined();
  });

  it('规则 3：本次不再投 → 整块删除（含子表）；成员块不动、不叠空行', () => {
    const r1 = mergeEntries(
      tomlInput({
        current: MEMBER_TOML,
        desired: {
          ours: tomlBlock('ours', 'command = "npx"\n'),
          zap: tomlBlock('zap', 'url = "https://z"\n\n[mcp_servers.zap.env]\nTOKEN = "t"\n'),
        },
      }),
    );
    const r = mergeEntries(
      tomlInput({
        current: r1.text ?? null,
        previous: r1.delivered ?? {},
        desired: { ours: tomlBlock('ours', 'command = "npx"\n') },
      }),
    );
    expect(r.removed).toEqual(['zap']);
    expect(r.text).not.toContain('[mcp_servers.zap]');
    expect(r.text).not.toContain('[mcp_servers.zap.env]');
    expect(r.text).not.toContain('TOKEN');
    expect(r.text).toContain('[mcp_servers.ours]');
    expect(r.text).not.toMatch(/\n\n\n/);
  });

  it('规则 3：本次不再投但成员改过 → kept；账本键已从文件消失 → 只忘账', () => {
    const r1 = mergeEntries(tomlInput({ desired: { ours: tomlBlock('ours', 'command = "npx"\n') } }));
    const memberEdited = r1.text!.replace('command = "npx"', 'command = "member-own"');
    const kept = mergeEntries(tomlInput({ current: memberEdited, previous: r1.delivered ?? {}, desired: {} }));
    expect(kept.kept).toEqual([{ key: 'ours', reason: 'modified-locally' }]);
    expect(kept.text).toBeUndefined();

    const forgotten = mergeEntries(tomlInput({ current: MEMBER_TOML, previous: r1.delivered ?? {}, desired: {} }));
    expect(forgotten.ok).toBe(true);
    expect(forgotten.changed).toBe(false);
    expect(forgotten.removed).toEqual([]);
    expect(forgotten.delivered).toEqual({});
  });

  it('规则 6：同名成员块（账本没有、文件已有）→ foreign-entry 不覆盖；force 才动', () => {
    const desired = { mcpServers: tomlBlock('mcpServers', 'command = "team"\n') };
    const r = mergeEntries(tomlInput({ current: MEMBER_TOML, desired }));
    expect(r.kept).toEqual([{ key: 'mcpServers', reason: 'foreign-entry' }]);
    expect(r.changed).toBe(false);
    expect(r.text).toBeUndefined();
    expect(r.delivered).toEqual({});

    const forced = mergeEntries(tomlInput({ current: MEMBER_TOML, desired, force: true }));
    expect(forced.written).toEqual(['mcpServers']);
    expect(forced.text).toContain('[mcp_servers.mcpServers]\ncommand = "team"\n');
  });

  it('插入位置与空行：紧跟最后一个前缀块之后，前后各一个空行，不叠加', () => {
    const r = mergeEntries(
      tomlInput({ current: MEMBER_TOML, desired: { ours: tomlBlock('ours', 'command = "npx"\n') } }),
    );
    expect(r.text).toContain(
      '[mcp_servers.mcpServers]\nurl = "https://scar.example"\n\n[mcp_servers.ours]\ncommand = "npx"\n\n[notice.model_migrations]',
    );
  });

  it('规则 5：异形 TOML 一律 ok:false 且无 text —— [[ 数组表 / 前缀内联表 / 前缀表直写键 / 根级点键 / 引号或括号不平衡 / 认不出的表头 / 游离行 / 重复表 / 游离子表', () => {
    const shapes: Array<[string, string]> = [
      ['array-of-tables', 'model = "gpt-5"\n[[tests]]\nname = "x"\n'],
      ['inline prefix table', 'mcp_servers = { alpha = { command = "LEAK-CANARY" } }\n'],
      ['plain key under prefix', '[mcp_servers]\nalpha = { command = "LEAK-CANARY" }\n'],
      ['assignment under prefix', '[mcp_servers]\ncommand = "LEAK-CANARY"\n'],
      ['root dotted key', 'mcp_servers.alpha.command = "LEAK-CANARY"\n'],
      ['unbalanced quotes', 'description = "unclosed LEAK-CANARY\n'],
      ['multiline array', 'args = [\n "-y",\n "LEAK-CANARY"\n]\n'],
      ['unknown header', '[mcp_servers."weird \\" key"]\ncommand = "x"\n'],
      ['not header not assign', 'random noise LEAK-CANARY\n'],
      ['duplicate table', '[features]\na = 1\n[features]\nb = 2\n'],
      ['duplicate entry table', '[mcp_servers.d]\nc = "1"\n[mcp_servers.d]\nc = "2"\n'],
      ['subtable without parent', '[mcp_servers.d.env]\nA = "1"\n'],
    ];
    for (const [name, current] of shapes) {
      const r = mergeEntries(
        tomlInput({ current, previous: {}, desired: { ours: tomlBlock('ours', 'command = "npx"\n') } }),
      );
      expect(r.ok, name).toBe(false);
      expect(r.text, name).toBeUndefined();
      expect(typeof r.error, name).toBe('string');
      if (r.error) expect(r.error, `${name} 的报错不得带值`).not.toContain('LEAK-CANARY');
    }
  });

  it('desired 块自校验：表头必须正好是 [前缀.key]，块内表头只能是它的子表', () => {
    const cases: Array<Record<string, string>> = [
      { x: '[mcp_servers.other]\ncommand = "c"\n' }, // 表头与 key 不符
      { x: '[mcp_servers.x]\ncommand = "c"\n[other]\nk = 1\n' }, // 块内混入别家的表
      { x: '[mcp_servers.x]\ncommand = "c"\n[[mcp_servers.x.jobs]]\nk = 1\n' }, // 数组表
      { x: '# 注释先于表头\n[mcp_servers.x]\ncommand = "c"\n' }, // 首个非空行不是表头
      { x: '[mcp_servers.x]\ncommand = "unclosed\n' }, // 引号不平衡
    ];
    for (const desired of cases) {
      const r = mergeEntries(tomlInput({ desired, current: null }));
      expect(r.ok).toBe(false);
      expect(r.error).toContain('"x"'); // 点名 key 可以……
      if (r.error) expect(r.error).not.toContain('unclosed'); // ……值不行
    }
  });

  it('条目键与 pointer 必须是裸表名：带点/带空格的键 ok:false', () => {
    expect(mergeEntries(tomlInput({ desired: { 'a.b': '[mcp_servers.a.b]\nx = 1\n' } })).ok).toBe(false);
    expect(mergeEntries(tomlInput({ previous: { 'bad key': 'sha256:x' }, desired: {} })).ok).toBe(false);
    expect(mergeEntries(tomlInput({ pointer: ['mcp servers'], desired: { x: '[mcp servers.x]\ny = 1\n' } })).ok).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------- currentEntryHashes（ledgercheck 的底座）

describe('currentEntryHashes', () => {
  it('json：按账本键定位条目层（伤疤同名不干扰），哈希与 merge 的 delivered 一致', () => {
    const r1 = mergeEntries(
      jsonInput({
        current: claudeFile(),
        desired: { ours: '{"command":"npx"}', second: '{"url":"https://s"}' },
      }),
    );
    const hashes = currentEntryHashes('json', r1.text ?? null, ['ours', 'second', 'personal']);
    expect(hashes.ours).toBe((r1.delivered as Record<string, string>).ours);
    expect(hashes.second).toBe((r1.delivered as Record<string, string>).second);
    expect(hashes.personal).not.toBeNull(); // 成员的键也能取到，只是账本不比对它

    const edited = (r1.text ?? '').replace('"command": "npx"', '"command": "member-edit"');
    expect(currentEntryHashes('json', edited, ['ours']).ours).not.toBe((r1.delivered as Record<string, string>).ours);
    expect(currentEntryHashes('json', '{ broken', ['ours']).ours).toBeNull();
    expect(currentEntryHashes('json', null, ['ours']).ours).toBeNull();
    expect(currentEntryHashes('json', r1.text ?? null, [])['ours']).toBeUndefined();
  });

  it('json：键不在任何对象层里 → null', () => {
    expect(currentEntryHashes('json', '{"mcpServers":{"personal":{}}}', ['ghost'])).toEqual({ ghost: null });
  });

  it('toml：按 [x.<key>] 表头取块原文哈希；同名歧义与异形 → null', () => {
    const r1 = mergeEntries(
      tomlInput({ current: MEMBER_TOML, desired: { ours: tomlBlock('ours', 'command = "npx"\n') } }),
    );
    const hashes = currentEntryHashes('toml', r1.text ?? null, ['ours']);
    expect(hashes.ours).toBe((r1.delivered as Record<string, string>).ours);

    const edited = (r1.text ?? '').replace('command = "npx"', 'command = "member-edit"');
    expect(currentEntryHashes('toml', edited, ['ours']).ours).not.toBe(hashes.ours);

    expect(currentEntryHashes('toml', '[a.db]\nx = 1\n[mcp_servers.db]\ny = 2\n', ['db']).db).toBeNull();
    expect(currentEntryHashes('toml', '[[bad]]\nx = 1\n', ['ours']).ours).toBeNull();
    expect(currentEntryHashes('toml', '[db]\nx = 1\n', ['db']).db).toBeNull(); // 裸 [db] 不是条目形态
  });
});

// ---------------------------------------------------- 行尾保护（CRLF，QA D4）

describe('mergeEntries 行尾保护（CRLF 成员文件）', () => {
  const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
  /** 全文 CRLF 判定：不存在孤立 LF（\r\n 是合法形态，不能盲目替换检查）。 */
  const allCrlf = (s: string): boolean => (s.match(/(?<!\r)\n/g) ?? []).length === 0;

  it('JSON：CRLF 成员文件投一条 server → 输出保持 CRLF，成员条目内容不变', () => {
    const current = crlf(claudeFile());
    const r = mergeEntries(jsonInput({ current, desired: { alpha: '{"command":"npx"}' } }));
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    // 输出全文 CRLF：成员文件不再被整体翻成 LF（每次 pull 都在改写成员字节）
    expect(allCrlf(r.text as string)).toBe(true);
    const doc = JSON.parse(r.text as string) as { mcpServers: Record<string, unknown> };
    expect(doc.mcpServers).toMatchObject({ personal: { command: 'mine' }, alpha: { command: 'npx' } });
  });

  it('JSON：CRLF 成员文件撤掉我们那条 → 与投递前逐字节相同（卸载还原成立）', () => {
    const original = crlf(claudeFile());
    const r1 = mergeEntries(jsonInput({ current: original, desired: { alpha: '{"command":"npx"}' } }));
    const previous = r1.delivered as Record<string, string>;
    const r2 = mergeEntries(jsonInput({ current: r1.text as string, previous, desired: {} }));
    expect(r2.ok).toBe(true);
    expect(r2.removed).toEqual(['alpha']);
    expect(r2.text).toBe(original); // 逐字节还原，不吞结尾换行、不翻行尾
  });

  it('TOML：CRLF 成员文件投一条 → 成员行保持 CRLF、我方块也是 CRLF；二次 pull 字节不变', () => {
    const current = crlf(MEMBER_TOML);
    const desired = { alpha: tomlBlock('alpha', 'url = "https://alpha.example"') };
    const r1 = mergeEntries(tomlInput({ current, desired }));
    expect(r1.ok).toBe(true);
    const after = r1.text as string;
    expect(allCrlf(after)).toBe(true); // 全文 CRLF（我方块不是孤立 LF）
    expect(after).toContain('model = "gpt-5"\r\n'); // 成员行原样 CRLF
    const previous = r1.delivered as Record<string, string>;
    const r2 = mergeEntries(tomlInput({ current: after, previous, desired }));
    expect(r2.ok).toBe(true);
    expect(r2.changed).toBe(false); // 二次幂等：块 canonical 比对已与行尾无关
  });
});
