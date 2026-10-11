import { existsSync } from 'node:fs';

import { allResources } from '../core/types.js';
import { registry } from '../agents/index.js';
import { hookTarget, TOOL_PATHS } from '../agents/paths.js';
import { hasHook, installedHookCommand } from '../hooks.js';
import { currentCliEntry, parseHookPaths } from './constants.js';
import { loadLedger } from '../core/ledger.js';
import type { Config } from '../core/types.js';
import { configPath, ledgerPath } from '../state.js';
import type { CliContext } from './context.js';
import { requireConfig } from './config.js';
import { auditLedger } from './ledgercheck.js';
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

export async function doctorCommand(ctx: CliContext, options: DoctorOptions): Promise<number> {
  const checks: Check[] = [];
  const notes: string[] = [];
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
        } else if (paths.cli !== currentCliEntry(ctx.env)) {
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
  if (!existsSync(ledgerFile)) {
    add({ id: 'ledger', status: 'PASS', message: '尚无投递记录（首次 pull 后会生成）' });
  } else {
    const { ledger, warning } = loadLedger(ledgerFile);
    if (warning) {
      add({
        id: 'ledger',
        status: 'FAIL',
        message: warning,
        hint: `删除 ${ledgerFile} 后重新 ejdrone pull（账本丢失只会让下次 pull 重新记账）`,
      });
    } else {
      const audit = auditLedger(ledger);
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
