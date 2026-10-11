import { registry } from '../agents/index.js';
import type { AgentAdapter, Config } from '../core/types.js';
import { loadConfig, saveConfig } from '../state.js';
import { splitList, type CliContext } from './context.js';
import { hookCommand } from './constants.js';
import { pullOnce } from './pull.js';
import { openSnapshot, type Snapshot } from './snapshot.js';

export interface InitOptions {
  agent?: string;
  role?: string;
  provider?: string;
  force?: boolean;
}

const GITLAB_HOST_RE = /gitlab/i;

/**
 * 主机名（含 scp 式 git@host:path）里出现 gitlab 就走 GitLab provider。
 * --provider 显式覆盖：自建 GitLab 常常不用 gitlab 这个域名。
 */
export function providerForRepo(repo: string, override?: string): Config['provider'] {
  const value = (override ?? '').trim();
  if (value === 'gitlab' || value === 'git') return value;
  const raw = repo.trim();
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    const match = /^[^@/\s]+@([^:/\s]+):/.exec(raw);
    host = match?.[1] ?? '';
  }
  return GITLAB_HOST_RE.test(host) ? 'gitlab' : 'git';
}

function validateAgentIds(ids: string[]): { ok: true } | { ok: false; error: string } {
  const registry_ = registry();
  const unknown = ids.filter((id) => !registry_.byId(id));
  if (unknown.length > 0) {
    return { ok: false, error: `未知工具 id：${unknown.join(', ')}` };
  }
  return { ok: true };
}

async function pickAdapters(ctx: CliContext, provided: string | undefined): Promise<AgentAdapter[] | null> {
  const registry_ = registry();
  if (provided !== undefined && provided.trim() !== '') {
    const ids = splitList(provided);
    const check = validateAgentIds(ids);
    if (!check.ok) {
      ctx.err(`错误：${check.error}`);
      ctx.err(`下一步：可选 id 为 ${registry_.ids().join(', ')}`);
      return null;
    }
    return ids.map((id) => registry_.byId(id)).filter((a): a is AgentAdapter => Boolean(a));
  }

  const detected = registry_.all().filter((adapter) => adapter.detect(ctx.home, ctx.env));
  if (!ctx.interactive) {
    if (detected.length === 0) {
      ctx.err('错误：没有 --agent，也没有探测到已安装的 AI 工具。');
      ctx.err(`下一步：加 --agent <id,id>，可选 ${registry_.ids().join(', ')}`);
      return null;
    }
    ctx.out(`已探测到并选用：${detected.map((a) => a.label).join('、')}`);
    return detected;
  }

  const items = registry_.all().map((adapter) => ({
    value: adapter.id,
    label: `${adapter.label}${adapter.detect(ctx.home, ctx.env) ? '' : '（未探测到安装）'}`,
  }));
  const chosen = await ctx.choose('选择要同步的 AI 工具：', items, detected.map((a) => a.id));
  return chosen.map((id) => registry_.byId(id)).filter((a): a is AgentAdapter => Boolean(a));
}

async function pickRoles(
  ctx: CliContext,
  snapshot: Snapshot,
  provided: string | undefined,
): Promise<{ primaryRole: string | null; additionalRoles: string[] }> {
  const roles = snapshot.manifest?.roles ?? [];
  if (roles.length === 0) {
    if (provided !== undefined && provided.trim() !== '') {
      ctx.out('提示：仓库没有 manifest/roles.yaml，--role 暂不生效（只下发根条目）');
    }
    return { primaryRole: null, additionalRoles: [] };
  }
  const ids = roles.map((role) => role.id);

  const requested = splitList(provided);
  const primary = requested[0];
  if (primary !== undefined) {
    if (!ids.includes(primary)) ctx.out(`提示：角色「${primary}」不在 manifest/roles.yaml 中，pull 时会告警`);
    if (ctx.interactive) {
      const extra = await ctx.choose(
        '还要订阅哪些角色？（可多选，回车跳过）',
        ids.filter((id) => id !== primary).map((id) => ({ value: id, label: id })),
        [],
      );
      return { primaryRole: primary, additionalRoles: extra };
    }
    return { primaryRole: primary, additionalRoles: [] };
  }

  if (!ctx.interactive) {
    ctx.out('提示：未指定 --role，本次不设角色，只下发根条目。下一步：ejdrone roles set <primary> [--add <ids>]');
    return { primaryRole: null, additionalRoles: [] };
  }

  const items = [
    ...ids.map((id) => ({ value: id, label: `角色 ${id}` })),
    { value: '', label: '不设角色（只下发根条目）' },
  ];
  const only = ids.length === 1 ? ids[0] : undefined;
  const chosen = await ctx.choose('选择你的主角色：', items, only === undefined ? [] : [only]);
  const picked = chosen[0] ?? '';
  if (picked === '') return { primaryRole: null, additionalRoles: [] };
  const extra = await ctx.choose(
    '还要订阅哪些角色？（可多选，回车跳过）',
    ids.filter((id) => id !== picked).map((id) => ({ value: id, label: id })),
    [],
  );
  return { primaryRole: picked, additionalRoles: extra };
}

function installHooks(ctx: CliContext, adapters: AgentAdapter[]): void {
  const cmd = hookCommand(ctx.env);
  for (const adapter of adapters) {
    const outcome = adapter.installHook(ctx.home, ctx.env, cmd);
    if (outcome.installed) {
      ctx.out(`hook：${adapter.label} 已安装（${cmd}）`);
    } else {
      ctx.out(`hook：${adapter.label} 未安装 —— ${outcome.reason ?? '该工具无 hook 机制，请手动运行 ejdrone pull'}`);
    }
  }
}

export async function initCommand(ctx: CliContext, repo: string | undefined, options: InitOptions): Promise<number> {
  const url = (repo ?? '').trim();
  if (url === '') {
    ctx.err('错误：缺少团队仓库地址。');
    ctx.err('下一步：ejdrone init <repo-url>，例如 ejdrone init https://gitlab.example.com/team/ejdrone-teamai.git');
    return 1;
  }

  const requestedProvider = (options.provider ?? '').trim();
  if (requestedProvider !== '' && requestedProvider !== 'gitlab' && requestedProvider !== 'git') {
    ctx.err(`错误：--provider「${requestedProvider}」不认识。`);
    ctx.err('下一步：用 gitlab（自动开 MR）或 git（只推分支，手动开 MR）');
    return 1;
  }

  const existing = loadConfig(ctx.env);
  if (!options.force && (existing.config !== null || existing.error)) {
    if (existing.config === null) {
      ctx.err(`错误：现有 config 不可用：${existing.error ?? '未知问题'}`);
    } else {
      ctx.err(`错误：已初始化（repo=${existing.config.repo}）。`);
    }
    ctx.err('下一步：确认要覆盖请加 --force');
    return 1;
  }

  const loaded = await openSnapshot(ctx, url);
  if (!loaded.ok) {
    ctx.err(`错误：无法同步团队仓库：${loaded.error}`);
    ctx.err('下一步：确认仓库地址可访问（需要 git 读权限），再重跑 ejdrone init');
    return 1;
  }
  const snapshot = loaded.snapshot;

  const adapters = await pickAdapters(ctx, options.agent);
  if (adapters === null) return 1;
  if (adapters.length === 0) {
    ctx.err('错误：没有选定任何工具。');
    ctx.err(`下一步：加 --agent <id,id>，可选 ${registry().ids().join(', ')}`);
    return 1;
  }

  const { primaryRole, additionalRoles } = await pickRoles(ctx, snapshot, options.role);

  const config: Config = {
    version: 1,
    repo: url,
    provider: providerForRepo(url, options.provider),
    primaryRole,
    additionalRoles,
    agents: adapters.map((a) => a.id),
  };
  saveConfig(config, ctx.env);
  ctx.out(
    `已写入 config：repo=${config.repo}，provider=${config.provider}，工具=${config.agents.join(', ')}，角色=${primaryRole ?? '（无）'}`,
  );
  ctx.out('成员信息只记录在本地 config（v1 不向仓库上报成员名单）');

  installHooks(ctx, adapters);

  if (snapshot.manifestError) {
    ctx.err(`错误：仓库 manifest/roles.yaml 无法解析：${snapshot.manifestError}`);
    ctx.err('下一步：修正该文件（管理员可 ejdrone push 或直接在仓库改）后运行 ejdrone pull');
    return 1;
  }

  const pull = await pullOnce(ctx, {});
  if (pull.fatal) return 1;
  if (pull.code !== 0) ctx.out('提示：首次 pull 有保留/冲突项，详见上面的输出');
  return 0;
}
