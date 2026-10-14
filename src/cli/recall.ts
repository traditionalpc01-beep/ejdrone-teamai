import { CONTEXT_LINES, RELEVANCE_THRESHOLD, recallDocs, RESULT_LIMIT, type RecallMatch } from '../core/recall.js';
import type { RecallOutcome } from '../core/recall.js';
import type { CliContext } from './context.js';

/**
 * `ejdrone recall "<query>" [--check] [--json]`（M8 / T8.2）。
 *
 * 三种输出形态对应三类消费者，彼此的**约定强度**不同，别互相串味：
 *
 * - 默认（给人看）：路径 + 命中行 ±2 行上下文，最多 5 条。人靠上下文判断"这份是不是我要的"，
 *   所以宁可多印几行，也不印一份摘要 —— 摘要要么靠模型要么靠启发式，两者都会在这里说谎。
 * - `--check`（给 hook / skill 做预检）：**一行**，`RELEVANT score=<n> threshold=<n>` 或
 *   `NOT_RELEVANT ...`，退出码 0/1。绝不打印正文 —— 调用方是自动跑的，任何额外输出都会污染
 *   它的解析；这条语义与 teamai 的 `--check` 对齐（§7.1），差别是我们**不投票、不写日志**（§2 不做表）。
 * - `--json`（给脚本/CI）：机器可读，字段与内部结构同名，不夹人类可读的装饰行。
 *
 * 命令层零写入：只做读与排版，扫描与打分全在 `core/recall.ts`。
 */

export interface RecallCommandOptions {
  check?: boolean;
  json?: boolean;
}

/** 镜像一个根都不存在 = 这台机器还没 pull 过（或团队仓库里没有 docs/learnings）。 */
function isUnprepared(outcome: RecallOutcome): boolean {
  return outcome.scanned === 0 && outcome.missingRoots.length > 0;
}

function renderHit(ctx: CliContext, index: number, match: RecallMatch): void {
  ctx.out(`${index}) ${match.path}  [${match.kind}]  score=${match.score}`);
  ctx.out(`     标题：${match.title}`);
  match.context.forEach((line, offset) => {
    const no = match.contextStart + offset;
    // 命中那一行用 '>' 占住行号槽：终端里一眼能看到中心行在哪
    const mark = no === match.line ? '>' : ' ';
    ctx.out(`   ${mark} ${String(no).padStart(4)} | ${line}`);
  });
}

export async function recallCommand(
  ctx: CliContext,
  query: string | undefined,
  options: RecallCommandOptions = {},
): Promise<number> {
  const text = (query ?? '').trim();
  if (text === '') {
    ctx.err('错误：recall 需要一个检索词。');
    ctx.err('下一步：ejdrone recall "<关键词>"（多个词用空格分隔；--check 做预检，--json 给脚本用）');
    return 1;
  }

  const outcome = recallDocs(ctx.env, text, { limit: RESULT_LIMIT, threshold: RELEVANCE_THRESHOLD });

  // 「还没 pull 过」不是错误状态，也不是一条"不相关"的判定：镜像根本没建起来时，
  // 判 NOT_RELEVANT 会让调用方以为团队没有相关内容，判 RELEVANT 又是在凭空放行。
  // 所以这条路径只出一句提示、恒返回 0（预检场景等于"不拦你"），`--check`/`--json` 同样走这里。
  if (isUnprepared(outcome)) {
    // 报第一个缺失的镜像根（docs 在前）：成员照着这条路径去找目录，docs 才是他期望看到东西的那个。
    const where = outcome.missingRoots[0] ?? '';
    if (options.json) {
      ctx.out(JSON.stringify({ ...outcome, results: [], relevant: false, unprepared: true }, null, 2));
      return 0;
    }
    ctx.out(`提示：团队知识镜像还不存在（${where}），看起来还没 pull 过。`);
    ctx.out('下一步：先 ejdrone pull 同步团队仓库，再检索；仓库里没写 docs/ 时这条提示也会一直在。');
    return 0;
  }

  if (options.check) {
    ctx.out(
      `${outcome.relevant ? 'RELEVANT' : 'NOT_RELEVANT'} score=${outcome.score} threshold=${outcome.threshold}`,
    );
    return outcome.relevant ? 0 : 1;
  }

  if (options.json) {
    ctx.out(JSON.stringify(outcome, null, 2));
    return 0;
  }

  if (outcome.results.length === 0) {
    ctx.out(`没有命中「${text}」（已扫描 ${outcome.scanned} 份团队知识文档）。`);
    ctx.out('下一步：换更短或更通用的关键词再试一次，或 ejdrone list docs 看团队都有些什么文档。');
    return 0;
  }

  ctx.out(`命中 ${outcome.results.length} 份（共扫描 ${outcome.scanned} 份，显示前 ${RESULT_LIMIT} 份，命中行上下各 ${CONTEXT_LINES} 行）：`);
  outcome.results.forEach((match, index) => renderHit(ctx, index + 1, match));
  if (outcome.relevant) {
    ctx.out('提示：以上按相关度排序（标题 ×3、tags ×2、正文 ×1）；动手前先读第 1 份。');
  } else {
    ctx.out(`提示：最高分 ${outcome.score} 未过预检门槛 ${outcome.threshold}，多半只是顺带提到，未必是你要找的那份。`);
  }
  return 0;
}
