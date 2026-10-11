import { loadLedger } from '../core/ledger.js';
import { ledgerPath } from '../state.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { buildDelivery } from './delivery.js';
import { auditLedger } from './ledgercheck.js';
import { scanLocalAgents } from './local.js';
import { openSnapshot } from './snapshot.js';

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

  const repoKeys = new Set(delivery.activeResources);
  const deliveredKeys = new Set(ledger.entries.map((entry) => entry.resource));
  const behind = [...repoKeys].filter((key) => !deliveredKeys.has(key));

  const repoNames = new Set([
    ...snapshot.skills.map((r) => `skills:${r.name}`),
    ...snapshot.rules.map((r) => `rules:${r.name}`),
  ]);
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

  ctx.out('');
  ctx.out(`快照 commit：${snapshot.head.slice(0, 12)}（分支 ${snapshot.branch}）`);
  return 0;
}
