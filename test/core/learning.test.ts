import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  learningFileName,
  learningPathTaken,
  learningRepoPath,
  normalizeLearning,
  slugify,
  RESERVED_LEARNINGS_NAMESPACE,
  SLUG_MAX_LENGTH,
} from '../../src/core/learning.js';
import type { Resource } from '../../src/core/types.js';

/**
 * M9 / T9.1：learning 文件的规范化（frontmatter 补全、slug 与文件名生成、撞名判据）。
 *
 * 冻结的偏差（父计划 §7.1）：
 * - teamai 必填 title/author/date/tags 且 tags 须 2–5 个否则拒绝 → 我们**能补则补、缺 tags 不拒绝**；
 * - teamai 文件名带 rand6 防同人同日撞名（孤儿分支追加写的需要）→ 我们走 MR，
 *   **目标已存在就拒绝并提示改名**，文件名保持可引用。
 */

/** 取出 frontmatter 的映射（测试断言用，不依赖实现的序列化细节）。 */
function frontmatterOf(content: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  expect(m, `内容应带完整 frontmatter 围栏：\n${content}`).toBeTruthy();
  return parseYaml(m?.[1] ?? '') as Record<string, unknown>;
}

const NOW = () => new Date(2026, 9, 12); // 本地时间 2026-10-12

describe('normalizeLearning：frontmatter 补全', () => {
  it('什么都没有的裸正文：标题取首个 # 标题，日期补当天，tags 留空不拒绝', () => {
    const r = normalizeLearning({ raw: '# Kafka 消费积压复盘\n\n重启消费者组前先清空测试 topic。\n', fileName: 'note.md', now: NOW });
    expect(r.title).toBe('Kafka 消费积压复盘');
    expect(r.date).toBe('2026-10-12');
    expect(r.tags).toEqual([]);
    const fm = frontmatterOf(r.content);
    expect(fm.title).toBe('Kafka 消费积压复盘');
    expect(fm.date).toBe('2026-10-12');
    expect(fm.tags).toEqual([]);
    // 正文一字不变地保留在围栏之后
    expect(r.content.endsWith('# Kafka 消费积压复盘\n\n重启消费者组前先清空测试 topic。\n')).toBe(true);
  });

  it('title 逐级回退：--title 覆盖 > frontmatter title > 首个 # 标题 > 文件名（去日期前缀）', () => {
    const byOverride = normalizeLearning({ raw: '# 甲\n\n正文\n', titleOverride: ' 覆盖的标题 ', now: NOW });
    expect(byOverride.title).toBe('覆盖的标题');

    const byFm = normalizeLearning({ raw: '---\ntitle: 库存标题\n---\n\n# 不该用的标题\n', now: NOW });
    expect(byFm.title).toBe('库存标题');

    const byHeading = normalizeLearning({ raw: '前言一行\n\n# 真标题\n\n正文\n', now: NOW });
    expect(byHeading.title).toBe('真标题');

    const byFile = normalizeLearning({ raw: '没有标题没有正文头\n', fileName: '2026-10-01-灰度踩坑.md', now: NOW });
    expect(byFile.title).toBe('灰度踩坑');
    // 文件名里的日期被用上：不落在 frontmatter 也不落 --title 时回退文件名，再退当天
    expect(byFile.date).toBe('2026-10-01');
    const today = normalizeLearning({ raw: 'x\n', fileName: '随手记.md', now: NOW });
    expect(today.title).toBe('随手记');
    expect(today.date).toBe('2026-10-12');
  });

  it('date 逐级回退：frontmatter 日期 > 文件名日期前缀 > 当天；frontmatter 写坏的值不采信', () => {
    const fmDate = normalizeLearning({ raw: '---\ndate: 2025-01-05\n---\n\n# 甲\n', fileName: '2026-10-01-y.md', now: NOW });
    expect(fmDate.date).toBe('2025-01-05');

    const fileNameDate = normalizeLearning({ raw: '# 甲\n', fileName: '2026-03-09-y.md', now: NOW });
    expect(fileNameDate.date).toBe('2026-03-09');

    const bogus = normalizeLearning({ raw: '---\ndate: 昨天\n---\n\n# 甲\n', now: NOW });
    expect(bogus.date).toBe('2026-10-12');
  });

  it('tags 三种写法都认（YAML 列表、逗号标量、单值），去重去空；缺 tags 不拒绝', () => {
    const list = normalizeLearning({ raw: '---\ntitle: 甲\ntags: [kafka, 发布, kafka]\n---\n\n正文\n', now: NOW });
    expect(list.tags).toEqual(['kafka', '发布']);

    const scalar = normalizeLearning({ raw: '---\ntitle: 甲\ntags: kafka, 发布 ,,\n---\n\n正文\n', now: NOW });
    expect(scalar.tags).toEqual(['kafka', '发布']);

    const single = normalizeLearning({ raw: '---\ntitle: 甲\ntags: kafka\n---\n\n正文\n', now: NOW });
    expect(single.tags).toEqual(['kafka']);
  });

  it('保留成员写的其他 frontmatter 字段（author 等），只规范化 title/date/tags', () => {
    const r = normalizeLearning({ raw: '---\ntitle: 甲\nauthor: 张三\ncontext: 上线事故\n---\n\n正文\n', now: NOW });
    const fm = frontmatterOf(r.content);
    expect(fm.author).toBe('张三');
    expect(fm.context).toBe('上线事故');
    expect(fm.title).toBe('甲');
  });

  it('坏 YAML 的 frontmatter：告警、丢弃坏字段、正文保住并重建 frontmatter（不是拒绝）', () => {
    const r = normalizeLearning({ raw: '---\ntitle: [未闭合\n---\n\n# 正文里的标题\n\n踩坑过程。\n', fileName: 'x.md', now: NOW });
    expect(r.warning, '坏 YAML 必须给告警').toBeTruthy();
    expect(r.title).toBe('正文里的标题');
    expect(r.content).toContain('踩坑过程。');
    expect(r.content.startsWith('---\n')).toBe(true);
  });

  it('正文尾部换行规范化为恰好一个；空正文只剩 frontmatter', () => {
    const r = normalizeLearning({ raw: '# 甲\n\n正文\n\n\n', now: NOW });
    expect(r.content.endsWith('正文\n')).toBe(true);
    expect(r.content.endsWith('\n\n')).toBe(false);
  });

  it('二次规范化幂等：normalize 的输出再喂回来，title/date/tags 与正文都不再变', () => {
    const first = normalizeLearning({ raw: '# Kafka 复盘\n\n正文\n', fileName: 'n.md', now: NOW });
    const second = normalizeLearning({ raw: first.content, fileName: 'n.md', now: NOW });
    expect(second.title).toBe(first.title);
    expect(second.date).toBe(first.date);
    expect(second.tags).toEqual(first.tags);
    expect(second.content).toBe(first.content);
  });
});

describe('slugify：中文可用、长度受限、路径不安全字符剔除', () => {
  it('CJK 原样保留，空白转 -，ASCII 转小写', () => {
    expect(slugify('Kafka 消费积压 复盘')).toBe('kafka-消费积压-复盘');
    expect(slugify('灰度发布')).toBe('灰度发布');
  });

  it('剔除路径与文件名不安全字符（斜杠转连字符，冒号/引号/星号/问号/尖括号/竖线直接删）', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('A:B/C?D*E"F<G>|H')).toBe('ab-cdefgh');
  });

  it('首尾的 -、. 去掉，内部点保留；折叠连续分隔符', () => {
    expect(slugify('--你好--世界--')).toBe('你好-世界');
    expect(slugify('.隐藏文件.')).toBe('隐藏文件');
    expect(slugify('v1.0 发布'))
      .toBe('v1.0-发布');
    expect(slugify('a  /  b')).toBe('a-b');
  });

  it('长度封顶（SLUG_MAX_LENGTH），截断处不留悬挂分隔符', () => {
    const long = slugify('很'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(long.endsWith('-')).toBe(false);
    const longMixed = slugify(`kafka ${'积'.repeat(100)}`);
    expect(longMixed.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
  });

  it('整串都被剔光的标题返回空串，由 learningFileName 兜底', () => {
    expect(slugify('///')).toBe('');
    expect(learningFileName('///', '2026-10-12')).toBe('2026-10-12-learning.md');
  });

  it('learningFileName = 日期 + slug；learningRepoPath 带 ns 时多一层目录', () => {
    const f = learningFileName('Kafka 消费积压复盘', '2026-10-12');
    expect(f).toBe('2026-10-12-kafka-消费积压复盘.md');
    expect(learningRepoPath('', f)).toBe('learnings/2026-10-12-kafka-消费积压复盘.md');
    expect(learningRepoPath('be', f)).toBe('learnings/be/2026-10-12-kafka-消费积压复盘.md');
  });
});

describe('learningPathTaken：目标已存在 = 拒绝（不加 rand6）', () => {
  const entry = (name: string, namespace: string): Resource => ({
    kind: 'learnings',
    namespace,
    name,
    files: { content: '' },
  });
  // collectFlatMd（qualifiedName=true）的形状：根条目 name 不带 ns 段，ns 条目带
  const learnings = [entry('2026-10-12-甲', ''), entry('be/2026-10-12-乙', 'be')];

  it('根与 ns 各自按自己的目录比，不误伤另一处', () => {
    expect(learningPathTaken(learnings, '', '2026-10-12-甲.md')).toBe(true);
    expect(learningPathTaken(learnings, 'be', '2026-10-12-乙.md')).toBe(true);
    expect(learningPathTaken(learnings, 'be', '2026-10-12-甲.md')).toBe(false);
    expect(learningPathTaken(learnings, '', '2026-10-12-乙.md')).toBe(false);
    expect(learningPathTaken(learnings, '', '2026-10-13-丙.md')).toBe(false);
  });

  it('保留名 team-codebase 在常量里点名（contribute 侧据此拒绝，采集层会整目录跳过）', () => {
    expect(RESERVED_LEARNINGS_NAMESPACE).toBe('team-codebase');
  });
});
