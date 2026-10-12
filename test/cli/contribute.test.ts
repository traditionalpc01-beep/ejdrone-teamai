import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contributeCommand, type ContributeOptions } from '../../src/cli/contribute.js';
import { createContext } from '../../src/cli/context.js';
import { repoDir, saveConfig, stateDir } from '../../src/state.js';

/**
 * M9 / T9.2：contribute 命令层（单元面）。
 *
 * 接线（`src/cli.ts` 注册 `contribute`）由协调者做，所以这里**直接调 contributeCommand**——
 * 与 test/cli/recall.test.ts 同一形态。端到端（真 git + MR + merge + 第二个成员 pull + recall）在
 * test/integration/learnings.test.ts。
 *
 * 本文件只用 `--dry-run` 与离线 checkout（`readExistingSnapshot` 不碰网络、不跑 git），
 * 因此这里**连 git 仓库都不需要**：repoDir 下放一堆普通文件就能模拟"仓库现状"。
 */

interface Run {
  code: number;
  out: string;
  err: string;
  all: string;
}

let root = '';
let home = '';
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-contribute-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  env = { HOME: home, EJDRONE_HOME: join(home, '.ejdrone'), EJDRONE_NONINTERACTIVE: '1' };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  root = '';
  home = '';
  env = {};
});

function writeConfig(primaryRole: string | null = null): void {
  saveConfig(
    {
      version: 1,
      repo: join(root, 'origin.git'),
      provider: 'git',
      primaryRole,
      additionalRoles: [],
      agents: ['claude'],
    },
    env,
  );
}

/** 伪造一份"本地已有仓库 checkout"（readExistingSnapshot 的离线读取面）。 */
function makeCheckout(files: Record<string, string>): void {
  const dir = repoDir(env);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function memberFile(name: string, content: string): string {
  const abs = join(home, name);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

async function contribute(options: Partial<ContributeOptions>): Promise<Run> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await contributeCommand(
    createContext({
      env,
      home,
      cwd: home,
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

const LEARNING = '---\ntitle: Kafka 消费积压复盘\ndate: 2026-10-12\ntags: [kafka, 消费积压]\n---\n\n# Kafka 消费积压复盘\n\n重启消费者组前先清空测试 topic。\n';
const TARGET = 'learnings/2026-10-12-kafka-消费积压复盘.md';

describe('入参校验', () => {
  it('没有 config：报错指到 init，且不读成员文件', async () => {
    const run = await contribute({ file: memberFile('note.md', LEARNING) });
    expect(run.code).toBe(1);
    expect(run.all).toContain('ejdrone init');
  });

  it('没给 --file：报错 + 用法', async () => {
    writeConfig();
    const run = await contribute({});
    expect(run.code).toBe(1);
    expect(run.err).toContain('--file');
  });

  it('--file 指向不存在的文件 / 目录：分别点名', async () => {
    writeConfig();
    const missing = await contribute({ file: join(home, 'nope.md') });
    expect(missing.code).toBe(1);
    expect(missing.all).toContain('nope.md');

    const dir = await contribute({ file: home });
    expect(dir.code).toBe(1);
    expect(dir.all).toContain('不是文件');
  });

  it('--ns 不合法：拒绝；team-codebase 是保留名：拒绝', async () => {
    writeConfig();
    const bad = await contribute({ file: memberFile('note.md', LEARNING), ns: 'Bad NS', dryRun: true });
    expect(bad.code).toBe(1);
    expect(bad.all).toContain('不合法');

    const reserved = await contribute({ file: memberFile('note.md', LEARNING), ns: 'team-codebase', dryRun: true });
    expect(reserved.code).toBe(1);
    expect(reserved.all).toContain('保留名');
  });
});

describe('--dry-run（只打印，零 git 副作用）', () => {
  it('打印目标路径与规范化后的完整内容；不写 checkout、不留锁', async () => {
    writeConfig();
    makeCheckout({ 'manifest/roles.yaml': 'version: 1\nroles: []\n' });
    const before = existsSync(repoDir(env)) ? readdirSync(repoDir(env)).sort() : [];

    const run = await contribute({ file: memberFile('note.md', LEARNING), dryRun: true });
    expect(run.code, run.all).toBe(0);
    expect(run.all).toContain(TARGET);
    expect(run.all).toContain('重启消费者组前先清空测试 topic。');
    expect(run.all).toContain('dry-run');

    // 一个字节都不许写进 checkout；也不建锁
    expect(readdirSync(repoDir(env)).sort()).toEqual(before);
    expect(existsSync(join(stateDir(env), 'sync.lock'))).toBe(false);
    expect(existsSync(join(repoDir(env), TARGET))).toBe(false);
  });

  it('成员文件缺 frontmatter 也能 dry-run：标题取首个 # 标题、日期补当天', async () => {
    writeConfig();
    makeCheckout({});
    const run = await contribute({
      file: memberFile('note.md', '# 灰度发布踩坑\n\n先 5% 再全量。\n'),
      dryRun: true,
    });
    expect(run.code, run.all).toBe(0);
    // 日期来自注入不了的本机时钟，这里只断形状：文件名以当天日期开头
    expect(run.all).toMatch(/learnings\/\d{4}-\d{2}-\d{2}-灰度发布踩坑\.md/);
    expect(run.all).toContain('先 5% 再全量。');
  });

  it('--ns 时目标进 learnings/<ns>/；角色映射多个 namespace 时拒绝并要求 --ns', async () => {
    writeConfig();
    makeCheckout({
      'manifest/roles.yaml': 'version: 1\nroles:\n  - id: full\n    namespaces: [be, fe]\n',
    });
    const file = memberFile('note.md', LEARNING);

    const ambiguous = await contribute({ file, dryRun: true, ns: undefined });
    // primaryRole 未设置 → 推根目录，这条不歧义；改用带角色的 config 重放
    expect(ambiguous.code, ambiguous.all).toBe(0);

    saveConfig(
      { version: 1, repo: join(root, 'origin.git'), provider: 'git', primaryRole: 'full', additionalRoles: [], agents: ['claude'] },
      env,
    );
    const needChoice = await contribute({ file, dryRun: true });
    expect(needChoice.code).toBe(1);
    expect(needChoice.all).toContain('多个 namespace');
    expect(needChoice.all).toContain('--ns');

    const withNs = await contribute({ file, dryRun: true, ns: 'be' });
    expect(withNs.code, withNs.all).toBe(0);
    expect(withNs.all).toContain(`learnings/be/2026-10-12-kafka-消费积压复盘.md`);
  });

  it('角色不在 manifest 且名字合法：照 push 的规则按同名 namespace 推并给提示', async () => {
    saveConfig(
      { version: 1, repo: join(root, 'origin.git'), provider: 'git', primaryRole: 'ops', additionalRoles: [], agents: ['claude'] },
      env,
    );
    makeCheckout({ 'manifest/roles.yaml': 'version: 1\nroles:\n  - id: be\n    namespaces: [be]\n' });
    const run = await contribute({ file: memberFile('note.md', LEARNING), dryRun: true });
    expect(run.code, run.all).toBe(0);
    expect(run.all).toContain('learnings/ops/2026-10-12-kafka-消费积压复盘.md');
    expect(run.all).toContain('manifest/roles.yaml');
  });
});

describe('目标撞名：拒绝并提示改名（不加 rand6）', () => {
  it('dry-run 对照本地 checkout 里的同名文件直接拒绝', async () => {
    writeConfig();
    makeCheckout({ [TARGET]: '已经有人提过这一份了。\n' });
    const run = await contribute({ file: memberFile('note.md', LEARNING), dryRun: true });
    expect(run.code).toBe(1);
    expect(run.all).toContain('已存在');
    expect(run.all).toContain(TARGET);
    expect(run.all).toContain('改名');
  });

  // 真实提交路径的撞名拒绝（openSnapshot 之后、建分支之前）在集成用例里连 git 一起验。
});

describe('规范化输出', () => {
  it('--title 覆盖文件名与正文推出来的标题', async () => {
    writeConfig();
    makeCheckout({});
    const run = await contribute({
      file: memberFile('随手记.md', '正文里没有任何标题。\n'),
      title: '上线事故复盘',
      dryRun: true,
    });
    expect(run.code, run.all).toBe(0);
    expect(run.all).toMatch(/learnings\/\d{4}-\d{2}-\d{2}-上线事故复盘\.md/);
    expect(run.all).toContain('title: 上线事故复盘');
    expect(run.all).toContain('正文里没有任何标题。');
  });

  it('成员文件原文里的正文进了落库内容，原文件不被改写', async () => {
    writeConfig();
    makeCheckout({});
    const abs = memberFile('note.md', LEARNING);
    const before = readFileSync(abs, 'utf8');
    const run = await contribute({ file: abs, dryRun: true });
    expect(run.code, run.all).toBe(0);
    expect(run.all).toContain('重启消费者组前先清空测试 topic。');
    expect(readFileSync(abs, 'utf8')).toBe(before);
  });
});
