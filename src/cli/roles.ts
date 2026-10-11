import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { RolesManifest } from '../core/types.js';
import { saveConfig } from '../state.js';
import { splitList, type CliContext } from './context.js';
import { requireConfig } from './config.js';
import { isValidResourceName } from './constants.js';
import { submitMrChange } from './mr.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

const MANIFEST_REL = 'manifest/roles.yaml';

export interface RolesSetOptions {
  add?: string;
}

export interface RolesAddOptions {
  namespaces?: string;
  description?: string;
}

function readManifestDoc(snapshot: Snapshot): { doc: Record<string, unknown>; manifest: RolesManifest | null } | { error: string } {
  const file = join(snapshot.dir, MANIFEST_REL);
  if (!existsSync(file)) return { doc: { version: 1, roles: [] }, manifest: null };
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `manifest/roles.yaml 不是合法 YAML：${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'manifest/roles.yaml 顶层必须是映射（version + roles）' };
  }
  const doc = parsed as Record<string, unknown>;
  return { doc, manifest: snapshot.manifest };
}

function rolesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(doc.roles) ? (doc.roles as Array<Record<string, unknown>>) : [];
}

export async function rolesList(ctx: CliContext): Promise<number> {
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
    ctx.err('下一步：检查网络后重跑 ejdrone roles list');
    return 1;
  }
  const snapshot = loaded.snapshot;
  if (snapshot.manifestError) {
    ctx.err(`错误：${snapshot.manifestError}`);
    ctx.err(`下一步：修正 ${snapshot.dir}/${MANIFEST_REL} 后重跑`);
    return 1;
  }

  const roles = snapshot.manifest?.roles ?? [];
  ctx.out(`团队角色（${MANIFEST_REL}）：${roles.length}`);
  for (const role of roles) {
    ctx.out(`  ${role.id}  namespaces=${role.namespaces.join(', ')}  ${role.description ?? ''}`.trimEnd());
  }
  if (roles.length === 0) {
    ctx.out('  （未启用角色；只下发根条目。管理员可 ejdrone roles add <id> 新增）');
  }

  ctx.out('');
  ctx.out(`本地：主角色=${config.primaryRole ?? '（无）'} 附加=${config.additionalRoles.join(', ') || '（无）'}`);
  const unknown = [config.primaryRole, ...config.additionalRoles].filter(
    (id): id is string => id !== null && id !== '' && !roles.some((role) => role.id === id),
  );
  for (const id of unknown) ctx.out(`提示：本地订阅的角色「${id}」不在团队 manifest 中，pull 会告警`);
  return 0;
}

export async function rolesSet(ctx: CliContext, primary: string | undefined, options: RolesSetOptions): Promise<number> {
  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  const wanted = (primary ?? '').trim();
  if (wanted === '') {
    ctx.err('错误：roles set 需要主角色 id。');
    ctx.err('下一步：ejdrone roles list 看可选角色，再 ejdrone roles set <primary> [--add <ids>]');
    return 1;
  }
  if (!isValidResourceName(wanted)) {
    ctx.err(`错误：角色 id「${wanted}」不合法（只允许小写字母、数字、-、_）。`);
    ctx.err('下一步：ejdrone roles list 查看团队角色 id');
    return 1;
  }

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络后重跑（角色 id 需要对着 manifest 校验）');
    return 1;
  }
  const snapshot = loaded.snapshot;
  const known = new Set((snapshot.manifest?.roles ?? []).map((role) => role.id));
  if (snapshot.manifest && !known.has(wanted)) {
    ctx.out(`提示：团队 manifest 里没有角色「${wanted}」，本次仍写入本地 config，pull 时会告警`);
  }

  const additional = options.add === undefined ? config.additionalRoles : splitList(options.add);
  for (const id of additional) {
    if (!isValidResourceName(id)) {
      ctx.err(`错误：附加角色 id「${id}」不合法。`);
      ctx.err('下一步：ejdrone roles set <primary> --add <id,id>');
      return 1;
    }
    if (snapshot.manifest && !known.has(id)) {
      ctx.out(`提示：团队 manifest 里没有角色「${id}」`);
    }
  }

  saveConfig({ ...config, primaryRole: wanted, additionalRoles: additional.filter((id) => id !== wanted) }, ctx.env);
  ctx.out(`已更新本地角色：主=${wanted} 附加=${additional.filter((id) => id !== wanted).join(', ') || '（无）'}`);
  ctx.out('下一步：运行 ejdrone pull 让新角色的条目落地（原角色的独有条目会被清理）');
  return 0;
}

async function manifestChange(
  ctx: CliContext,
  op: 'add' | 'remove',
  id: string,
  options: RolesAddOptions,
): Promise<number> {
  const configResult = requireConfig(ctx);
  if (!configResult.ok) {
    ctx.err(`错误：${configResult.error}`);
    ctx.err(`下一步：${configResult.nextStep}`);
    return 1;
  }
  const config = configResult.config;

  if (!isValidResourceName(id)) {
    ctx.err(`错误：角色 id「${id}」不合法（只允许小写字母、数字、-、_）。`);
    ctx.err('下一步：ejdrone roles add devops --namespaces devops -d "后端与运维"');
    return 1;
  }

  const loaded = await openSnapshot(ctx, config.repo);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：检查网络/仓库地址后重跑');
    return 1;
  }
  const snapshot = loaded.snapshot;
  if (snapshot.manifestError) {
    ctx.err(`错误：${snapshot.manifestError}`);
    ctx.err('下一步：先修好 manifest/roles.yaml，再执行角色变更');
    return 1;
  }

  const read = readManifestDoc(snapshot);
  if ('error' in read) {
    ctx.err(`错误：${read.error}`);
    ctx.err(`下一步：修正 ${snapshot.dir}/${MANIFEST_REL}`);
    return 1;
  }
  const doc = read.doc;
  const roles = rolesOf(doc);
  const existingIndex = roles.findIndex((role) => role.id === id);

  if (op === 'add') {
    if (existingIndex >= 0) {
      ctx.err(`错误：角色「${id}」已存在（namespaces=${JSON.stringify(roles[existingIndex]?.namespaces)}）。`);
      ctx.err('下一步：要改订阅关系请编辑 manifest/roles.yaml，或先 ejdrone roles remove ' + id);
      return 1;
    }
    const namespaces = splitList(options.namespaces).length > 0 ? splitList(options.namespaces) : [id];
    const bad = namespaces.filter((ns) => !isValidResourceName(ns));
    if (bad.length > 0) {
      ctx.err(`错误：namespace 不合法：${bad.join(', ')}`);
      ctx.err('下一步：--namespaces 只允许小写字母、数字、-、_，且要与 skills/<ns>/ 目录名一致');
      return 1;
    }
    roles.push({
      id,
      ...(options.description ? { description: options.description } : {}),
      namespaces,
    });
  } else {
    if (existingIndex < 0) {
      ctx.err(`错误：角色「${id}」不在 manifest/roles.yaml 中。`);
      ctx.err('下一步：ejdrone roles list 查看现有角色 id');
      return 1;
    }
    roles.splice(existingIndex, 1);
  }

  doc.roles = roles;
  if (typeof doc.version !== 'number') doc.version = 1;
  const ordered: Record<string, unknown> = { version: doc.version, roles: doc.roles };
  for (const [key, value] of Object.entries(doc)) {
    if (key !== 'version' && key !== 'roles') ordered[key] = value;
  }

  const change = {
    files: { [MANIFEST_REL]: `${stringifyYaml(ordered)}\n` },
    removes: [],
    branchPrefix: `ejdrone/push-roles-${op}-${id}-`,
    title: `chore(roles): ${op} ${id}`,
    body: [
      `由 ejdrone roles ${op} 生成的角色表变更。`,
      '',
      `角色：${id}`,
      ...(op === 'add'
        ? [`namespaces：${splitList(options.namespaces).join(', ') || id}`, `说明：${options.description ?? '（无）'}`]
        : ['注意：只改角色表，不删除 skills/<ns>/ 与 rules/<ns>/ 里的文件。']),
      '',
      '合入后各成员的 pull 会自动停止下发该角色独占的条目。',
    ].join('\n'),
  };

  try {
    const outcome = await submitMrChange(ctx, config, snapshot, change);
    if (outcome.code === 0) {
      ctx.out(`提示：合入后运行 ejdrone roles set ${id} 订阅（remove 则改订其他角色）。`);
    }
    return outcome.code;
  } catch (e) {
    ctx.err(`错误：角色变更提交失败：${e instanceof Error ? e.message : String(e)}`);
    ctx.err('下一步：运行 ejdrone doctor 检查本地 clone（~/.ejdrone/repo 可删除后重建）');
    return 1;
  }
}

export function rolesAdd(ctx: CliContext, id: string | undefined, options: RolesAddOptions): Promise<number> {
  if (id === undefined || id.trim() === '') {
    ctx.err('错误：roles add 需要角色 id。');
    ctx.err('下一步：ejdrone roles add devops --namespaces devops -d "后端与运维"');
    return Promise.resolve(1);
  }
  return manifestChange(ctx, 'add', id.trim(), options);
}

export function rolesRemove(ctx: CliContext, id: string | undefined): Promise<number> {
  if (id === undefined || id.trim() === '') {
    ctx.err('错误：roles remove 需要角色 id。');
    ctx.err('下一步：ejdrone roles list 查看现有角色，再 ejdrone roles remove <id>');
    return Promise.resolve(1);
  }
  return manifestChange(ctx, 'remove', id.trim(), {});
}
