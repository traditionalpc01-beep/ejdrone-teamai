import { existsSync, readFileSync } from 'node:fs';

import { allResources, mcpPayload } from '../core/types.js';
import { registry } from '../agents/index.js';
import { agentsTarget, hookTarget, mcpTargetPath, TOOL_PATHS } from '../agents/paths.js';
import { resolveMcpResources } from '../core/mcp.js';
import { isKnowledgePath } from '../core/knowledge.js';
import { activeNamespaces, resolve } from '../core/plan.js';
import { hasHook, installedHookCommand } from '../hooks.js';
import { findGitBash, isWindows, samePath, whichWithPathext } from '../platform.js';
import { currentCliEntry, parseHookBash, parseHookPaths } from './constants.js';
import { loadLedger } from '../core/ledger.js';
import type { Config, Ledger } from '../core/types.js';
import { configPath, knowledgeDir, ledgerPath } from '../state.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { auditLedger, type LedgerAudit } from './ledgercheck.js';
import { readExistingSnapshot, openSnapshot, type Snapshot } from './snapshot.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  /** 下一步该做什么 */
  hint?: string;
}

export interface DoctorOptions {
  json?: boolean;
}

/** paths.ts 里 probe 文案只要还带"未核对"字样就仍属猜测落点。 */
function probeUnverified(id: string): boolean {
  const probe = TOOL_PATHS[id]?.probe;
  if (!probe) return false;
  return /未核对|待真机|PROBE/.test(probe);
}

/**
 * mcp 四项检查。id 前缀统一 `mcp:`，`--json` 里逐 id 可取（CI 与真机试验都靠它们销记）。
 *
 * 分工与退出码：只有 `mcp:parse` 是 FAIL（文件级解析失败 = 全员停发，必须挡住），
 * 其余三条都是成员自己能解决的状态，一律 WARN，不参与 `fails>0 ? 1 : 0` 的判据。
 */
function mcpParseCheck(snapshot: Snapshot | null, config: Config | null): Check {
  if (snapshot === null) {
    // 无 config 与"仓库暂不可达且无本地快照"必须分开说：后者不能与"仓库里没有 mcp 条目"
    // 的 PASS 文案混同（成员会以为团队没配 MCP，其实是没连上仓库，无法确认）。
    if (config === null) {
      return {
        id: 'mcp:parse',
        status: 'WARN',
        message: '没有可用快照，未检查 mcp 列表文件',
        hint: '联网后重跑 ejdrone doctor',
      };
    }
    return {
      id: 'mcp:parse',
      status: 'WARN',
      message: '无法确认仓库里有没有 mcp 条目（仓库暂不可达且无本地快照，不能当成"没有 mcp 条目"）',
      hint: '联网后重跑 ejdrone doctor；mcp:parse 的 PASS/FAIL 判定要等仓库可达后才能给出',
    };
  }
  if (snapshot.mcpFileError !== null) {
    return {
      id: 'mcp:parse',
      status: 'FAIL',
      message: `mcp 列表文件解析失败，本次 mcp 已停发、已装内容不动：${snapshot.mcpFileError}`,
      hint: `修好 ${snapshot.dir}/mcp/mcp.yaml（顶层必须是带 servers: 列表的映射）后 ejdrone pull`,
    };
  }
  const count = snapshot.kinds.mcp.length;
  return {
    id: 'mcp:parse',
    status: 'PASS',
    message:
      count === 0
        ? '仓库里没有 mcp/ 条目（mcp/mcp.yaml 缺席 = 该 kind 空集，不是错误）'
        : `mcp 列表文件可解析，${count} 条 server`,
  };
}

function mcpVarCheck(ctx: CliContext, config: Config | null, snapshot: Snapshot | null): Check {
  const idle = (message: string, hint?: string): Check => ({ id: 'mcp:var', status: 'WARN', message, hint });
  if (!config || !snapshot) return idle('没有 config 或快照，未检查 MCP 环境变量', 'ejdrone init <repo-url>');
  if (snapshot.mcpFileError !== null) {
    return idle('mcp 已停发（见 mcp:parse），未检查环境变量');
  }
  const { namespaces } = activeNamespaces(config, snapshot.manifest);
  const candidates = resolve({ kinds: snapshot.kinds, activeNamespaces: namespaces }).kinds.mcp;
  // 只看真的会投给本机的那部分：`tools:` 把 server 限定到没勾的工具时，缺变量不该来烦这个成员
  const capable = new Set(config.agents.filter((id) => mcpTargetPath(id, ctx.home, ctx.env) !== null));
  const applicable = candidates.filter((r) => {
    const tools = mcpPayload(r).tools;
    return !tools || tools.some((t) => capable.has(t));
  });
  const { skipped } = resolveMcpResources(applicable, ctx.env);
  if (skipped.length === 0) {
    return {
      id: 'mcp:var',
      status: 'PASS',
      message:
        applicable.length === 0
          ? '没有需要解析环境变量的 MCP 条目'
          : `${applicable.length} 条 server 的 \${VAR} 均能取到值`,
    };
  }
  return {
    id: 'mcp:var',
    status: 'WARN',
    message: `${skipped.length} 条 server 的环境变量取不到值，pull 会整条跳过并点名：${skipped
      .map((s) => `"${s.name}" 缺 ${s.missing.map((v) => `\${${v}}`).join('、')}`)
      .join('；')}`,
    // 只出变量名与设置方法，值永不出现（设计文档 §10 第 4 条）
    hint: skipped.flatMap((s) => s.missing.map((v) => `export ${v}='<该凭据的值>'（server "${s.name}"）`)).join('\n'),
  };
}

function mcpManagedCheck(audited: { ledger: Ledger; audit: LedgerAudit } | null, ledgerExists: boolean): Check {
  if (!ledgerExists) {
    return { id: 'mcp:managed', status: 'PASS', message: '尚无投递记账，没有受管条目可核对' };
  }
  if (audited === null) {
    return { id: 'mcp:managed', status: 'WARN', message: '账本不可读，未核对受管的 MCP 条目（见 ledger 项）' };
  }
  const managed = audited.ledger.entries.filter((e) => Object.keys(e.managedKeys ?? {}).length > 0);
  if (managed.length === 0) {
    return { id: 'mcp:managed', status: 'PASS', message: '账本里没有受管的 MCP 条目（本机还没投过）' };
  }
  const bad = [
    ...audited.audit.modified.filter((e) => e.resource.startsWith('mcp:')),
    ...audited.audit.missing.filter((e) => e.resource.startsWith('mcp:')),
  ];
  if (bad.length === 0) {
    return {
      id: 'mcp:managed',
      status: 'PASS',
      message: `${managed.length} 个落点文件里的受管条目与账本一致`,
    };
  }
  return {
    id: 'mcp:managed',
    status: 'WARN',
    message: `${managed.length} 个落点文件里有 ${bad.length} 个的受管条目与账本不一致（你改过或已删掉）`,
    hint: `${bad.map((e) => `${e.path}（${Object.keys(e.managedKeys ?? {}).join('、')}）`).join('\n')}\n这些条目 pull 不会覆盖，只在点名里列出；想让团队的版本重新生效，就把那几条改回原样或直接删掉。`,
  };
}

function mcpTargetCheck(ctx: CliContext, config: Config | null): Check {
  if (!config) {
    return { id: 'mcp:target', status: 'WARN', message: '没有 config，未检查 MCP 落点', hint: 'ejdrone init <repo-url>' };
  }
  if (config.agents.length === 0) {
    return { id: 'mcp:target', status: 'WARN', message: '还没选定工具，无 MCP 落点可查', hint: 'ejdrone init --agent <ids>' };
  }
  const missing = config.agents.filter(
    (id) => TOOL_PATHS[id] !== undefined && mcpTargetPath(id, ctx.home, ctx.env) === null,
  );
  if (missing.length === 0) {
    return { id: 'mcp:target', status: 'PASS', message: `选定的 ${config.agents.length} 个工具都有用户级 MCP 落点` };
  }
  return {
    id: 'mcp:target',
    status: 'WARN',
    message: `选定工具有 ${missing.length} 个没有用户级 MCP 落点，因此收不到团队的 mcp 条目：${missing.join('、')}`,
    hint: '这些工具的 MCP 配置请手动维护（只有项目级落点的尤其如此）；团队侧可在条目里用 tools: 把它们排除，免得别人以为全员生效',
  };
}

/**
 * agents 落点检查（M7 T7.5）：只勾「有落点定义」的选定工具（能力有无由 paths.ts 决定，
 * 没落点的工具由 agents kind 的采集/投递自然跳过，不在这里刷屏）。
 * 目录不存在 → WARN：可能是首次 pull 还没创建（apply 按需建目录），也可能是工具根本没装 ——
 * 两种都要点名而不是猜。agents 冲突停发的点名由 roles:conflict 一条统一负责（它逐 kind 列）。
 */
function agentsTargetCheck(ctx: CliContext, config: Config | null): Check {
  if (!config) {
    return { id: 'agents:target', status: 'WARN', message: '没有 config，未检查 agents 落点', hint: 'ejdrone init <repo-url>' };
  }
  if (config.agents.length === 0) {
    return { id: 'agents:target', status: 'WARN', message: '还没选定工具，无 agents 落点可查', hint: 'ejdrone init --agent <ids>' };
  }
  const targets = config.agents
    .map((id) => {
      const t = TOOL_PATHS[id] === undefined ? null : agentsTarget(id, ctx.home, ctx.env);
      return t ? { id, dir: t.dir } : null;
    })
    .filter((t): t is { id: string; dir: string } => t !== null);
  if (targets.length === 0) {
    return {
      id: 'agents:target',
      status: 'PASS',
      message: `选定的 ${config.agents.length} 个工具都没有用户级 agents 落点（团队的 agents/ 不下发给它们）`,
    };
  }
  const missing = targets.filter((t) => !existsSync(t.dir));
  if (missing.length === 0) {
    return {
      id: 'agents:target',
      status: 'PASS',
      message: `${targets.length} 个有 agents 落点的选定工具，目录均存在`,
    };
  }
  return {
    id: 'agents:target',
    status: 'WARN',
    message: `${missing.length} 个工具定义了 agents 落点但目录不存在：${missing.map((t) => `${t.id}（${t.dir}）`).join('、')}`,
    hint: '首次 ejdrone pull 会创建该目录（仓库里有 agents/ 条目时）；若该工具其实没安装，重新 ejdrone init --force 去掉它',
  };
}

/**
 * 团队知识镜像检查（M8 T8.5）。镜像不在任何工具目录里，`agents:target` 那类检查覆盖不到它，
 * 而它的失效方式恰好是最难自己发现的那一种：`recall` 检索不到，看起来像"团队没有相关资料"。
 * 所以这里只回答一个问题 —— 仓库里到底有没有、本机这份镜像到没到位。
 */
function knowledgeCheck(
  ctx: CliContext,
  snapshot: Snapshot | null,
  audited: { ledger: Ledger; audit: LedgerAudit } | null,
): Check {
  if (snapshot === null) {
    return { id: 'knowledge:mirror', status: 'WARN', message: '未读到仓库快照，未检查知识镜像', hint: 'ejdrone doctor 需要本地 clone 可用' };
  }
  const repoCount = snapshot.kinds.docs.length + snapshot.kinds.learnings.length;
  const dir = knowledgeDir(ctx.env);
  if (repoCount === 0) {
    return { id: 'knowledge:mirror', status: 'PASS', message: `仓库里没有 docs/ 与 learnings/ 条目（${dir} 无用武之地）` };
  }
  if (!existsSync(dir)) {
    return {
      id: 'knowledge:mirror',
      status: 'WARN',
      message: `仓库里有 ${repoCount} 份团队知识，但本机镜像目录不存在（${dir}）`,
      hint: '运行 ejdrone pull；在那之前 `ejdrone recall` 会说"镜像还不存在"，那不是"团队没有资料"',
    };
  }
  const entries = (audited?.ledger.entries ?? []).filter((e) => isKnowledgePath(e.path, ctx.env));
  if (entries.length === 0) {
    return {
      id: 'knowledge:mirror',
      status: 'WARN',
      message: `镜像目录存在但没有知识类记账条目（${dir}）`,
      hint: '运行 ejdrone pull —— 没有记账的镜像文件不是我们投的，pull 不会覆盖也不会删除它们',
    };
  }
  const troubled = [...(audited?.audit.modified ?? []), ...(audited?.audit.missing ?? [])].filter((e) =>
    isKnowledgePath(e.path, ctx.env),
  );
  if (troubled.length > 0) {
    return {
      id: 'knowledge:mirror',
      status: 'WARN',
      message: `${troubled.length}/${entries.length} 份镜像文档被本地改过或已不在：${troubled.map((e) => `${e.resource}（${e.path}）`).join('、')}`,
      hint: 'pull 会保留你的版本并点名，不会覆盖；想让团队版本落回来就先删掉本地那份',
    };
  }
  return { id: 'knowledge:mirror', status: 'PASS', message: `${entries.length} 份团队知识已在镜像里（${dir}）` };
}

/**
 * 账本损坏时的 hint（A-1/F7）："删账本恢复"对两类记账的含义不同——
 * - 整文件记账：删了下次 pull 重新记账，成立；
 * - merge 受管条目（managedKeys）：账本没了 → previous 为空 → 规则 6 把文件里的团队条目
 *   判成 foreign-entry **永久冻结**，既不随团队更新也不再被记账。对这类必须先点名受管
 *   文件路径，让成员手动清理后再重新投递，否则成员被引到"以为恢复了、其实已冻结"的状态。
 * 只从坏账本里 best-effort 提取路径（绝不读内容）；提取不到就退回普通文案。
 */
function ledgerFailHint(ledgerFile: string): string {
  const managed = managedPathsInBrokenLedger(ledgerFile);
  if (managed.length > 0) {
    return (
      `删除 ${ledgerFile} 后重新 ejdrone pull 之前，先手动清理这些受管条目所在的文件：${managed.join('、')}。` +
      '账本删除后，这些文件里的团队条目会被当作他人条目冻结、不再随团队更新，需先手动清理再重新投递'
    );
  }
  return (
    `删除 ${ledgerFile} 后重新 ejdrone pull（账本丢失只会让下次 pull 重新记账；` +
    '被你改过的文件需先删除，下一次 pull 才会重新接管）'
  );
}

/** 从结构已坏的账本文件里提取带 managedKeys 的条目路径；解析不了返回空数组（只读路径，不读内容）。 */
function managedPathsInBrokenLedger(ledgerFile: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ledgerFile, 'utf8'));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    return [];
  }
  const paths: string[] = [];
  for (const raw of (parsed as { entries: unknown[] }).entries) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as { path?: unknown; managedKeys?: unknown };
    if (typeof entry.path !== 'string') continue;
    const keys = entry.managedKeys;
    if (keys !== null && typeof keys === 'object' && Object.keys(keys as object).length > 0) {
      paths.push(entry.path);
    }
  }
  return paths;
}

export async function doctorCommand(
  ctx: CliContext,
  options: DoctorOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const checks: Check[] = [];
  const notes: string[] = [];
  /**
   * M10：win:hookbash 的采集桶 —— 每条「已安装 hook 的命令」一项
   * （label = 工具名，bash = 命令里的 bash 段（POSIX 形态为 null），exists = 该文件是否存在）。
   * 只在 isWindows(platform) 时采集与输出；POSIX 下既不采集也不出现，--json 逐字节不变。
   */
  const winHookBash: { label: string; bash: string | null; exists: boolean }[] = [];
  const add = (check: Check): void => {
    checks.push(check);
  };
  const note = (text: string): void => {
    if (!options.json) notes.push(text);
  };

  const configResult = requireConfig(ctx);
  let config: Config | null = null;
  if (configResult.ok) {
    config = configResult.config;
    add({
      id: 'config',
      status: 'PASS',
      message: `${configPath(ctx.env)} 合法（repo=${config.repo}，provider=${config.provider}，工具=${config.agents.join(', ') || '无'}，角色=${config.primaryRole ?? '无'}）`,
    });
  } else {
    add({ id: 'config', status: 'FAIL', message: configResult.error, hint: configResult.nextStep });
  }

  let snapshot: Snapshot | null = null;
  if (config) {
    const loaded = await openSnapshot(ctx, config.repo);
    if (loaded.ok) {
      snapshot = loaded.snapshot;
      add({
        id: 'repo',
        status: 'PASS',
        message: `${config.repo} 可达，默认分支 ${snapshot.branch}，commit ${snapshot.head.slice(0, 12)}`,
      });
    } else {
      snapshot = readExistingSnapshot(ctx);
      add({
        id: 'repo',
        status: 'WARN',
        message: `仓库暂时同步不了（离线或权限不足）：${loaded.error}`,
        hint: snapshot
          ? '联网后重跑 ejdrone pull；以下检查基于本地已有快照，可能不是最新'
          : '检查网络与仓库访问权限后重跑 ejdrone doctor',
      });
    }
  } else {
    add({ id: 'repo', status: 'WARN', message: '没有 config，未检查仓库连通性', hint: 'ejdrone init <repo-url>' });
  }

  if (snapshot === null) {
    add({ id: 'manifest', status: 'WARN', message: '没有可用快照，跳过 manifest 检查', hint: '先让 config 与仓库连通，再 ejdrone doctor' });
  } else if (snapshot.manifestError) {
    add({
      id: 'manifest',
      status: 'FAIL',
      message: snapshot.manifestError,
      hint: `修正 ${snapshot.dir}/manifest/roles.yaml 后 ejdrone pull`,
    });
  } else if (snapshot.manifest === null) {
    add({ id: 'manifest', status: 'PASS', message: '仓库没有 manifest/roles.yaml —— 未启用角色，只下发根条目' });
  } else {
    add({
      id: 'manifest',
      status: 'PASS',
      message: `解析成功，角色：${snapshot.manifest.roles.map((r) => r.id).join(', ') || '（空）'}`,
    });
    const declared = new Set(snapshot.manifest.roles.flatMap((r) => r.namespaces));
    const orphans = [...new Set(allResources(snapshot.kinds).map((r) => r.namespace))].filter(
      (ns) => ns !== '' && !declared.has(ns),
    );
    for (const ns of orphans) note(`提示：namespace「${ns}」有条目但没有任何角色引用它，pull 不会下发`);
    for (const warning of snapshot.warnings) note(`提示：${warning}`);
    // F4：pull 会停发/告警的两类问题，doctor 原来盲区。复用现成的 resolve/activeNamespaces
    // 纯函数，只加 WARN 不改退出码判据（WARN 不计入 fails>0 ? 1 : 0）。
    if (config !== null) {
      const { namespaces } = activeNamespaces(config, snapshot.manifest);
      const resolution = resolve({ kinds: snapshot.kinds, activeNamespaces: namespaces });
      // 'mcp' 的停发由 mcpFileError 触发、mcp:parse 已覆盖，这里只点名 skills/rules 的冲突
      const conflicted = resolution.haltedKinds.filter((kind) => kind !== 'mcp');
      if (conflicted.length > 0) {
        add({
          id: 'roles:conflict',
          status: 'WARN',
          message: `${conflicted.join('、')} 类型存在双 namespace 同名冲突：pull 会停发该类型、已装内容保留`,
          hint: '调整仓库目录使同一 namespace 与根目录不再重名，然后重新 ejdrone pull',
        });
      }
      const subscribed = [
        ...(config.primaryRole !== null ? [config.primaryRole] : []),
        ...config.additionalRoles,
      ];
      const knownRoles = new Set(snapshot.manifest.roles.map((r) => r.id));
      const unknownRoles = subscribed.filter((id) => !knownRoles.has(id));
      if (unknownRoles.length > 0) {
        add({
          id: 'roles:unknown',
          status: 'WARN',
          message: `本地订阅的角色不在 manifest 里：${unknownRoles.join('、')}（这些角色的 namespace 不会下发）`,
          hint: 'ejdrone roles set <manifest 里有的角色 id>；或让管理员把该角色加进 manifest/roles.yaml',
        });
      }
    }
  }

  if (config) {
    for (const id of config.agents) {
      const adapter = registry().byId(id);
      if (!adapter) {
        add({
          id: `agent:${id}`,
          status: 'FAIL',
          message: `config 里的工具 id「${id}」不存在`,
          hint: `ejdrone init ${config.repo} --force --agent ${config.agents.filter((a) => a !== id).join(',')}，可选 ${registry().ids().join(', ')}`,
        });
        continue;
      }
      const detected = adapter.detect(ctx.home, ctx.env);
      add({
        id: `agent:${id}`,
        status: detected ? 'PASS' : 'WARN',
        message: detected ? `${adapter.label} 已探测到（根目录存在）` : `${adapter.label} 的根目录不存在`,
        hint: detected ? undefined : `安装该工具，或重新 ejdrone init --force --agent 去掉 ${id}`,
      });

      const target = hookTarget(id, ctx.home, ctx.env);
      if (!target) {
        add({
          id: `hook:${id}`,
          status: 'WARN',
          message: `${adapter.label} 没有 hook 落点定义`,
          hint: '请手动定期运行 ejdrone pull',
        });
      } else if (!existsSync(target.path)) {
        add({
          id: `hook:${id}`,
          status: 'FAIL',
          message: `${target.path} 不存在，hook 从未安装`,
          hint: '重跑 ejdrone init <repo> --force（会重新安装 hook）',
        });
      } else if (hasHook(target.path, target.event)) {
        // 光"条目在"不够：nvm 换版本、npm 全局升级换目录后，绝对路径会指向已消失的入口，
        // 自动 pull 就此断掉而没人知道。这里核对命令里的两个路径是否还活着。
        const cmd = installedHookCommand(target.path, target.event);
        // M10：Windows 形态核对复用同一份命令（不重复读文件）；POSIX 不采集
        if (isWindows(platform) && cmd !== null) {
          const bash = parseHookBash(cmd);
          winHookBash.push({ label: adapter.label, bash, exists: bash !== null && existsSync(bash) });
        }
        const paths = cmd === null ? null : parseHookPaths(cmd);
        if (paths === null) {
          add({
            id: `hook:${id}`,
            status: 'WARN',
            message: `${adapter.label} 的 hook 命令读不出 node/cli 绝对路径`,
            hint: `重跑 ejdrone init ${config.repo} --force`,
          });
        } else if (!existsSync(paths.node) || !existsSync(paths.cli)) {
          add({
            id: `hook:${id}`,
            status: 'FAIL',
            message: `${adapter.label} 的 hook 指向已不存在的入口（cli=${paths.cli}），会话自动 pull 已失效`,
            hint: '重跑 ejdrone init <repo> --force 以重新写入当前绝对路径',
          });
        } else if (!samePath(paths.cli, currentCliEntry(ctx.env), platform)) {
          // M10：win32 上大小写/斜杠不一致（npm 全局升级换过盘符大小写等）不是"另一份安装"，
          // 裸字符串比较会误报 —— 与 ledger 的路径比较同一口径（POSIX 下 samePath 就是 ===）。
          add({
            id: `hook:${id}`,
            status: 'WARN',
            message: `${adapter.label} 的 hook 指向另一份安装（${paths.cli}），与当前运行的 ejdrone 不是同一份`,
            hint: '重跑 ejdrone init <repo> --force',
          });
        } else {
          add({ id: `hook:${id}`, status: 'PASS', message: `${target.path} 已注册 ${target.event} hook` });
        }
      } else {
        add({
          id: `hook:${id}`,
          status: 'FAIL',
          message: `${target.path} 存在但缺少我们的 ${target.event} hook`,
          hint: '重跑 ejdrone init <repo> --force 以重新安装 hook',
        });
      }
    }
    if (config.agents.length === 0) {
      add({
        id: 'agent',
        status: 'FAIL',
        message: 'config.agents 为空，pull 不会投递任何内容',
        hint: `ejdrone init ${config.repo} --force --agent ${registry().ids().join(',')}`,
      });
    }
  }

  const ledgerFile = ledgerPath(ctx.env);
  /** mcp:managed 复用同一份账本核对结果，不再读第二遍磁盘 */
  let audited: { ledger: Ledger; audit: LedgerAudit } | null = null;
  if (!existsSync(ledgerFile)) {
    add({ id: 'ledger', status: 'PASS', message: '尚无投递记录（首次 pull 后会生成）' });
  } else {
    const { ledger, warning } = loadLedger(ledgerFile);
    if (warning) {
      add({
        id: 'ledger',
        status: 'FAIL',
        message: warning,
        hint: ledgerFailHint(ledgerFile),
      });
    } else {
      const audit = auditLedger(ledger);
      audited = { ledger, audit };
      const details = [
        ...audit.modified.map((e) => `本地改过：${e.path}`),
        ...audit.missing.map((e) => `文件已不在：${e.path}`),
      ];
      add({
        id: 'ledger',
        status: details.length === 0 ? 'PASS' : 'WARN',
        message:
          details.length === 0
            ? `${ledger.entries.length} 条记账与磁盘内容一致`
            : `${ledger.entries.length} 条记账中 ${details.length} 条不一致`,
        hint: details.length === 0 ? undefined : `这些文件 pull 会被保留（绝不覆盖）：\n${details.join('\n')}`,
      });
    }
  }

  // ------------------------------------------ M10：Windows 三项（仅 Windows 出现）
  // 仅当 isWindows(platform) 为 true 时追加；POSIX 下这三条一条都不加，
  // --json 输出与现在逐字节一致（硬约束）。退出码规则不变：FAIL 计入 fails>0 ? 1 : 0。
  if (isWindows(platform)) {
    const gitBash = findGitBash(ctx.env, platform);
    if (gitBash !== null) {
      add({ id: 'win:gitbash', status: 'PASS', message: `已找到 Git for Windows 的 bash.exe：${gitBash}` });
    } else {
      add({
        id: 'win:gitbash',
        status: 'FAIL',
        message: '未找到 Git for Windows 的 bash.exe，hook 无法在 Windows 上工作',
        hint:
          '安装 Git for Windows：https://git-scm.com/download/win 。\n' +
          '不要退而求其次用 PATH 上的裸 bash：它可能解析到 WSL 启动器，跑起来的不是 MSYS2 环境，Node 18 跑不动我们的产物，hook 会静默崩——必须锁定 Git 安装目录下的 bin\\bash.exe。',
      });
    }

    const gitPath = whichWithPathext('git', ctx.env, platform);
    if (gitPath !== null) {
      add({ id: 'win:git', status: 'PASS', message: `git 在 PATH 上（${gitPath}）` });
    } else {
      add({
        id: 'win:git',
        status: 'FAIL',
        message: 'git 不在 PATH 上，pull 依赖 git 同步团队仓库',
        hint: '安装 Git for Windows 会同时带上 git：https://git-scm.com/download/win ，装完重开终端让 PATH 生效',
      });
    }

    // hook 命令里的 bash 段核对：agent 循环里采集到的全部命令汇总成这一条。
    // 全健康 → PASS；有指向不存在文件的 → FAIL；没断链但有 POSIX 旧形态的 → WARN；
    // 一条命令都没采集到（没选定工具 / 都没装 hook）→ 不加，那种情况 hook:<id> 已覆盖。
    if (winHookBash.length > 0) {
      const broken = winHookBash.filter((f) => f.bash !== null && !f.exists);
      const legacy = winHookBash.filter((f) => f.bash === null);
      if (broken.length > 0) {
        add({
          id: 'win:hookbash',
          status: 'FAIL',
          message: `${broken.length} 个工具的 hook 命令指向不存在的 bash：${broken.map((f) => `${f.label} → ${f.bash}`).join('；')}`,
          hint: '重跑 ejdrone init <repo> --force（hook 命令会按当前平台重写）',
        });
      } else if (legacy.length > 0) {
        add({
          id: 'win:hookbash',
          status: 'WARN',
          message: `${legacy.length} 个工具的 hook 命令还是 POSIX 形态（没有 Git Bash 段），Windows 上跑不起来：${legacy.map((f) => f.label).join('、')}`,
          hint: '重跑 ejdrone init <repo> --force，把 hook 命令重写为 Git Bash 形态',
        });
      } else {
        add({
          id: 'win:hookbash',
          status: 'PASS',
          message: `${winHookBash.length} 个工具的 hook 命令均指向存在的 bash.exe`,
        });
      }
    }
  }

  // ------------------------------------------------------------- M6：mcp 四项
  // 退出码规则不变（fails>0 ? 1 : 0），--json 里这四项照常出现：只有"文件解析失败"配得上 FAIL，
  // 其余三条都是"成员能自己解决"的现场（缺变量、改过条目、工具没落点）。
  add(mcpParseCheck(snapshot, config));
  add(mcpVarCheck(ctx, config, snapshot));
  add(mcpManagedCheck(audited, existsSync(ledgerFile)));
  add(mcpTargetCheck(ctx, config));
  add(agentsTargetCheck(ctx, config));
  add(knowledgeCheck(ctx, snapshot, audited));

  // 未核对落点只报"你真的选定了"的工具：16 工具后若仍列全表，
  // 每人 init 时勾了 2-3 个也会被十几条无关 WARN 刷屏，WARN 就此没人看。
  const selected = new Set(config?.agents ?? []);
  const unverified = registry()
    .all()
    .filter((adapter) => probeUnverified(adapter.id))
    .map((adapter) => adapter.id);
  const mine = unverified.filter((id) => selected.has(id));
  const others = unverified.filter((id) => !selected.has(id));

  if (mine.length > 0) {
    add({
      id: 'probe',
      status: 'WARN',
      message: `你选定的工具有 ${mine.length} 个落点未真机核对：${mine.join('、')}`,
      hint: mine.map((id) => `${id}: ${TOOL_PATHS[id]?.probe ?? ''}`).join('\n'),
    });
  } else if (selected.size === 0) {
    add({ id: 'probe', status: 'PASS', message: '尚未选定工具，无落点需要核对' });
  } else {
    add({ id: 'probe', status: 'PASS', message: '所选工具的落点均已真机核对' });
  }
  if (others.length > 0) {
    note(`提示：另有 ${others.length} 个未选定工具的落点未真机核对（${others.join('、')}），你没勾这些工具，不影响你`);
  }

  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARN').length;

  if (options.json) {
    ctx.out(
      JSON.stringify(
        {
          ok: fails === 0,
          summary: { pass: checks.length - fails - warns, warn: warns, fail: fails },
          checks,
          notes,
        },
        null,
        2,
      ),
    );
    return fails > 0 ? 1 : 0;
  }

  for (const check of checks) {
    ctx.out(`[${check.status}] ${check.id}：${check.message}`);
    if (check.hint) ctx.out(`        下一步：${check.hint.split('\n').join('\n        ')}`);
  }
  for (const text of notes) ctx.out(text);
  ctx.out('');
  ctx.out(`检查完成：${checks.length - fails - warns} 项通过，${warns} 项警告，${fails} 项失败`);
  return fails > 0 ? 1 : 0;
}
