import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { registry } from '../agents/index.js';
import type { AgentAdapter, Config } from '../core/types.js';
import { isCodeupUrl } from '../git/codeup-api.js';
import { loadConfig, saveConfig } from '../state.js';
import { splitList, type CliContext } from './context.js';
import { hookCommand, win32Hook, type Win32Hook } from './constants.js';
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
 * Codeup（codeup.aliyun.com，含 scp 式）→ codeup provider；
 * 主机名（含 scp 式 git@host:path）里出现 gitlab 就走 GitLab provider。
 * --provider 显式覆盖：自建 GitLab 常常不用 gitlab 这个域名。
 */
export function providerForRepo(repo: string, override?: string): Config['provider'] {
  const value = (override ?? '').trim();
  if (value === 'gitlab' || value === 'git' || value === 'codeup') return value;
  const raw = repo.trim();
  if (isCodeupUrl(raw)) return 'codeup';
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

async function pickAdapters(
  ctx: CliContext,
  provided: string | undefined,
  ask: boolean,
): Promise<AgentAdapter[] | null> {
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
  if (!ask) {
    if (detected.length === 0) {
      ctx.err('错误：没有 --agent，也没有探测到已安装的 AI 工具。');
      ctx.err('下一步：先安装并至少打开一次你在用的 AI 工具，再重跑 ejdrone init；或用 --agent <id,id> 直接指定');
      ctx.err(`可选 id：${registry_.ids().join(', ')}`);
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

/** 角色选项的展示标签：id 后面跟管理员在 roles.yaml 里写的中文描述。
 *  非开发者成员不认识 fe/devops 这类内部 id，描述是唯一的人话锚点——
 *  `ejdrone roles list` 早就显示它，第一次问答（这里）更不能缺席。 */
function roleLabel(roles: { id: string; description?: string }[], id: string): string {
  const role = roles.find((r) => r.id === id);
  return role?.description ? `${id}（${role.description}）` : id;
}

async function pickRoles(
  ctx: CliContext,
  snapshot: Snapshot,
  provided: string | undefined,
  ask: boolean,
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
    if (ask) {
      const extra = await ctx.choose(
        '还要订阅哪些角色？（可多选，回车跳过）',
        ids.filter((id) => id !== primary).map((id) => ({ value: id, label: roleLabel(roles, id) })),
        [],
      );
      return { primaryRole: primary, additionalRoles: extra };
    }
    return { primaryRole: primary, additionalRoles: [] };
  }

  if (!ask) {
    ctx.out('提示：未指定 --role，本次不设角色，只下发根条目。下一步：ejdrone roles set <primary> [--add <ids>]');
    return { primaryRole: null, additionalRoles: [] };
  }

  const items = [
    ...ids.map((id) => ({ value: id, label: `角色 ${roleLabel(roles, id)}` })),
    { value: '', label: '不确定 / 先跳过（只下发全员内容，之后可 ejdrone roles set 修改）' },
  ];
  const only = ids.length === 1 ? ids[0] : undefined;
  const chosen = await ctx.choose('选择你的主角色：', items, only === undefined ? [] : [only]);
  const picked = chosen[0] ?? '';
  if (picked === '') {
    ctx.out('提示：未设角色。对 AI 工具说「我是产品经理，帮我设置角色」或运行 ejdrone roles set <id> 可随时补上');
    return { primaryRole: null, additionalRoles: [] };
  }
  const extra = await ctx.choose(
    '还要订阅哪些角色？（可多选，回车跳过）',
    ids.filter((id) => id !== picked).map((id) => ({ value: id, label: roleLabel(roles, id) })),
    [],
  );
  return { primaryRole: picked, additionalRoles: extra };
}

function installHooks(ctx: CliContext, adapters: AgentAdapter[]): void {
  const cmd = hookCommand(ctx.env);
  // win32 且本机没有 Git for Windows：hook 命令无从构造（bash 是唯一的执行宿主），
  // 一个都不装，逐工具给出安装指引——不装也不影响手动 ejdrone pull。
  if (cmd === null) {
    for (const adapter of adapters) {
      ctx.out(`hook：${adapter.label} 未安装 —— 需要 Git for Windows（https://git-scm.com/download/win 安装后重跑 ejdrone init --force；不装也不影响手动 ejdrone pull）`);
    }
    return;
  }
  // Windows 的 payload 住在 wrapper 文件里：先把 wrapper 落盘，再把它指向的那条命令写进工具配置。
  // 顺序反了会出现「hook 已装但 wrapper 不存在」的中间态 —— 会话开起来只有一次静默失败。
  const win = win32Hook(ctx.env);
  if (win !== null && !writeHookWrapper(ctx, win)) return;
  for (const adapter of adapters) {
    const outcome = adapter.installHook(ctx.home, ctx.env, cmd);
    if (outcome.installed) {
      ctx.out(`hook：${adapter.label} 已安装（${cmd}）`);
    } else {
      ctx.out(`hook：${adapter.label} 未安装 —— ${outcome.reason ?? '该工具无 hook 机制，请手动运行 ejdrone pull'}`);
    }
  }
}

/** wrapper 落盘；失败时点名并返回 false（不抛错，与 hook 一贯的降级姿态一致）。 */
function writeHookWrapper(ctx: CliContext, win: Win32Hook): boolean {
  try {
    mkdirSync(dirname(win.wrapperPath), { recursive: true });
    writeFileSync(win.wrapperPath, win.wrapperBody, 'utf8');
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    ctx.err(`错误：hook wrapper 写不出来（${win.wrapperPath}）：${why}`);
    ctx.err('      会话自动 pull 未安装；修好目录权限后重跑 ejdrone init --force，手动 ejdrone pull 不受影响。');
    return false;
  }
  if (win.degraded) {
    ctx.out('提示：你的状态目录路径含空格，hook 命令退到 cmd.exe /c 包装形态 —— 用 Git Bash 执行 hook 的工具不会触发自动 pull（doctor 会点名）。');
  }
  return true;
}

export async function initCommand(ctx: CliContext, repo: string | undefined, options: InitOptions): Promise<number> {
  const url = (repo ?? '').trim();
  if (url === '') {
    ctx.err('错误：缺少团队仓库地址。');
    ctx.err('下一步：ejdrone init <repo-url>，例如 ejdrone init https://gitlab.example.com/team/ejdrone-teamai.git');
    return 1;
  }

  const requestedProvider = (options.provider ?? '').trim();
  if (
    requestedProvider !== '' &&
    requestedProvider !== 'gitlab' &&
    requestedProvider !== 'git' &&
    requestedProvider !== 'codeup'
  ) {
    ctx.err(`错误：--provider「${requestedProvider}」不认识。`);
    ctx.err('下一步：用 codeup（Codeup 仓库，API 自动开 MR）、gitlab（自动开 MR）或 git（只推分支，手动开 MR）');
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
  // 与 pull 同一通道显示快照级提示（如 origin 刚被改写：此前本地同步的是另一个仓库）。
  // init --force 换仓库地址时 openSnapshot 就发生 relink，不在这里显示的话这条提示
  // 在随后的首次 pull 里已经不会再出现（origin 已一致），成员就无从得知搬过仓库。
  for (const warning of snapshot.warnings) ctx.out(`提示：${warning}`);

  // --force 跳过全部问答（README 对脚本/CI 的承诺）：工具用 --agent 或探测结果、
  // 角色用 --role，缺省项按各自的无输入路径处理（探测不到就报可行动错误）。
  // 一键安装脚本在首跑时烤好 -Agent/-Role 再带 --force，成员零问答；
  // 重跑升级不传 --force（由脚本的 config.yaml 存在性判定跳过 init），成员的定制不被清洗。
  const ask = ctx.interactive && options.force !== true;

  const adapters = await pickAdapters(ctx, options.agent, ask);
  if (adapters === null) return 1;
  if (adapters.length === 0) {
    ctx.err('错误：没有选定任何工具。');
    ctx.err(`下一步：加 --agent <id,id>，可选 ${registry().ids().join(', ')}`);
    return 1;
  }

  const { primaryRole, additionalRoles } = await pickRoles(ctx, snapshot, options.role, ask);

  const config: Config = {
    version: 1,
    repo: url,
    provider: providerForRepo(url, options.provider),
    primaryRole,
    additionalRoles,
    // 标签订阅不进 init 向导：默认空订阅，成员用 ejdrone tags subscribe 按需加
    subscribedTags: [],
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
