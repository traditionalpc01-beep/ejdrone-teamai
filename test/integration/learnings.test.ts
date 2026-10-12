import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contributeCommand, type ContributeOptions } from '../../src/cli/contribute.js';
import { recallCommand } from '../../src/cli/recall.js';
import { createContext } from '../../src/cli/context.js';
import { RELEVANCE_THRESHOLD } from '../../src/core/recall.js';
import { createHarness, installTools, seedLearnings, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * M9 / T9.4：经验沉淀端到端。
 *
 * 盯的是单测测不到的那条链：`contribute → MR 分支 → 评审合入默认分支 → 第二个成员 pull →
 * 学习条目进 ~/.ejdrone/knowledge/learnings/ 镜像 → recall 命中`。
 * 真实 git（origin = `git init --bare`），不 mock。大部分用例**直接调命令函数**看行为，
 * 最后一组走 `member.run(['contribute', …])` 验 CLI 注册本身 —— 只调函数的话，
 * 忘记把命令挂进 `src/cli.ts` 也能全绿，那正是这层接线要盯的盲区。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
  seedLearnings(h);
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

async function contribute(member: Member, options: Partial<ContributeOptions>) {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await contributeCommand(
    createContext({
      env: member.env,
      home: member.home,
      cwd: member.home,
      interactive: false,
      out: (t) => outLines.push(t),
      err: (t) => errLines.push(t),
    }),
    { file: '', ...options },
  );
  const out = outLines.join('\n');
  const err = errLines.join('\n');
  return { code, out, err, all: `${out}\n${err}` };
}

async function recall(member: Member, query: string, options = {}) {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await recallCommand(
    createContext({
      env: member.env,
      home: member.home,
      cwd: member.home,
      interactive: false,
      out: (t) => outLines.push(t),
      err: (t) => errLines.push(t),
    }),
    query,
    options,
  );
  return { code, out: outLines.join('\n'), err: errLines.join('\n') };
}

function contributeBranch(): string {
  const branch = h.remoteBranches().find((name) => name.startsWith('ejdrone/contribute-learning-'));
  expect(branch, `远端分支：${h.remoteBranches().join(', ')}`).toBeTruthy();
  return branch as string;
}

/** 只读取远端 main 的提交号：dry-run 用例靠它证明"一个新提交都没有"。 */
function mainSha(): string {
  return execFileSync('git', ['-C', h.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
}

const MIRROR = ['.ejdrone', 'knowledge'] as const;

/** 成员本地写好的一份 learning：标题/日期/tags 齐，落库名可精确预言。 */
const LEARNING_FILE = 'my-learning.md';
const LEARNING_TEXT =
  '---\ntitle: Kafka 消费积压复盘\ndate: 2026-10-12\ntags: [kafka, 消费积压]\n---\n\n# Kafka 消费积压复盘\n\n重启消费者组之前先清空测试 topic，否则积压数字会骗人。\n';
const LEARNED_NAME = '2026-10-12-kafka-消费积压复盘';

describe('contribute → MR → 合入 → 成员 pull → recall 命中', () => {
  it('完整链路：无角色 = 入库仓库根 learnings/，第二个成员的镜像与 recall 都拿到它', async () => {
    // 无角色的成员（init 不带 --role）走 push 的同一条规则：资源落仓库根目录（全员共享）
    const author = h.member('learning-author');
    await initMember(author, ['claude']);
    author.write(LEARNING_FILE, LEARNING_TEXT);

    const contributed = await contribute(author, { file: author.path(LEARNING_FILE) });
    expect(contributed.code, contributed.all).toBe(0);
    expect(contributed.all).toContain(`learnings/${LEARNED_NAME}.md`);
    // provider=git 的本地 origin：推分支 + 手动开 MR 指引，绝不假装自动开了 MR
    expect(contributed.all).toContain('已推送分支');

    const branch = contributeBranch();
    h.mergeIntoMain(branch);
    expect(h.seedRead(`learnings/${LEARNED_NAME}.md`)).toContain('积压数字会骗人');

    const reader = h.member('learning-reader');
    await initMember(reader, ['claude'], 'be');
    expect(reader.exists(...MIRROR, 'learnings', `${LEARNED_NAME}.md`)).toBe(true);
    expect(reader.read(...MIRROR, 'learnings', `${LEARNED_NAME}.md`)).toContain('积压数字会骗人');

    const checked = await recall(reader, 'kafka 消费积压', { check: true });
    expect(checked.code, checked.out).toBe(0);
    expect(checked.out).toBe(`RELEVANT score=12 threshold=${RELEVANCE_THRESHOLD}`);

    const hits = await recall(reader, 'kafka 消费积压');
    expect(hits.code, hits.out).toBe(0);
    expect(hits.out).toContain(reader.path(...MIRROR, 'learnings', `${LEARNED_NAME}.md`));
  });

  it('--ns 入库进 learnings/<ns>/：只有订阅该 namespace 的角色拿得到', async () => {
    const author = h.member('learning-ns-author');
    await initMember(author, ['claude'], 'be');
    author.write(LEARNING_FILE, LEARNING_TEXT);

    const contributed = await contribute(author, { file: author.path(LEARNING_FILE), ns: 'be' });
    expect(contributed.code, contributed.all).toBe(0);
    expect(contributed.all).toContain(`learnings/be/${LEARNED_NAME}.md`);
    h.mergeIntoMain(contributeBranch());

    const be = h.member('learning-ns-be');
    await initMember(be, ['claude'], 'be');
    expect(be.exists(...MIRROR, 'learnings', 'be', `${LEARNED_NAME}.md`)).toBe(true);

    const fe = h.member('learning-ns-fe');
    await initMember(fe, ['claude'], 'fe');
    expect(fe.exists(...MIRROR, 'learnings', 'be', `${LEARNED_NAME}.md`)).toBe(false);
  });

  it('--dry-run 零 git 副作用：不建分支、不加提交、不动本地 checkout，只打印落库内容与目标路径', async () => {
    const author = h.member('learning-dryrun');
    await initMember(author, ['claude']);
    author.write(LEARNING_FILE, LEARNING_TEXT);

    const branchesBefore = h.remoteBranches();
    const shaBefore = mainSha();

    const run = await contribute(author, { file: author.path(LEARNING_FILE), dryRun: true });
    expect(run.code, run.all).toBe(0);
    expect(run.all).toContain('dry-run');
    expect(run.all).toContain(`learnings/${LEARNED_NAME}.md`);
    expect(run.all).toContain('积压数字会骗人');

    expect(h.remoteBranches()).toEqual(branchesBefore);
    expect(mainSha()).toBe(shaBefore);
    // 本地 checkout 里也没有那份 learning：dry-run 连 clone/fetch 都不做，撞名检查只是读
    expect(existsSync(join(author.state, 'repo', 'learnings', `${LEARNED_NAME}.md`))).toBe(false);
    // 没有 MR、没有锁残留
    expect(existsSync(join(author.state, 'sync.lock'))).toBe(false);
  });

  it('目标路径已存在：拒绝并提示改名，不开分支；输出与错误里都没有随机后缀', async () => {
    const author = h.member('learning-collision');
    await initMember(author, ['claude']);
    // seedLearnings 里已有 learnings/2026-10-11-发布流程复盘.md —— 同标题同日期重放它
    author.write(
      'dup.md',
      '---\ntitle: 发布流程复盘\ndate: 2026-10-11\n---\n\n# 发布流程复盘\n\n又踩了一次同样的坑。\n',
    );

    const refused = await contribute(author, { file: author.path('dup.md') });
    expect(refused.code).toBe(1);
    expect(refused.all).toContain('已存在');
    expect(refused.all).toContain('改名');
    expect(refused.all).toContain('learnings/2026-10-11-发布流程复盘.md');
    expect(h.remoteBranches()).toEqual(['main']);

    // 换个标题就能提交：撞名拒绝不会把后来的合法贡献也堵死
    const renamed = await contribute(author, {
      file: author.path('dup.md'),
      title: '发布流程复盘 第二次踩坑',
    });
    expect(renamed.code, renamed.all).toBe(0);
    expect(renamed.all).toContain('learnings/2026-10-11-发布流程复盘-第二次踩坑.md');
    const branch = contributeBranch();
    // 分支名只用短哈希，不用中文 slug：远端 ref 与 GitLab UI 的兼容性别赌
    expect(branch).toMatch(/^ejdrone\/contribute-learning-[0-9a-f]{8}-\d{8}T\d{6}Z$/);
    expect(branch).not.toContain('发布');
  });

  it('缺 tags 不拒绝：入库时点名让评审补，落库文件里 tags: [] 照投', async () => {
    const author = h.member('learning-no-tags');
    await initMember(author, ['claude']);
    author.write('notags.md', '# 网关超时排查\n\ngateway timeout 先看连接池水位。\n');

    const contributed = await contribute(author, { file: author.path('notags.md') });
    expect(contributed.code, contributed.all).toBe(0);
    expect(contributed.all).toContain('还没有 tags');

    const branch = contributeBranch();
    h.mergeIntoMain(branch);
    const landed = readdirSync(join(h.seed, 'learnings')).filter((n) => n.endsWith('-网关超时排查.md'));
    expect(landed).toHaveLength(1);
    const text = h.seedRead(`learnings/${landed[0]}`);
    expect(text).toContain('title: 网关超时排查');
    expect(text).toContain('tags: []');
    expect(text).toContain('gateway timeout 先看连接池水位。');
  });
});

describe('contribute 的 CLI 接线（cli.ts 注册后必须能被真的调到）', () => {
  it('--dry-run 经 CLI 零副作用、退出码 0；真跑经 CLI 建出 MR 分支', async () => {
    const member = h.member('learnings-cli');
    await initMember(member, ['claude']);
    member.write('my-note.md', '# 灰度发布回滚顺序\n\n先回滚流量再回滚配置。\n');

    const dry = await member.run(['contribute', '--file', member.path('my-note.md'), '--dry-run']);
    expect(dry.code, dry.all).toBe(0);
    expect(dry.all).toContain('learnings/');
    expect(h.remoteBranches()).toEqual(['main']);

    const real = await member.run(['contribute', '--file', member.path('my-note.md'), '--title', '灰度发布回滚顺序']);
    expect(real.code, real.all).toBe(0);
    const branch = h.remoteBranches().find((n) => n !== 'main');
    expect(branch, h.remoteBranches().join(', ')).toBeTruthy();
    expect(real.all).toContain('MR');
  });

  it('缺 --file 时 commander 直接拒（不是运行到一半才报错）', async () => {
    const member = h.member('learnings-cli-noargs');
    await initMember(member, ['claude']);
    const out = await member.run(['contribute']);
    expect(out.code).toBe(1);
  });
});
