import type { Resource, ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { submitMrChange } from './mr.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

function kindOf(input: string): ResourceKind | null {
  if (input === 'skills' || input === 'skill') return 'skills';
  if (input === 'rules' || input === 'rule') return 'rules';
  return null;
}

function repoPath(resource: Resource): string {
  const root = resource.kind === 'skills' ? 'skills' : 'rules';
  const base = resource.namespace === '' ? `${root}/${resource.name}` : `${root}/${resource.namespace}/${resource.name}`;
  return resource.kind === 'skills' ? base : `${base}.md`;
}

export async function removeCommand(ctx: CliContext, rawKind: string | undefined, names: string[]): Promise<number> {
  const kind = rawKind === undefined ? null : kindOf(rawKind);
  if (kind === null) {
    ctx.err(`错误：remove 需要类型 skills 或 rules${rawKind ? `（收到「${rawKind}」）` : ''}。`);
    ctx.err('下一步：ejdrone remove skills <name...> 或 ejdrone remove rules <name...>');
    return 1;
  }
  if (names.length === 0) {
    ctx.err('错误：remove 需要至少一个资源名。');
    ctx.err('下一步：ejdrone list ' + kind + ' 查看仓库现有条目');
    return 1;
  }

  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络/仓库地址后重跑 ejdrone remove');
    return 1;
  }
  const snapshot = loaded.snapshot;
  if (snapshot.manifestError) {
    ctx.err(`错误：${snapshot.manifestError}`);
    ctx.err('下一步：先修好 manifest/roles.yaml，删除操作要在干净的 manifest 上进行');
    return 1;
  }

  const pool = kind === 'skills' ? snapshot.skills : snapshot.rules;
  const found: Resource[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const matches = pool.filter((resource) => resource.name === name);
    if (matches.length === 0) missing.push(name);
    else found.push(...matches);
  }
  if (missing.length > 0) {
    ctx.out(`提示：仓库里找不到 ${kind} ${missing.join(', ')}，其余条目照常处理`);
  }
  if (found.length === 0) {
    ctx.err(`错误：${kind} 中没有可删除的条目。`);
    ctx.err(`下一步：ejdrone list ${kind} 查看现有名称`);
    return 1;
  }

  const removes = found.map((resource) => repoPath(resource));
  const single = found[0];
  const change = {
    files: {},
    removes,
    branchPrefix: `ejdrone/push-${kind}-${single?.name ?? 'multi'}-remove-`,
    title: `chore(${kind}): remove ${found.map((r) => r.name).join(', ')}`,
    body: [
      `由 ejdrone remove 生成，删除团队仓库中的 ${kind} 条目：`,
      '',
      ...removes.map((path) => `- ${path}`),
      '',
      '合入后各成员下次 pull 会自动从各自工具目录移除这些条目（本地改过的副本会被保留并点名）。',
    ].join('\n'),
  };

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out(`已提交删除 ${kind}：${removes.join('、')}`);
      ctx.out('注意：本机各工具目录的副本没有被删除——未合入就删会与团队不一致。');
      ctx.out('合入后 ejdrone pull 会自动从各工具移除（你改过的副本会保留并点名）。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：删除提交失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查本地 clone（~/.ejdrone/repo 可删除后重建）');
    return 1;
  }
}
