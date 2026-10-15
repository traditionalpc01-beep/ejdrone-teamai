import { loadLedger } from '../core/ledger.js';
import { allResources } from '../core/types.js';
import { BLOCK_RESOURCE_KEY } from '../agents/block.js';
import { ledgerPath } from '../state.js';
import type { Config, Ledger } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { buildDelivery, type Delivery } from './delivery.js';
import { auditLedger, type LedgerAudit } from './ledgercheck.js';
import { scanLocalAgents } from './local.js';
import { scanLocalMcp, type LocalMcpEntry } from './mcpscan.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

export async function statusCommand(ctx: CliContext): Promise<number> {
  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  ctx.out(`仓库：${config.repo}（provider=${config.provider}）`);
  ctx.out(`角色：主=${config.primaryRole ?? '（无，只下发根条目）'} 附加=${config.additionalRoles.join(', ') || '（无）'}`);
  ctx.out(`工具：${config.agents.join(', ') || '（未选定）'}`);

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络后重跑 ejdrone status；离线时可用 ejdrone list --source local');
    return 1;
  }
  const snapshot = loaded.snapshot;

  if (snapshot.manifestError) {
    ctx.err(`错误：manifest/roles.yaml 无法解析，pull 会全量停发：${snapshot.manifestError}`);
    ctx.err(`下一步：修正 ${snapshot.dir}/manifest/roles.yaml`);
    return 1;
  }

  const delivery = buildDelivery(ctx, config, snapshot);
  for (const note of delivery.notes) ctx.out(`提示：${note}`);
  for (const conflict of delivery.conflicts) ctx.out(`冲突：${conflict}（该类型本次停发）`);
  for (const warning of snapshot.warnings) ctx.out(`提示：${warning}`);

  const ledgerFile = ledgerPath(ctx.env);
  const { ledger, warning } = loadLedger(ledgerFile);
  if (warning) ctx.out(`提示：${warning}`);
  const audit = auditLedger(ledger);

  // 空条目的 merge write（mcp 的 `mcp:<tool>-merge` 恒发那一条）是**清账指令**，不是"仓库有待投内容"：
  // 仓库没有可投 server 时它也每次都在 activeResources 里，若不滤掉，status 会永远显示一条
  // pull 完也消不掉的"落后"（apply 侧空 delivered 不落账，两边永远对不齐）。真正有 server 要投时
  // entries 非空，照常计入落后。
  const repoKeys = new Set(
    delivery.writes
      .filter((w) => !(w.merge && Object.keys(w.merge.entries).length === 0))
      // block 模式的合成键同理（2026-10-15 真实成员环境引出）：仓库没有任何 rules 时它是一条
      // content 为空的占位写，apply 层刻意不建 AGENTS.md 也不记账，不过滤就成了 pull 永远
      // 消不掉的一条"落后"。真有 rules 时 content 非空，照常计入。
      .filter((w) => !(w.resource === BLOCK_RESOURCE_KEY && w.content === ''))
      .map((w) => w.resource),
  );
  const deliveredKeys = new Set(ledger.entries.map((entry) => entry.resource));
  const behind = [...repoKeys].filter((key) => !deliveredKeys.has(key));

  const repoNames = new Set(allResources(snapshot.kinds).map((r) => `${r.kind}:${r.name}`));
  const { candidates } = scanLocalAgents(ctx, config.agents);
  const toPush = candidates.filter((c) => !repoNames.has(`${c.kind}:${c.name}`));

  ctx.out('');
  ctx.out(`待推送（本地有、仓库没有）：${toPush.length}`);
  for (const candidate of toPush) ctx.out(`  ${candidate.kind} ${candidate.name}（来自 ${candidate.agent}：${candidate.origin}）`);

  ctx.out(`落后（仓库有、本机还没投递）：${behind.length}`);
  for (const key of behind) ctx.out(`  ${key}`);
  if (behind.length > 0) ctx.out('  → 运行 ejdrone pull 拿到这些变更');

  ctx.out(`本地改过（pull 会保留你的版本并点名）：${audit.modified.length}`);
  for (const entry of audit.modified) ctx.out(`  ${entry.path}（${entry.resource}）`);

  if (audit.missing.length > 0) {
    ctx.out(`记账存在但文件已不在：${audit.missing.length}`);
    for (const entry of audit.missing) ctx.out(`  ${entry.path}（${entry.resource}）`);
  }

  mcpSection(ctx, config, delivery, ledger, audit, snapshot);

  ctx.out('');
  ctx.out(`快照 commit：${snapshot.head.slice(0, 12)}（分支 ${snapshot.branch}）`);
  return 0;
}

/**
 * MCP 一段话讲清三件事：仓库里有什么、本机哪些条目我们认领着、本机还有什么没入库。
 * 仓库和本地都空时整段跳过 —— 1.0 的仓库不该因为新 kinds 而多出一节无关输出。
 * 这里只出 server 名、工具 id 与文件路径：那些共享文件里可能写着明文 token。
 */
function mcpSection(
  ctx: CliContext,
  config: Config,
  delivery: Delivery,
  ledger: Ledger,
  audit: LedgerAudit,
  snapshot: Snapshot,
): void {
  const repoServers = snapshot.kinds.mcp;
  const scan = scanLocalMcp(ctx.home, ctx.env, config.agents);
  if (repoServers.length === 0 && scan.entries.length === 0 && snapshot.mcpFileError === null) return;

  ctx.out('');
  if (snapshot.mcpFileError !== null) {
    ctx.out(`MCP：本次停发（已装内容不动）：${snapshot.mcpFileError}`);
    ctx.out('  → 修好 mcp/mcp.yaml 后 ejdrone pull 会自动恢复下发');
    return;
  }
  ctx.out(`MCP：仓库 ${repoServers.length} 条；本机条目 ${ledgerManagedCount(ledger)} 条`);

  // 落后：本次计划里的条目还没进账本 = 本机那份配置里还没有这条 server
  const delivered = new Map<string, string>();
  for (const entry of ledger.entries) {
    for (const key of Object.keys(entry.managedKeys ?? {})) delivered.set(key, entry.path);
  }
  const behind = new Map<string, string[]>();
  for (const write of delivery.writes) {
    const entries = write.merge?.entries;
    if (!entries) continue;
    for (const key of Object.keys(entries)) {
      if (delivered.has(key)) continue;
      const tools = behind.get(key) ?? [];
      tools.push(write.resource.replace(/^mcp:/, '').replace(/-merge$/, ''));
      behind.set(key, tools);
    }
  }
  for (const [name, tools] of behind) ctx.out(`  落后：${name}（还没投到 ${tools.join('、')}）`);

  for (const entry of audit.modified) {
    if (!entry.resource.startsWith('mcp:')) continue;
    const keys = Object.keys(entry.managedKeys ?? {}).join('、');
    ctx.out(`  本地改过（pull 保留你的那条，只点名）：${entry.path}${keys ? `（${keys}）` : ''}`);
  }

  const repoNames = new Set(repoServers.map((r) => r.name));
  const local = new Map<string, LocalMcpEntry>();
  for (const entry of scan.entries) {
    if (repoNames.has(entry.name)) continue;
    if (!local.has(entry.name)) local.set(entry.name, entry);
  }
  for (const entry of local.values()) {
    ctx.out(
      `  待推送：${entry.name}（来自 ${entry.agent}：${entry.file}）${entry.collectable ? '' : ' —— TOML 落点不反向采集，要入库请手写进 mcp/mcp.yaml'}`,
    );
  }
  if (local.size > 0) {
    const sample = [...local.keys()][0];
    ctx.out(`  → 用 ejdrone push --mcp ${sample ?? '<name>'} 提交（疑似密钥会自动改写成 \${VAR}）`);
  }
  if (scan.unsupported.length > 0) {
    ctx.out(`  提示：这些工具没有用户级 MCP 落点，收不到团队 server：${scan.unsupported.join('、')}`);
  }
}

function ledgerManagedCount(ledger: Ledger): number {
  let total = 0;
  for (const entry of ledger.entries) total += Object.keys(entry.managedKeys ?? {}).length;
  return total;
}
