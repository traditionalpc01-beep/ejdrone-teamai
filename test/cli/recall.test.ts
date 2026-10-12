import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recallCommand } from '../../src/cli/recall.js';
import { createContext } from '../../src/cli/context.js';
import { RELEVANCE_THRESHOLD } from '../../src/core/recall.js';
import { knowledgeDocsDir, knowledgeLearningsDir } from '../../src/state.js';

/**
 * M8 / T8.2：recall 命令层。
 *
 * 接线（`src/cli.ts` 注册 `recall`）由协调者做，所以这里**直接调 recallCommand**、
 * 用 createContext 注入伪造 HOME —— 与 test/cli/doctor.test.ts 同一形态。
 * 三种输出形态的**约定**各钉一条：默认给人看、`--check` 只给一行且绝不漏正文、`--json` 机器可读；
 * 加上"镜像还没建起来"这条不是错误的错误路径（恒返回 0）。
 */

interface Run {
  code: number;
  out: string;
  err: string;
  all: string;
}

let root = '';
let env: NodeJS.ProcessEnv = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-recall-cli-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  env = { HOME: home, EJDRONE_HOME: join(home, '.ejdrone') };
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
  env = {};
});

async function recall(query: string | undefined, options = {}): Promise<Run> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = await recallCommand(
    createContext({ env, home: env.HOME as string, interactive: false, out: (t) => outLines.push(t), err: (t) => errLines.push(t) }),
    query,
    options,
  );
  const out = outLines.join('\n');
  const err = errLines.join('\n');
  return { code, out, err, all: `${out}\n${err}` };
}

/** 伪造 pull 之后的镜像状态（命令层只读镜像，不该关心 git）。 */
function seedMirror(rel: string, content: string): string {
  const inLearnings = rel.startsWith('learnings/');
  const base = inLearnings ? knowledgeLearningsDir(env) : knowledgeDocsDir(env);
  const path = join(base, inLearnings ? rel.slice('learnings/'.length) : rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

const SECRET_BODY = '这一段正文里写了 kafka 的排查步骤，还有内部账号 kafka_admin。';

function seedDocs(): void {
  mkdirSync(knowledgeDocsDir(env), { recursive: true });
  mkdirSync(knowledgeLearningsDir(env), { recursive: true });
}

describe('recall 默认输出（给人看）', () => {
  it('打印路径 + 命中行 ±2 行，按分数排序，退出码 0', async () => {
    seedDocs();
    const strong = seedMirror('kafka-ops.md', `---\ntitle: Kafka 运维手册\ntags: [消息队列]\n---\n\n第一行\n第二行\n${SECRET_BODY}\n第四行\n第五行\n`);
    const weak = seedMirror('misc.md', '---\ntitle: 别的\n---\n\n顺带提到 kafka 一次。\n');

    const run = await recall('kafka');
    expect(run.code, run.all).toBe(0);
    expect(run.out).toContain(strong);
    expect(run.out).toContain(weak);
    // 高分的排前面
    expect(run.out.indexOf(strong)).toBeLessThan(run.out.indexOf(weak));
    // 命中行 ±2 行：中心行带 '>' 标记，上下各两行
    expect(run.out).toContain('第一行');
    expect(run.out).toContain('第五行');
    expect(run.out).toContain('>');
    expect(run.out).toContain('score=4');
  });

  it('没有任何命中：说清楚扫描了多少份并给下一步，退出码仍是 0', async () => {
    seedDocs();
    seedMirror('kafka-ops.md', '---\ntitle: Kafka 运维手册\n---\n\n正文\n');
    const run = await recall('根本不存在的东西');
    expect(run.code, run.all).toBe(0);
    expect(run.out).toContain('没有命中');
    expect(run.out).toContain('下一步');
  });

  it('缺检索词：错误 + 用法，退出码 1', async () => {
    seedDocs();
    const run = await recall('   ');
    expect(run.code).toBe(1);
    expect(run.err).toContain('需要一个检索词');
    expect(run.err).toContain('下一步');
  });
});

describe('--check（hook / skill 的预检）', () => {
  it('过门槛：一行 RELEVANT，退出码 0，且不打印任何正文', async () => {
    seedDocs();
    seedMirror('kafka-ops.md', `---\ntitle: Kafka 运维手册\n---\n\n${SECRET_BODY}\n`);
    const run = await recall('kafka', { check: true });
    expect(run.code, run.all).toBe(0);
    expect(run.out).toMatch(/^RELEVANT score=\d+ threshold=\d+$/);
    // 标题 ×3 + 正文 ×1 = 4
    expect(run.out).toBe(`RELEVANT score=4 threshold=${RELEVANCE_THRESHOLD}`);
    // 预检是自动跑的：除那一行判定外什么都不能出现，正文尤其不能
    expect(run.out).not.toContain('kafka_admin');
    expect(run.out.split('\n')).toHaveLength(1);
  });

  it('不过门槛：一行 NOT_RELEVANT，退出码 1', async () => {
    seedDocs();
    // 只在正文里出现一次 = 1 分，低于默认门槛 2
    seedMirror('weak.md', '---\ntitle: 无关标题\n---\n\n顺带提到 zookeeper 一次。\n');
    const run = await recall('zookeeper', { check: true });
    expect(run.code, run.all).toBe(1);
    expect(run.out).toBe(`NOT_RELEVANT score=1 threshold=${RELEVANCE_THRESHOLD}`);
  });

  it('完全没命中也是 NOT_RELEVANT + 退出码 1', async () => {
    seedDocs();
    seedMirror('weak.md', '---\ntitle: 无关标题\n---\n\n正文\n');
    const run = await recall('不存在的词', { check: true });
    expect(run.code).toBe(1);
    expect(run.out).toBe(`NOT_RELEVANT score=0 threshold=${RELEVANCE_THRESHOLD}`);
  });

  it('learnings 镜像同样在检索范围内（M9 的 contribute → recall 链路靠这条）', async () => {
    seedDocs();
    seedMirror('learnings/2026-10-12-kafka.md', '---\ntitle: kafka 消费积压踩坑\ndate: 2026-10-12\n---\n\n正文\n');
    const run = await recall('kafka', { check: true });
    expect(run.code, run.all).toBe(0);
    expect(run.out).toContain('RELEVANT');
  });
});

describe('--json（机器可读）', () => {
  it('输出可解析的单个 JSON 文档，字段齐备', async () => {
    seedDocs();
    const path = seedMirror('be/kafka-ops.md', `---\ntitle: Kafka 运维手册\ntags: [消息队列]\n---\n\n第一行\n${SECRET_BODY}\n第三行\n`);
    const run = await recall('kafka 消息队列', { json: true });
    expect(run.code, run.all).toBe(0);
    const doc = JSON.parse(run.out) as {
      query: string;
      terms: string[];
      scanned: number;
      threshold: number;
      score: number;
      relevant: boolean;
      results: Array<{ path: string; kind: string; title: string; score: number; line: number; contextStart: number; context: string[]; terms: string[] }>;
    };
    expect(doc.query).toBe('kafka 消息队列');
    expect(doc.terms).toEqual(['kafka', '消息队列']);
    expect(doc.scanned).toBe(1);
    expect(doc.threshold).toBe(RELEVANCE_THRESHOLD);
    expect(doc.relevant).toBe(true);
    // kafka：标题 3 + 正文 1；消息队列：tags 2
    expect(doc.score).toBe(6);
    const [hit] = doc.results;
    expect(hit?.path).toBe(path);
    expect(hit?.kind).toBe('docs');
    expect(hit?.title).toBe('Kafka 运维手册');
    expect(hit?.score).toBe(6);
    expect(hit?.terms).toEqual(['kafka', '消息队列']);
    expect(hit?.context).toContain(SECRET_BODY);
    expect(hit?.line).toBeGreaterThan(0);
    expect(hit?.contextStart).toBeLessThanOrEqual(hit?.line ?? 0);
  });

  it('无命中时 results 是空数组而不是缺字段', async () => {
    seedDocs();
    seedMirror('a.md', '---\ntitle: 甲\n---\n\n正文\n');
    const run = await recall('不存在的词', { json: true });
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.out) as { results: unknown[]; score: number; relevant: boolean };
    expect(doc.results).toEqual([]);
    expect(doc.score).toBe(0);
    expect(doc.relevant).toBe(false);
  });
});

describe('镜像还不存在（还没 pull 过）', () => {
  it('默认形态：提示镜像不存在并指到 pull，退出码 0（这不是错误状态）', async () => {
    const run = await recall('kafka');
    expect(run.code, run.all).toBe(0);
    expect(run.out).toContain('团队知识镜像还不存在');
    expect(run.out).toContain(knowledgeDocsDir(env));
    expect(run.out).toContain('ejdrone pull');
  });

  it('--check 同样退出码 0：没有镜像时不做相关与否的判定，也不拦调用方', async () => {
    const run = await recall('kafka', { check: true });
    expect(run.code, run.all).toBe(0);
    expect(run.out).not.toMatch(/RELEVANT/);
    expect(run.out).toContain('团队知识镜像还不存在');
  });

  it('--json 带 unprepared 标记，退出码 0', async () => {
    const run = await recall('kafka', { json: true });
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.out) as { unprepared: boolean; results: unknown[]; missingRoots: string[] };
    expect(doc.unprepared).toBe(true);
    expect(doc.results).toEqual([]);
    expect(doc.missingRoots).toEqual([knowledgeDocsDir(env), knowledgeLearningsDir(env)]);
  });

  it('镜像目录存在但一份文档都没有：不是"还没 pull"，按空结果处理', async () => {
    seedDocs();
    const run = await recall('kafka');
    expect(run.code, run.all).toBe(0);
    expect(run.out).toContain('没有命中');
    expect(run.out).not.toContain('团队知识镜像还不存在');
  });
});
