import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { Dirent } from 'node:fs';

import { rulesRoot, skillsRoot, TOOL_PATHS } from '../agents/paths.js';
import type { AgentAdapter, Config, Resource, ResourceKind } from '../core/types.js';
import type { CliContext } from './context.js';
import { selectedAdapters } from './delivery.js';

export interface LocalCandidate {
  kind: ResourceKind;
  name: string;
  /** 来源工具 id（用于展示"从哪个目录采到的"） */
  agent: string;
  /** 采集到的绝对路径（skill 目录 / rule 文件） */
  origin: string;
  resource: Resource;
}

function under(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function entries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 目录内全部普通文件（posix 相对路径）；符号链接不跟随，越界路径直接跳过，二进制文件跳过。 */
export function readTree(root: string, warnings: string[] = []): Record<string, string> | null {
  const out: Record<string, string> = {};
  let wrote = false;
  const walk = (dir: string): void => {
    for (const e of entries(dir)) {
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (!under(abs, root)) continue;
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        const content = readFileSync(abs, 'utf8');
        if (content.includes('\u0000')) {
          warnings.push(`${relative(root, abs).split(sep).join('/')} 看起来是二进制文件，v1 只同步文本，已跳过`);
          continue;
        }
        out[relative(root, abs).split(sep).join('/')] = content;
        wrote = true;
      }
    }
  };
  walk(root);
  return wrote ? out : null;
}

function skillCandidates(adapter: AgentAdapter, ctx: CliContext, warnings: string[]): LocalCandidate[] {
  const root = skillsRoot(adapter.id, ctx.home, ctx.env);
  if (!isDirectory(root)) return [];
  const found: LocalCandidate[] = [];
  for (const e of entries(root)) {
    if (e.isSymbolicLink() || !e.isDirectory()) continue;
    const dir = join(root, e.name);
    const files = readTree(dir);
    if (!files || files['SKILL.md'] === undefined) continue;
    found.push({ kind: 'skills', name: e.name, agent: adapter.id, origin: dir, resource: { kind: 'skills', namespace: '', name: e.name, files } });
  }
  const stray = entries(root).filter((e) => e.isFile() && e.name.endsWith('.md'));
  for (const e of stray) {
    warnings.push(`${adapter.id} 的 skills 目录下有散落的 ${e.name}，不会被采集（skill 必须是含 SKILL.md 的目录）`);
  }
  return found;
}

function ruleCandidates(adapter: AgentAdapter, ctx: CliContext, warnings: string[]): LocalCandidate[] {
  const spec = TOOL_PATHS[adapter.id];
  // block 模式（Codex / DSH）的 rules 落在用户自己的 AGENTS.md 里，不能反过来当团队 rule 推送
  if (!spec || spec.rulesMode === 'block' || spec.rulesMode === 'none') return [];
  const root = rulesRoot(adapter.id, ctx.home, ctx.env);
  if (root === null || !isDirectory(root)) return [];
  const ext = spec.rulesExt ?? 'md';
  const found: LocalCandidate[] = [];
  for (const e of entries(root)) {
    if (e.isSymbolicLink() || !e.isFile()) continue;
    if (!e.name.endsWith(`.${ext}`)) {
      warnings.push(`${adapter.id} 的 rules 目录下 ${e.name} 扩展名不是 .${ext}，已跳过`);
      continue;
    }
    const abs = join(root, e.name);
    const name = e.name.slice(0, -(`.${ext}`.length));
    if (name === '') continue;
    found.push({
      kind: 'rules',
      name,
      agent: adapter.id,
      origin: abs,
      resource: { kind: 'rules', namespace: '', name, files: { content: readFileSync(abs, 'utf8') } },
    });
  }
  return found;
}

/** 扫描选定工具目录，得到"本地有、可能想推给团队"的资源；同名只保留第一个。 */
export function scanLocal(ctx: CliContext, config: Config): { candidates: LocalCandidate[]; warnings: string[] } {
  const warnings: string[] = [];
  const { adapters, notes } = selectedAdapters(ctx, config);
  warnings.push(...notes);

  const candidates: LocalCandidate[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    // 同一资源会被投递到多个工具目录，去重是正常路径，不必告警
    for (const candidate of [...skillCandidates(adapter, ctx, warnings), ...ruleCandidates(adapter, ctx, warnings)]) {
      const id = candidateKey(candidate);
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(candidate);
    }
  }
  return { candidates, warnings };
}

export function candidateKey(candidate: { kind: ResourceKind; name: string }): string {
  return `${candidate.kind}:${candidate.name}`;
}

/** 只需要"扫哪几个工具目录"时用它：本地候选扫描不依赖 repo/provider。 */
export function scanLocalAgents(ctx: CliContext, agents: string[]): { candidates: LocalCandidate[]; warnings: string[] } {
  return scanLocal(ctx, { version: 1, repo: '', provider: 'git', primaryRole: null, additionalRoles: [], agents });
}
