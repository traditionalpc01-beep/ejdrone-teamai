import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recallCommand } from '../../src/cli/recall.js';
import { createContext } from '../../src/cli/context.js';
import { loadLedger } from '../../src/core/ledger.js';
import { RELEVANCE_THRESHOLD } from '../../src/core/recall.js';
import { ledgerPath } from '../../src/state.js';
import { createHarness, installTools, seedDocs, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * M8 / T8.4·T8.5：团队知识（docs）的端到端。
 *
 * 这里盯的是单测测不到的那条链：仓库 `docs/` → 角色裁决 → 镜像投递 → 记账 → recall 检索。
 * 五条行为逐个钉住（父计划 T8.2/T8.6 与执行子计划 T8.4）：
 *   1. namespace 过滤：只有激活角色的文档进镜像；
 *   2. 镜像路径 `~/.ejdrone/knowledge/docs/<ns>/<name>.md`（name 带 ns 段是记账唯一性的来源）；
 *   3. 成员改过镜像副本 → 不覆盖、只点名（§10 红线）；
 *   4. namespace 失效 → 镜像副本删除；
 *   5. `team-codebase` 保留名整目录跳过并告警。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
  seedDocs(h);
});

afterEach(() => {
  h.cleanup();
});

async function initMember(member: Member, ids: string[], role = 'be'): Promise<void> {
  installTools(member, ids);
  const result = await member.run(['init', h.origin, '--agent', ids.join(','), '--role', role]);
  expect(result.code, result.all).toBe(0);
}

/** 直接调命令函数的那条路径：绕开 CLI 解析，专测打分与输出形状。 */
async function recall(member: Member, query: string, options = {}): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await recallCommand(
    createContext({
      env: member.env,
      home: member.home,
      cwd: member.home,
      interactive: false,
      out: (text) => outLines.push(text),
      err: (text) => errLines.push(text),
    }),
    query,
    options,
  );
  return { code, out: outLines.join('\n'), err: errLines.join('\n') };
}

const MIRROR = ['.ejdrone', 'knowledge'] as const;

describe('docs 镜像投递', () => {
  it('根文档与激活 namespace 文档按 docs/<ns>/<name>.md 落进镜像，且一处都不进工具目录', async () => {
    const member = h.member('docs-mirror');
    await initMember(member, ['claude'], 'be');

    expect(member.exists(...MIRROR, 'docs', 'deploy.md')).toBe(true);
    expect(member.read(...MIRROR, 'docs', 'deploy.md')).toContain('灰度发布先切 5% 流量');
    expect(member.exists(...MIRROR, 'docs', 'be', 'db-migrations.md')).toBe(true);

    // 未激活 namespace（fe）的文档压根不落盘 —— 这就是"按角色裁剪"的可见证据
    expect(member.exists(...MIRROR, 'docs', 'fe', 'react-style.md')).toBe(false);

    // 知识不进任何工具目录（16 个工具没有统一知识落点，父计划 §7 的偏差登记）
    expect(member.exists('.claude', 'docs')).toBe(false);
    expect(member.exists('.claude', 'knowledge')).toBe(false);
  });

  it('账本按 docs:<ns>/<name> 记账（name 带 ns 段是停用后还能删掉的前提）；二次 pull 幂等', async () => {
    const member = h.member('docs-ledger');
    await initMember(member, ['claude'], 'be');

    const { ledger } = loadLedger(ledgerPath(member.env));
    const docKeys = ledger.entries.filter((e) => e.resource.startsWith('docs:')).map((e) => e.resource).sort();
    expect(docKeys).toEqual(['docs:be/db-migrations', 'docs:deploy']);
    for (const entry of ledger.entries.filter((e) => e.resource.startsWith('docs:'))) {
      expect(entry.path).toContain(join('.ejdrone', 'knowledge', 'docs'));
    }

    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(0);
    // 幂等：二次 pull 不再写任何文件（镜像内容与账本都对得上）
    expect(pull.out).toContain('已投递 0 个文件');
  });

  it('同名文档在根与 namespace 两处都投（并集语义，不互相覆盖）', async () => {
    h.writeSeed('docs/db-notes.md', '---\ntitle: 数据库变更规范（全员版）\n---\n\n根版本。\n');
    h.writeSeed('docs/be/db-notes.md', '---\ntitle: 数据库变更规范（后端版）\n---\n\nbe 版本。\n');
    h.commitSeed('same doc name at root and in a namespace');

    const member = h.member('docs-union');
    await initMember(member, ['claude'], 'be');

    expect(member.read(...MIRROR, 'docs', 'db-notes.md')).toContain('根版本');
    expect(member.read(...MIRROR, 'docs', 'be', 'db-notes.md')).toContain('be 版本');
  });

  it('成员改过镜像副本：pull 保留他的版本并点名，不覆盖', async () => {
    const member = h.member('docs-edited');
    await initMember(member, ['claude'], 'be');
    const mirrorRel = ['.ejdrone', 'knowledge', 'docs', 'deploy.md'] as const;
    member.write(join(...mirrorRel), '---\ntitle: 发布流程\n---\n\n我自己加的笔记，别覆盖掉。\n');

    // 团队侧也改一次：不改的话"内容一致"会走静默重写分支，测不出保护行为
    h.writeSeed('docs/deploy.md', '---\ntitle: 发布流程\ntags: [deploy]\n---\n\n团队改后的版本。\n');
    h.commitSeed('team updates the doc a member edited');

    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(1);
    expect(pull.all).toContain('本地已修改');
    expect(pull.all).toContain('docs/deploy.md');

    expect(member.read(...mirrorRel)).toContain('我自己加的笔记');
    expect(member.read(...mirrorRel)).not.toContain('团队改后的版本');
  });

  /**
   * 停用 namespace 后镜像副本必须删得掉。协调者已把 `delivery.ts` 的 isManaged 与
   * `uninstall.ts` 的 owned 并上「落在 knowledge 镜像根之下」（`core/knowledge.ts` 的
   * `isKnowledgePath`）—— 镜像不在任何工具目录里，适配器 `ownsPath` 天生覆盖不到它，
   * 少了这一句 apply 的删除分支会一路跳过，文件与账本条目永久滞留。
   */
  it('停用 namespace 后，那份镜像副本被删除；根文档留着', async () => {
    const member = h.member('docs-ns-off');
    await initMember(member, ['claude'], 'be');
    expect(member.exists(...MIRROR, 'docs', 'be', 'db-migrations.md')).toBe(true);

    const set = await member.run(['roles', 'set', 'fe']);
    expect(set.code, set.all).toBe(0);
    const pull = await member.run(['pull']);
    expect(pull.code, pull.all).toBe(0);

    expect(member.exists(...MIRROR, 'docs', 'be', 'db-migrations.md')).toBe(false);
    expect(member.exists(...MIRROR, 'docs', 'fe', 'react-style.md')).toBe(true);
    expect(member.exists(...MIRROR, 'docs', 'deploy.md')).toBe(true);
  });

  it('team-codebase 是保留名：整目录跳过并点名，不投进镜像', async () => {
    h.writeSeed('docs/team-codebase/architecture.md', '# 代码库知识图谱\n\n这个目录名是保留的。\n');
    h.commitSeed('attempt a reserved team-codebase namespace');

    const member = h.member('docs-reserved');
    await initMember(member, ['claude'], 'be');

    expect(member.exists(...MIRROR, 'docs', 'team-codebase')).toBe(false);
    const pull = await member.run(['pull']);
    expect(pull.all).toContain('team-codebase');
    expect(pull.all).toContain('保留名');
  });
});

describe('recall 读的是这份镜像', () => {
  it('命中根文档与激活 namespace 文档，不命中未激活角色的那篇', async () => {
    const member = h.member('recall-ns-filter');
    await initMember(member, ['claude'], 'be');

    const root = await recall(member, '灰度发布');
    expect(root.code, root.out).toBe(0);
    expect(root.out).toContain(member.path(...MIRROR, 'docs', 'deploy.md'));

    const active = await recall(member, '迁移');
    expect(active.code, active.out).toBe(0);
    expect(active.out).toContain(member.path(...MIRROR, 'docs', 'be', 'db-migrations.md'));

    const inactive = await recall(member, '组件拆分');
    expect(inactive.code, inactive.out).toBe(0);
    expect(inactive.out).toContain('没有命中');
  });

  it('--check 过门槛返回 0、不过门槛返回 1，两种情况都只有一行判定', async () => {
    const member = h.member('recall-check');
    await initMember(member, ['claude'], 'be');

    const yes = await recall(member, '发布流程', { check: true });
    expect(yes.code, yes.out).toBe(0);
    expect(yes.out).toMatch(/^RELEVANT score=\d+ threshold=\d+$/);
    // 标题 ×3 + 正文里的 `# 发布流程` 一行 ×1 = 4
    expect(yes.out).toBe(`RELEVANT score=4 threshold=${RELEVANCE_THRESHOLD}`);

    const no = await recall(member, '组件拆分', { check: true });
    expect(no.code, no.out).toBe(1);
    expect(no.out).toBe(`NOT_RELEVANT score=0 threshold=${RELEVANCE_THRESHOLD}`);
  });

  it('--json 给机器读的绝对路径与片段', async () => {
    const member = h.member('recall-json');
    await initMember(member, ['claude'], 'be');
    const run = await recall(member, 'mysql', { json: true });
    expect(run.code, run.out).toBe(0);
    const doc = JSON.parse(run.out) as {
      scanned: number;
      relevant: boolean;
      results: Array<{ path: string; kind: string; score: number; context: string[] }>;
    };
    expect(doc.scanned).toBe(2);
    expect(doc.relevant).toBe(true);
    expect(doc.results[0]?.kind).toBe('docs');
    expect(doc.results[0]?.path).toBe(member.path(...MIRROR, 'docs', 'be', 'db-migrations.md'));
    expect(doc.results[0]?.context.join('\n')).toContain('禁止手工 ALTER');
  });

  it('还没 pull 过的机器：提示镜像不存在，退出码 0（不是错误）', async () => {
    const fresh = h.member('recall-unpulled');
    installTools(fresh, ['claude']);
    const run = await recall(fresh, '任何东西');
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain('团队知识镜像还不存在');
  });
});

/**
 * T8.3 的 push 侧一半：**内置 skill 名 `ejdrone-recall` / `ejdrone-share` 是保留名，push 必须拒绝**
 * （照 teamai 的 `teamai-recall` 永不 push；防成员把内置技能改个名推回来覆盖团队版）。
 *
  * 这条守卫在 `src/cli/push.ts` 的 `buildTargets`（与 isValidResourceName 并列的一道名检），
 * 名单在 `cli/constants.ts` 的 `BUILTIN_SKILL_NAMES`。允许 push 覆盖的后果是：某个成员本地改过的
 * 一份引导技能，绕开评审变成全员的默认教材。
 * 内置技能正文已就位：`skills/ejdrone-recall/SKILL.md`。
 */
describe('push 侧保留名', () => {
  it('ejdrone-recall 与 ejdrone-share 不允许被 push 进团队仓库', async () => {
    const member = h.member('push-reserved');
    await initMember(member, ['claude'], 'be');
    member.write(join('.claude', 'skills', 'ejdrone-recall', 'SKILL.md'), '---\nname: ejdrone-recall\ndescription: 覆盖团队内置技能\n---\n\n正文\n');

    const push = await member.run([
      'push',
      '--skill',
      member.path('.claude', 'skills', 'ejdrone-recall'),
      '--ns',
      'be',
    ]);
    expect(push.code, push.all).toBe(1);
    expect(push.all).toContain('保留名');
    expect(h.remoteBranches()).toEqual(['main']);
  });
});

describe('doctor 的 knowledge:mirror', () => {
  type Doc = { checks: Array<{ id: string; status: string; message: string; hint?: string }> };

  it('镜像到位时 PASS；成员手删一份镜像文档后 WARN 点到那一份', async () => {
    const member = h.member('docs-doctor');
    await initMember(member, ['claude'], 'be');

    const good = await member.run(['doctor', '--json']);
    const goodCheck = (JSON.parse(good.out) as Doc).checks.find((c) => c.id === 'knowledge:mirror');
    expect(goodCheck?.status, good.out).toBe('PASS');

    rmSync(member.path(...MIRROR, 'docs', 'deploy.md'), { force: true });
    const after = await member.run(['doctor', '--json']);
    const warn = (JSON.parse(after.out) as Doc).checks.find((c) => c.id === 'knowledge:mirror');
    expect(warn?.status, after.out).toBe('WARN');
    expect(warn?.message).toContain('docs/deploy');
    expect(warn?.hint).toContain('pull');
  });

  it('仓库里没有 docs/ 与 learnings/ 时这一项是 PASS，而不是催一个没知识的人去 pull', async () => {
    h.removeSeed('docs');
    h.commitSeed('remove docs seed for the empty-knowledge case');

    const member = h.member('docs-doctor-empty');
    await initMember(member, ['claude'], 'be');

    const out = await member.run(['doctor', '--json']);
    const check = (JSON.parse(out.out) as Doc).checks.find((c) => c.id === 'knowledge:mirror');
    expect(check?.status, out.out).toBe('PASS');
    expect(check?.message).toContain('没有 docs/ 与 learnings/ 条目');
  });
});

describe('recall 的 CLI 接线（cli.ts 注册后必须能被真的调到）', () => {
  it('`ejdrone recall "<query>"` 出命中路径；`--check` 命中返回 0、不命中返回 1', async () => {
    const member = h.member('docs-recall-cli');
    await initMember(member, ['claude'], 'be');

    const hit = await member.run(['recall', '灰度 发布']);
    expect(hit.code, hit.all).toBe(0);
    expect(hit.all).toContain(member.path(...MIRROR, 'docs', 'deploy.md'));

    const check = await member.run(['recall', '--check', '灰度 发布']);
    expect(check.code, check.all).toBe(0);
    expect(check.all).toContain('RELEVANT');
    // --check 的契约是"只给判定，不给正文"：这条断言防止有人把它做成第二个 list
    expect(check.all).not.toContain('十分钟');

    const miss = await member.run(['recall', '--check', 'zzz-没有这种资料']);
    expect(miss.code, miss.all).toBe(1);
    expect(miss.all).toContain('NOT_RELEVANT');

    const json = await member.run(['recall', 'mysql 迁移', '--json']);
    expect(json.code, json.all).toBe(0);
    expect((JSON.parse(json.out).results as Array<{ path: string }>)[0]?.path).toContain(
      join('knowledge', 'docs', 'be', 'db-migrations.md'),
    );
  });

  it('缺检索词时给用法而不是抛栈', async () => {
    const member = h.member('docs-recall-noargs');
    await initMember(member, ['claude'], 'be');
    const empty = await member.run(['recall']);
    expect(empty.code).toBe(1);
    expect(empty.all).toContain('需要一个检索词');
  });
});
