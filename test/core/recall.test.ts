import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTEXT_LINES,
  RELEVANCE_THRESHOLD,
  RESULT_LIMIT,
  WEIGHT_BODY,
  WEIGHT_TAGS,
  WEIGHT_TITLE,
  contextLines,
  parseDoc,
  rankDocs,
  recallDocs,
  scanMirror,
  scoreDoc,
  splitTerms,
  topScore,
  type RecallDoc,
} from '../../src/core/recall.js';
import { knowledgeDocsDir, knowledgeLearningsDir } from '../../src/state.js';

/**
 * M8 / T8.1：recall 的扫描与打分。
 *
 * 三条会被"顺手优化"打破的东西，都在这里钉住：
 * 1. 权重是**字段可信度**而不是频次：标题 ×3 > tags ×2 > 正文 ×1，同一条 term 在每个字段只计一次；
 * 2. 扫描范围**只有投递镜像** `~/.ejdrone/knowledge/{docs,learnings}` —— 镜像里没有的（未激活
 *    namespace 的文档）检索不到，这是角色裁剪唯一的可见证据；
 * 3. 无索引、无副作用：同一次调用只读磁盘，符号链接一律不跟随（读范围不许跳出镜像根）。
 */

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-recall-'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

/** 伪造 HOME + EJDRONE_HOME（绝不用真实 HOME，见 AGENTS.md 硬规则）。 */
function makeEnv(tag: string): NodeJS.ProcessEnv {
  const home = join(root, tag);
  mkdirSync(home, { recursive: true });
  return { HOME: home, EJDRONE_HOME: join(home, '.ejdrone') };
}

function mirrorDir(env: NodeJS.ProcessEnv, rel: string): string {
  const dir = join(knowledgeDocsDir(env), rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMirrorDoc(env: NodeJS.ProcessEnv, rel: string, content: string): string {
  const dir = mirrorDir(env, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const path = join(dir, rel.slice(rel.lastIndexOf('/') + 1));
  writeFileSync(path, content, 'utf8');
  return path;
}

function learningsDir(env: NodeJS.ProcessEnv, rel: string): string {
  const dir = join(knowledgeLearningsDir(env), rel);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function doc(content: string, path = '/mirror/docs/sample.md'): RecallDoc {
  return parseDoc(path, content, 'docs');
}

describe('splitTerms', () => {
  it('按空白拆词、转小写、去重且保序', () => {
    expect(splitTerms('Deploy  deploy 灰度发布')).toEqual(['deploy', '灰度发布']);
    expect(splitTerms('   ')).toEqual([]);
  });
});

describe('打分权重（标题 ×3 / tags ×2 / 正文 ×1）', () => {
  const term = 'release';

  const titleDoc = doc(`---\ntitle: Release playbook\ntags: [deploy]\n---\n\n正文不提这个词。\n`, '/m/a.md');
  const tagsDoc = doc(`---\ntags: [release, deploy]\n---\n\n正文也不提。\n`, '/m/b.md');
  const bodyDoc = doc(`---\ntitle: 发布手册\n---\n\n这一篇正文里有 release 一次。\n`, '/m/c.md');

  it('三个权重常量就是计划里冻结的那三个乘子', () => {
    expect({ WEIGHT_TITLE, WEIGHT_TAGS, WEIGHT_BODY }).toEqual({ WEIGHT_TITLE: 3, WEIGHT_TAGS: 2, WEIGHT_BODY: 1 });
  });

  it('同一个词命中不同字段得到不同分数，且能真的把顺序拉开', () => {
    expect(scoreDoc(titleDoc, [term]).score).toBe(3);
    expect(scoreDoc(tagsDoc, [term]).score).toBe(2);
    expect(scoreDoc(bodyDoc, [term]).score).toBe(1);
    const ranked = rankDocs([bodyDoc, tagsDoc, titleDoc], term);
    expect(ranked.map((r) => r.path)).toEqual(['/m/a.md', '/m/b.md', '/m/c.md']);
    expect(ranked.map((r) => r.score)).toEqual([3, 2, 1]);
  });

  it('同一词在正文里出现多次也只计一次：权重表达字段可信度，不是频次', () => {
    const noisy = doc(`---\ntitle: 无关标题\n---\n\nrelease release release release\n`, '/m/noisy.md');
    expect(scoreDoc(noisy, [term]).score).toBe(1);
  });

  it('多词 query 的分数按字段逐项累加', () => {
    const both = doc(`---\ntitle: Release flow\n---\n\n灰度发布要看 rollback 章节。\n`, '/m/d.md');
    expect(scoreDoc(both, ['release', 'rollback']).score).toBe(3 + 1);
    expect(scoreDoc(both, ['release', 'rollback']).terms).toEqual(['release', 'rollback']);
  });

  it('tags 支持行内列表、块列表与逗号标量三种写法', () => {
    const inline = doc('---\ntags: [kafka, 消息队列]\n---\n\n正文\n', '/m/i.md');
    const block = doc('---\ntags:\n  - kafka\n  - 消息队列\n---\n\n正文\n', '/m/b2.md');
    const scalar = doc('---\ntags: kafka, 消息队列\n---\n\n正文\n', '/m/s.md');
    for (const d of [inline, block, scalar]) {
      expect(d.tags).toEqual(['kafka', '消息队列']);
      expect(scoreDoc(d, ['kafka']).score).toBe(2);
    }
  });

  it('无命中的文档不进了结果集', () => {
    expect(rankDocs([doc('---\ntitle: 无关\n---\n\nnothing here\n')], 'kafka')).toEqual([]);
  });
});

describe('CJK 与中英混合 query', () => {
  it('子串匹配让中文词不需要词边界就命中', () => {
    const zh = doc('---\ntitle: 灰度发布流程说明\n---\n\n先切 5% 流量。\n', '/m/zh.md');
    expect(scoreDoc(zh, ['灰度发布']).score).toBe(3);
  });

  it('只在标题命中时，片段退成正文开头预览（把 `title:` 那行当上下文没有信息量）', () => {
    const zh = doc('---\ntitle: 灰度发布流程说明\n---\n\n先切 5% 流量。\n', '/m/zh.md');
    const [hit] = rankDocs([zh], '灰度发布');
    expect(hit?.line).toBe(4);
    // 中心行上下各 2 行照旧取，因此预览会带上前面的围栏行 —— 成员要看的是正文第一行，不是空信息
    expect(hit?.context).toEqual(['title: 灰度发布流程说明', '---', '', '先切 5% 流量。', '']);
    expect(hit?.terms).toEqual(['灰度发布']);
  });

  it('中英混排的一条 query 里两种词各走各的字段', () => {
    const mixed = doc('---\ntitle: Kafka 消费积压排查\ntags: [消息队列]\n---\n\nlag 超过阈值要重启消费者。\n', '/m/m.md');
    expect(scoreDoc(mixed, ['kafka']).score).toBe(3);
    expect(scoreDoc(mixed, ['消息队列']).score).toBe(2);
    expect(scoreDoc(mixed, ['lag']).score).toBe(1);
    expect(scoreDoc(mixed, splitTerms('Kafka 消息队列 lag')).score).toBe(6);
    // 整串当一个词时不命中：query 必须先经 splitTerms，中文短语因此仍走子串匹配
    expect(scoreDoc(mixed, ['kafka 消息队列 lag']).score).toBe(0);
  });
});

describe('title 的回退链与坏 frontmatter', () => {
  it('frontmatter title → 首个 # 标题 → 文件名', () => {
    expect(doc('---\ntitle: 甲\n---\n\n# 乙\n', '/m/x.md').title).toBe('甲');
    expect(doc('# 乙\n\n正文\n', '/m/x.md').title).toBe('乙');
    expect(doc('没有标题也没有围栏\n', '/m/deploy-notes.md').title).toBe('deploy-notes');
  });

  it('frontmatter YAML 写坏：不抛错，正文照样能被命中（缺的只是 tags 加权）', () => {
    const broken = doc('---\ntitle: [坏掉的 YAML\n  tags: }}}\n---\n\n这里讲 canary 发布。\n', '/m/broken.md');
    expect(broken.tags).toEqual([]);
    expect(scoreDoc(broken, ['canary']).score).toBe(1);
  });

  it('只有起始围栏没有结束围栏时整篇当正文，不误吞内容', () => {
    const fence = doc('---\n正文里的分隔线之前没结束围栏\n', '/m/f.md');
    expect(fence.body).toContain('正文里的分隔线');
  });
});

describe('命中片段（路径 + 命中行 ±2 行）', () => {
  const content = ['一行', '二行', '三行', '这里有 kafka', '五行', '六行', '七行'].join('\n') + '\n';

  it('中心行上下各取 CONTEXT_LINES 行', () => {
    const d = doc(content, '/m/k.md');
    const [hit] = rankDocs([d], 'kafka');
    expect(hit).toBeDefined();
    expect(hit?.line).toBe(4);
    expect(hit?.contextStart).toBe(2);
    expect(hit?.context).toEqual(['二行', '三行', '这里有 kafka', '五行', '六行']);
    expect(hit?.context.length).toBe(CONTEXT_LINES * 2 + 1);
  });

  it('命中行靠近文件开头时片段被截短、不越界', () => {
    const [hit] = rankDocs([doc('a\nkafka here\nb\nc\n', '/m/k2.md')], 'kafka');
    expect(hit?.line).toBe(2);
    expect(hit?.contextStart).toBe(1);
    expect(hit?.context).toEqual(['a', 'kafka here', 'b', 'c']);
  });

  it('contextLines 对空文件返回空数组', () => {
    expect(contextLines([], 0)).toEqual([]);
  });
});

describe('结果条数与前 5 的门槛', () => {
  function many(dir: string, count: number): void {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      writeFileSync(join(dir, `doc-${String(i).padStart(2, '0')}.md`), `---\ntitle: kafka note ${i}\n---\n\n正文\n`, 'utf8');
    }
  }

  it('最多返回 RESULT_LIMIT 条，同分按路径字典序（两台机器给同一个顺序）', () => {
    const env = makeEnv('limit');
    mirrorDir(env, '');
    many(knowledgeDocsDir(env), 8);
    const outcome = recallDocs(env, 'kafka');
    expect(outcome.results.length).toBe(RESULT_LIMIT);
    expect(RESULT_LIMIT).toBe(5);
    expect(outcome.results.map((r) => r.path)).toEqual(
      [...outcome.results.map((r) => r.path)].sort((a, b) => (a < b ? -1 : 1)),
    );
  });

  it('--check 的分数看的是全场最高分，不受前 5 条截断影响', () => {
    const docs = Array.from({ length: 9 }, (_, i) =>
      doc(`---\ntitle: kafka ${i}\n---\n\n额外一次 kafka kafka\n`, `/m/d${i}.md`),
    );
    expect(rankDocs(docs, 'kafka').length).toBe(5);
    expect(topScore(docs, 'kafka')).toBe(scoreDoc(docs[0] as RecallDoc, ['kafka']).score);
  });

  it('门槛默认 2：只命中一次正文不够，命中 tags 或标题就够', () => {
    expect(RELEVANCE_THRESHOLD).toBe(2);
    const env = makeEnv('threshold');
    writeMirrorDoc(env, 'weak.md', '---\ntitle: 无关\n---\n\n只在正文提了一次 zookeeper\n');
    expect(recallDocs(env, 'zookeeper').relevant).toBe(false);
    writeMirrorDoc(env, 'strong.md', '---\ntitle: zookeeper 运维\n---\n\n正文\n');
    expect(recallDocs(env, 'zookeeper').relevant).toBe(true);
  });
});

describe('scanMirror：只读镜像目录，且不跟着符号链接走出去', () => {
  it('镜像目录还不存在 → missingRoots 报出两个根、scanned=0（"还没 pull 过"的判据）', () => {
    const env = makeEnv('absent');
    const scan = scanMirror(env);
    expect(scan.docs).toEqual([]);
    expect(scan.missingRoots).toEqual([knowledgeDocsDir(env), knowledgeLearningsDir(env)]);
    const outcome = recallDocs(env, 'kafka');
    expect(outcome.scanned).toBe(0);
    expect(outcome.missingRoots.length).toBe(2);
  });

  it('docs 与 learnings 两个根都扫，kind 标注正确', () => {
    const env = makeEnv('both');
    mirrorDir(env, '');
    learningsDir(env, '');
    writeFileSync(join(knowledgeDocsDir(env), 'arch.md'), '---\ntitle: kafka 架构\n---\n\n正文\n', 'utf8');
    writeFileSync(join(knowledgeLearningsDir(env), '2026-10-11-kafka.md'), '---\ntitle: 踩坑\n---\n\nkafka 也要提一句\n', 'utf8');
    const scan = scanMirror(env);
    expect(scan.docs.map((d) => d.kind).sort()).toEqual(['docs', 'learnings']);
    const outcome = recallDocs(env, 'kafka');
    expect(outcome.results.map((r) => r.kind).sort()).toEqual(['docs', 'learnings']);
    expect(outcome.results[0]?.path).toContain('knowledge');
  });

  it('非 .md 与嵌套目录里的 .md 都按形状处理：非 md 跳过、子目录递归收', () => {
    const env = makeEnv('shape');
    const nested = mirrorDir(env, 'be');
    writeFileSync(join(knowledgeDocsDir(env), 'README.txt'), 'kafka 在 txt 里，不该被扫', 'utf8');
    writeFileSync(join(nested, 'db.md'), '---\ntitle: kafka 笔记\n---\n\n正文\n', 'utf8');
    const outcome = recallDocs(env, 'kafka');
    expect(outcome.scanned).toBe(1);
    expect(outcome.results[0]?.path).toBe(join(nested, 'db.md'));
  });

  it('符号链接（含指向镜像目录之外的）一律不跟随、不检索', () => {
    const env = makeEnv('symlink');
    mirrorDir(env, '');
    const outside = join(root, 'outside-secret.md');
    writeFileSync(outside, '---\ntitle: kafka 泄漏\n---\n\n正文\n', 'utf8');
    symlinkSync(outside, join(knowledgeDocsDir(env), 'link.md'));
    const dirOutside = join(root, 'outside-dir');
    mkdirSync(dirOutside, { recursive: true });
    writeFileSync(join(dirOutside, 'deep.md'), '---\ntitle: kafka 目录泄漏\n---\n\n正文\n', 'utf8');
    symlinkSync(dirOutside, join(knowledgeDocsDir(env), 'sub'));
    const scan = scanMirror(env);
    expect(scan.docs).toEqual([]);
    expect(recallDocs(env, 'kafka').results).toEqual([]);
  });

  it('检索只命中镜像里存在的那份：未激活 namespace 的文档压根不在盘上', () => {
    const env = makeEnv('active-ns');
    const be = mirrorDir(env, 'be');
    writeFileSync(join(be, 'db.md'), '---\ntitle: 数据库变更规范\ntags: [mysql]\n---\n\n改库要写迁移。\n', 'utf8');
    // fe 角色的文档没被投进镜像（pull 按角色裁剪的结果）
    expect(recallDocs(env, '数据库').results.map((r) => r.path)).toEqual([join(be, 'db.md')]);
    expect(recallDocs(env, '组件拆分').results).toEqual([]);
    expect(recallDocs(env, '数据库').scanned).toBe(1);
  });
});
