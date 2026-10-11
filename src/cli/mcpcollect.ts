import { defFromLocalEntry, scanLocalMcp, type LocalMcpEntry } from './mcpscan.js';
import { entryShapeExample, externalizeSecrets, mcpRepoFile, type SecretRewrite } from './mcprepo.js';
import type { CliContext } from './context.js';
import type { McpServerDef } from '../core/types.js';
import { isValidResourceName } from './constants.js';

/**
 * `push --mcp <name>` 的采集环节：本机各工具的原生 MCP 配置 → 一条仓库 `McpServerDef`。
 * 只做"采集 + 判歧义 + 疑似密钥改写"，不碰仓库文件（写文件在 push.ts 的 MR 管线里）。
 */

export interface McpCollectedItem {
  name: string;
  def: McpServerDef;
  /** 采集来源（工具 id + 落点路径），用于"待推送"清单 */
  origins: string[];
  rewrites: SecretRewrite[];
  /** 本地条目里有、但仓库形状装不下的字段名（入库会少掉，必须点名） */
  dropped: string[];
}

export interface McpCollectOutcome {
  ok: boolean;
  items: McpCollectedItem[];
  /** 面向人的错误行（已排好顺序，调用方直接逐行 ctx.err） */
  errors: string[];
  notes: string[];
}

/** 递归排键的比较用文本：两处工具里的同一 server 只差键序不算"内容不同"。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function originLabel(entry: LocalMcpEntry): string {
  return `${entry.agent}：${entry.file}`;
}

function shapeExample(file: string): string[] {
  return [
    `下一步：手写进团队仓库的 ${file}（照下面的形状，凭据写成 \${VAR}），提 MR 后合入：`,
    entryShapeExample(),
  ];
}

export function collectMcpDefs(
  ctx: CliContext,
  agentIds: string[],
  names: string[],
  /** 目标仓库文件（错误文案里要指到成员该写的那个文件，而不是硬说根文件） */
  repoFile = mcpRepoFile(''),
): McpCollectOutcome {
  const errors: string[] = [];
  const notes: string[] = [];
  const items: McpCollectedItem[] = [];

  const scan = scanLocalMcp(ctx.home, ctx.env, agentIds);
  for (const note of scan.notes) notes.push(note);

  for (const name of names) {
    if (!isValidResourceName(name)) {
      errors.push(`server 名「${name}」不合法：仓库与工具两侧都只接受小写字母、数字、-、_（首字符不能是 -）`);
      continue;
    }

    const candidates = scan.entries.filter((e) => e.name === name);
    if (candidates.length === 0) {
      errors.push(
        `在选定工具（${agentIds.join(', ') || '无'}）的用户级 MCP 落点里找不到 server「${name}」`,
        ...shapeExample(repoFile),
      );
      continue;
    }

    const collectable = candidates.filter((c) => c.collectable);
    if (collectable.length === 0) {
      // 决定 1：TOML（codex config.toml）不做反向解析，只点名它的存在
      errors.push(
        `server「${name}」只在 TOML 形态的落点里（${candidates.map((c) => c.file).join('、')}），不做反向解析`,
        '原因：投递时对 TOML 只做受控的表块拼接，故意没有完整解析器；为 push 补一个就是把它请回来',
        ...shapeExample(repoFile),
      );
      continue;
    }

    const decoded: Array<{ entry: LocalMcpEntry; def: McpServerDef; dropped: string[] }> = [];
    for (const entry of collectable) {
      const parsed = defFromLocalEntry(entry);
      if (parsed.error || !parsed.def) {
        notes.push(`提示：${originLabel(entry)} 里的「${name}」没能采集：${parsed.error}`);
        continue;
      }
      const dropped = parsed.dropped ?? [];
      if (dropped.length > 0) {
        notes.push(
          `提示：${originLabel(entry)} 里的「${name}」有本地字段不会入库（${dropped.join(', ')}）—— 它们是该工具自己的开关，不属于团队清单`,
        );
      }
      decoded.push({ entry, def: parsed.def, dropped });
    }
    if (decoded.length === 0) {
      errors.push(`server「${name}」在 ${collectable.length} 个落点里都认不出条目形状，见上面的提示`);
      continue;
    }

    // 疑似密钥 → ${VAR}（决定 2）。改写后再比较，"一处明文一处占位符"不该算成两条不同的 server。
    const byText = new Map<
      string,
      { def: McpServerDef; origins: string[]; rewrites: SecretRewrite[]; dropped: string[] }
    >();
    for (const { entry, def, dropped } of decoded) {
      const scanned = externalizeSecrets(def, name, ctx.env);
      if (scanned.blocked.length > 0) {
        errors.push(
          `server「${name}」（${originLabel(entry)}）里疑似直接写了凭据：${scanned.blocked.map((b) => `${b.field} —— ${b.reason}`).join('；')}。不自动改写、也不提交明文`,
          `原因：把整条命令或整个 URL 换成 \${VAR} 会连地址一起吞掉，只有作者知道该怎么拆`,
          ...shapeExample(repoFile),
        );
        byText.clear();
        break;
      }
      const key = canonical(scanned.def);
      const existing = byText.get(key);
      if (existing) {
        existing.origins.push(originLabel(entry));
        continue;
      }
      byText.set(key, {
        def: scanned.def,
        origins: [originLabel(entry)],
        rewrites: scanned.rewrites,
        dropped,
      });
    }
    const groups = [...byText.values()];
    if (groups.length === 0) continue;
    if (groups.length > 1) {
      // 不许猜：同名不同内容时把每一处点名，让成员用 --agent 缩范围
      errors.push(
        `server「${name}」在 ${groups.length} 个落点里内容不同：`,
        ...groups.map((g) => `  - ${g.origins.join('、')}`),
        '下一步：加 --agent <工具 id> 指明从哪个工具采集（例如 --agent claude）',
      );
      continue;
    }

    const group = groups[0];
    if (!group) continue;
    items.push({ name, def: group.def, origins: group.origins, rewrites: group.rewrites, dropped: group.dropped });
  }

  return { ok: errors.length === 0 && items.length > 0, items, errors, notes };
}
