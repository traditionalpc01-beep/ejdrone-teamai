import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoPathFor } from '../core/plan.js';
import { readFrontmatterTags, setFrontmatterTags } from '../core/resources.js';
import { allResources, type Config, type Resource, type ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { splitList } from './context.js';
import { requireConfig } from './config.js';
import { isValidResourceName } from './constants.js';
import { kindHelp, parseKind, unknownKindMessage } from './kinds.js';
import { mcpRepoFile, setMcpEntryTags } from './mcprepo.js';
import { submitMrChange } from './mr.js';
import { saveConfig } from '../state.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

/**
 * `ejdrone tags` —— 标签订阅（2.1，对标 teamai-cli 的 tags 语义，扩展到全部 6 类资源）。
 *
 * 两半命令，两类人：
 * - 成员侧 `list / subscribe / unsubscribe`：只改本地 config（照 roles set 那条线），
 *   pull 时「带已订阅标签的条目」跨 namespace 额外下发。
 * - 管理员侧 `add / remove`：改仓库里条目的 frontmatter tags（mcp 是条目字段）并开 MR
 *   （照 roles add/remove 那条线）。不提供绕过 MR 的捷径。
 */

/** 展示用的条目定位：`skills be-deploy（namespace=be）`。 */
function where(resource: Resource): string {
  return `${resource.kind} ${resource.name}（${resource.namespace === '' ? '根条目' : `namespace=${resource.namespace}`}）`;
}

/** 仓库里所有出现过的标签 → 带标条目列表（顺序按标签名、条目 name 排，输出确定）。 */
function tagsInSnapshot(snapshot: Snapshot): Map<string, Resource[]> {
  const byTag = new Map<string, Resource[]>();
  for (const resource of allResources(snapshot.kinds)) {
    for (const tag of resource.tags ?? []) {
      const group = byTag.get(tag);
      if (group) group.push(resource);
      else byTag.set(tag, [resource]);
    }
  }
  return byTag;
}

export async function tagsList(ctx: CliContext): Promise<number> {
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
    ctx.err('下一步：检查网络后重跑 ejdrone tags list');
    return 1;
  }
  const snapshot = loaded.snapshot;

  const byTag = tagsInSnapshot(snapshot);
  const subscribed = new Set(config.subscribedTags);
  ctx.out(`团队标签（${byTag.size} 个）：`);
  for (const tag of [...byTag.keys()].sort((a, b) => (a < b ? -1 : 1))) {
    const resources = byTag.get(tag) ?? [];
    ctx.out(`  ${tag}  ${resources.length} 条${subscribed.has(tag) ? '  已订阅' : ''}`);
    for (const resource of resources) ctx.out(`    ${where(resource)}`);
  }
  if (byTag.size === 0) ctx.out('  （仓库里还没有条目打标签；管理员可 ejdrone tags add <kind> <名字> <标签>）');

  const unused = config.subscribedTags.filter((tag) => !byTag.has(tag));
  ctx.out('');
  ctx.out(`本地订阅：${config.subscribedTags.join(', ') || '（无）'}`);
  if (unused.length > 0) {
    ctx.out(`提示：订阅的 ${unused.join('、')} 在仓库里还没有条目使用，暂时不会带来额外下发`);
  }
  return 0;
}

/** 变长参数里允许逗号：`tags subscribe deploy,ci testing` == 三个标签。 */
function parseTagArgs(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) out.push(...splitList(value));
  return [...new Set(out)];
}

function validateTagNames(ctx: CliContext, tags: string[]): boolean {
  const bad = tags.filter((tag) => !isValidResourceName(tag));
  if (bad.length > 0) {
    ctx.err(`错误：标签名不合法：${bad.join('、')}（只允许小写字母、数字、-、_）`);
    ctx.err('下一步：标签名与 namespace 同一套规则；ejdrone tags list 看现有标签');
    return false;
  }
  return true;
}

export async function tagsSubscribe(ctx: CliContext, values: string[]): Promise<number> {
  const tags = parseTagArgs(values);
  if (tags.length === 0) {
    ctx.err('错误：tags subscribe 至少要一个标签名。');
    ctx.err('下一步：ejdrone tags list 看仓库现有标签，再 ejdrone tags subscribe <标签...>');
    return 1;
  }
  if (!validateTagNames(ctx, tags)) return 1;

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
    ctx.err('下一步：检查网络后重跑（要对着仓库提示未使用的标签）');
    return 1;
  }
  // 未知标签仍写入（与 roles set 对未知角色的姿态一致）：管理员可能还没推内容。
  const known = tagsInSnapshot(loaded.snapshot);
  for (const tag of tags) {
    if (!known.has(tag)) ctx.out(`提示：仓库里还没有条目使用标签「${tag}」，订阅暂不生效`);
  }

  const merged = [...new Set([...config.subscribedTags, ...tags])];
  if (merged.length === config.subscribedTags.length) {
    ctx.out('已订阅这些标签，无需变更。');
    return 0;
  }
  saveConfig({ ...config, subscribedTags: merged }, ctx.env);
  ctx.out(`已订阅标签：${merged.join(', ')}`);
  ctx.out('下一步：运行 ejdrone pull，带这些标签的条目会跨 namespace 额外下发');
  return 0;
}

export async function tagsUnsubscribe(ctx: CliContext, values: string[]): Promise<number> {
  const tags = parseTagArgs(values);
  if (tags.length === 0) {
    ctx.err('错误：tags unsubscribe 至少要一个标签名。');
    ctx.err('下一步：ejdrone tags list 看当前订阅');
    return 1;
  }

  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  const dropping = new Set(tags);
  const kept = config.subscribedTags.filter((tag) => !dropping.has(tag));
  if (kept.length === config.subscribedTags.length) {
    const notSubscribed = tags.filter((tag) => !config.subscribedTags.includes(tag));
    ctx.err(`错误：没有订阅这些标签：${notSubscribed.join('、') || '（无）'}`);
    ctx.err('下一步：ejdrone tags list 看当前订阅');
    return 1;
  }
  saveConfig({ ...config, subscribedTags: kept }, ctx.env);
  ctx.out(`已退订：${[...dropping].filter((tag) => config.subscribedTags.includes(tag)).join(', ')}`);
  ctx.out(`当前订阅：${kept.join(', ') || '（无）'}`);
  ctx.out('下一步：运行 ejdrone pull，只因此标签下发的条目会被撤走');
  return 0;
}

// ------------------------------------------------------------- 管理员 add/remove

export interface TagsChangeOptions {
  ns?: string;
}

/**
 * 同名条目可能同时住在根目录与多个 namespace（override 语义里 ns 替换根，两份都是真实文件）。
 * 多份且没给 --ns 时拒绝猜：把标签打到错的副本上，成员「订阅了却不生效」还查不出原因。
 * `--ns root` 是根条目的别名（namespace '' 没法从命令行直接表达）。
 */
function pickResource(
  ctx: CliContext,
  snapshot: Snapshot,
  kind: ResourceKind,
  name: string,
  options: TagsChangeOptions,
): Resource | null {
  const matches = snapshot.kinds[kind].filter((r) => r.name === name);
  if (matches.length === 0) {
    ctx.err(`错误：仓库里没有 ${kind}「${name}」。`);
    ctx.err(`下一步：ejdrone list ${kind === 'mcp' ? 'mcp' : kind} 看条目名（docs/learnings 的名字含 namespace 段）`);
    return null;
  }
  const wantedNs = options.ns === undefined ? undefined : options.ns === 'root' ? '' : options.ns;
  if (wantedNs !== undefined) {
    const picked = matches.find((r) => r.namespace === wantedNs);
    if (!picked) {
      ctx.err(`错误：${kind}「${name}」没有 ${options.ns === '' ? '根条目' : `namespace=${options.ns}`} 这一份。`);
      ctx.err(`下一步：候选是 ${matches.map((r) => (r.namespace === '' ? '根条目' : `namespace=${r.namespace}`)).join('、')}`);
      return null;
    }
    return picked;
  }
  if (matches.length > 1) {
    ctx.err(`错误：「${name}」有多份同名条目：${matches.map((r) => (r.namespace === '' ? '根条目' : `namespace=${r.namespace}`)).join('、')}`);
    ctx.err('下一步：加 --ns <namespace> 指定一份（根条目用 --ns root）');
    return null;
  }
  return matches[0] ?? null;
}

function mergeOrSubtract(
  current: string[] | undefined,
  wanted: string[],
  op: 'add' | 'remove',
): { next: string[]; noOp: boolean } {
  const base = current ?? [];
  if (op === 'add') {
    const merged = [...new Set([...base, ...wanted])];
    return { next: merged, noOp: merged.length === base.length };
  }
  const dropping = new Set(wanted);
  const kept = base.filter((tag) => !dropping.has(tag));
  return { next: kept, noOp: kept.length === base.length };
}

export async function tagsChange(
  ctx: CliContext,
  op: 'add' | 'remove',
  kindArg: string,
  name: string,
  values: string[],
  options: TagsChangeOptions,
): Promise<number> {
  const kind = parseKind(kindArg);
  if (kind === null) {
    ctx.err(`错误：${unknownKindMessage(kindArg)}。`);
    ctx.err(`下一步：ejdrone tags ${op} ${kindHelp().replace(/ \| /g, '|')} <名字> <标签...>`);
    return 1;
  }
  const tags = parseTagArgs(values);
  if (tags.length === 0) {
    ctx.err(`错误：tags ${op} 至少要一个标签名。`);
    return 1;
  }
  if (!validateTagNames(ctx, tags)) return 1;

  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }

  const loaded = await openSnapshot(ctx, configResult.config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络/仓库地址后重跑');
    return 1;
  }
  const snapshot = loaded.snapshot;

  const resource = pickResource(ctx, snapshot, kind, name, options);
  if (resource === null) return 1;

  const { next, noOp } = mergeOrSubtract(resource.tags, tags, op);
  if (noOp) {
    ctx.out(
      op === 'add'
        ? `「${name}」已带这些标签，无需提交。`
        : `「${name}」没有这些标签，无需提交。`,
    );
    return 0;
  }
  // remove 到空 → 删除键（setFrontmatterTags / setMcpEntryTags 对空数组都按删除处理）
  const wanted = next.length > 0 ? next : null;

  const files: Record<string, string> = {};
  if (kind === 'mcp') {
    const file = mcpRepoFile(resource.namespace);
    const abs = join(snapshot.dir, file);
    if (!existsSync(abs)) {
      ctx.err(`错误：内部不一致——快照里有 mcp「${name}」但 ${file} 不存在。`);
      return 1;
    }
    const edited = setMcpEntryTags(file, readFileSync(abs, 'utf8'), name, wanted);
    if (!edited.ok || edited.text === undefined) {
      ctx.err(`错误：${edited.error ?? '未知错误'}`);
      return 1;
    }
    files[file] = edited.text;
  } else {
    const rel = kind === 'skills' ? `${repoPathFor(resource)}/SKILL.md` : repoPathFor(resource);
    const abs = join(snapshot.dir, rel);
    if (!existsSync(abs)) {
      ctx.err(`错误：内部不一致——快照里有该条目但 ${rel} 不存在。`);
      return 1;
    }
    const edited = setFrontmatterTags(readFileSync(abs, 'utf8'), wanted);
    if (edited.error !== undefined) {
      ctx.err(`错误：${rel} ${edited.error}`);
      ctx.err('下一步：先在仓库里修好这个文件的 frontmatter 再打标签');
      return 1;
    }
    files[rel] = edited.content;
  }

  const before = resource.tags ?? [];
  const change = {
    files,
    removes: [],
    branchPrefix: `ejdrone/tags-${op}-${kind}-${name}-`,
    title: `chore(tags): ${op} ${tags.join(', ')} ${kind === 'mcp' ? `mcp ${name}` : `${kind}/${name}`}`,
    body: [
      `由 ejdrone tags ${op} 生成。`,
      '',
      `条目：${where(resource)}`,
      `标签变更：${before.length > 0 ? before.join(', ') : '（无）'} → ${wanted === null ? '（无）' : wanted.join(', ')}`,
      '',
      '合入后，订阅了相关标签的成员下次 pull 会自动跟进（新下发 / 撤走）。',
    ].join('\n'),
  };

  try {
    const outcome = await submitMrChange(ctx, configResult.config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out('提示：合入后订阅这些标签的成员下次会话自动跟进；本机要等合入后再 ejdrone pull。');
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：标签变更提交失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查本地 clone（~/.ejdrone/repo 可删除后重建）');
    return 1;
  }
}
