#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { AGENT_IDS } from './agents/index.js';
import type { CliContextInput } from './cli/context.js';
import { collect, createContext, reportError, type CliContext } from './cli/context.js';
import { doctorCommand, type DoctorOptions } from './cli/doctor.js';
import { initCommand, type InitOptions } from './cli/init.js';
import { listCommand, type ListOptions } from './cli/list.js';
import { pullCommand, type PullOptions } from './cli/pull.js';
import { pushCommand, type PushOptions } from './cli/push.js';
import { readmeCommand } from './cli/readme.js';
import { removeCommand } from './cli/remove.js';
import { rolesAdd, rolesList, rolesRemove, rolesSet, type RolesAddOptions, type RolesSetOptions } from './cli/roles.js';
import { statusCommand } from './cli/status.js';
import { uninstallCommand, type UninstallOptions } from './cli/uninstall.js';

const VERSION = '0.1.0';

export type { CliContextInput } from './cli/context.js';

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * 把 argv 跑成退出码：绝不调用 process.exit，端到端测试因此能在同进程里断言。
 * 真实入口只在 `ejdrone ...`（或 node dist/cli.js ...）时生效。
 */
export async function runCli(argv: string[], input: CliContextInput = {}): Promise<number> {
  const ctx: CliContext = createContext(input);
  let code = 0;

  // commander 的 action 参数顺序是「位置参数… → options → command」，这里原样转发
  type CommandFn = (...args: any[]) => Promise<number>;

  const guard =
    (handler: CommandFn): ((...args: any[]) => Promise<void>) =>
    async (...args) => {
      try {
        code = await handler(...args);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        reportError(ctx, `命令未能完成：${message}`, '运行 ejdrone doctor 查看当前状态；加 EJDRONE_DEBUG=1 可看到堆栈');
        if (ctx.env.EJDRONE_DEBUG && e instanceof Error) ctx.err(e.stack ?? e.message);
        code = 1;
      }
    };

  const program = new Command('ejdrone');
  program
    .description(
      '把 Git 仓库当唯一真相源，按角色把团队 skills/rules 裁剪投递到各 AI 工具的原生目录（只有 user scope）',
    )
    .version(VERSION, '-v, --version', '打印版本')
    .showHelpAfterError('下一步：ejdrone --help 看全部命令')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.out(stripTrailingNewline(text)),
      writeErr: (text) => ctx.err(stripTrailingNewline(text)),
    });

  program
    .command('init')
    .description('初始化：选定工具与角色、装 hook、首次 pull')
    .argument('[repo]', '团队仓库地址（git clone 可用）')
    .option('--agent <ids>', `逗号分隔的工具 id（可选：${AGENT_IDS.join(', ')}）`)
    .option('--role <id>', '主角色 id（非交互时用；缺省则只下发根条目）')
    .option('--provider <name>', 'gitlab（自动开 MR）| git（只推分支，手动开 MR）；缺省按仓库主机名判定')
    .option('--force', '覆盖已有 config')
    .action(guard(async (repo: string | undefined, options: InitOptions) => initCommand(ctx, repo, options)));

  program
    .command('pull')
    .description('同步团队仓库并投递到各工具目录')
    .option('--silent', '静默模式（hook 用）：问题只写 ~/.ejdrone/debug.log，恒返回 0')
    .option('--force', '覆盖本地改过的整文件投递（区块文件只动团队区块）')
    .action(guard(async (options: PullOptions) => pullCommand(ctx, options)));

  program
    .command('push')
    .description('把本地 skill/rule 推到团队仓库（自动分支 + MR）')
    .option('--skill <path>', '要推送的 skill 目录或 SKILL.md，可重复', collect)
    .option('--rule <path>', '要推送的 rule 文件，可重复', collect)
    .option('--all', '推送选定工具目录里所有本地候选')
    .option('--role <id>', '按角色 id 推送（经 manifest 映射到它的 namespace；缺省用本地主角色）')
    .option('--ns <namespace>', '显式指定目标 namespace 目录（角色订阅多个 namespace 时用）')
    .action(guard(async (options: PushOptions) => pushCommand(ctx, options)));

  program
    .command('status')
    .description('报告 config、角色、待推送 / 落后 / 本地改动')
    .action(guard(async () => statusCommand(ctx)));

  program
    .command('list')
    .description('列出资源（默认团队仓库）')
    .argument('[kind]', 'skills | rules')
    .option('--source <source>', 'repo | local | all')
    .action(guard(async (kind: string | undefined, options: ListOptions) => listCommand(ctx, kind, options)));

  const roles = program.command('roles').description('角色：查看/切换本地订阅，管理员改团队 manifest');
  roles
    .command('list')
    .description('显示 manifest 里的角色与本地订阅')
    .action(guard(async () => rolesList(ctx)));
  roles
    .command('set')
    .description('切换本地主角色（只改本地 config）')
    .argument('[primary]', '角色 id')
    .option('--add <ids>', '逗号分隔的附加角色（整体替换现有附加角色）')
    .action(guard(async (primary: string | undefined, options: RolesSetOptions) => rolesSet(ctx, primary, options)));
  roles
    .command('add')
    .description('管理员：新增角色并开 MR 改写 manifest/roles.yaml')
    .argument('[id]', '角色 id')
    .option('--namespaces <ids>', '逗号分隔的 namespace，缺省与 id 同名')
    .option('-d, --description <text>', '角色说明')
    .action(guard(async (id: string | undefined, options: RolesAddOptions) => rolesAdd(ctx, id, options)));
  roles
    .command('remove')
    .description('管理员：从 manifest 移除角色并开 MR')
    .argument('[id]', '角色 id')
    .action(guard(async (id: string | undefined) => rolesRemove(ctx, id)));

  program
    .command('remove')
    .description('从团队仓库删除资源（走 MR；不动你本地副本）')
    .argument('<kind>', 'skills | rules')
    .argument('<names...>', '资源名，可多个')
    .action(guard(async (kind: string, names: string[]) => removeCommand(ctx, kind, names)));

  program
    .command('readme')
    .description('给团队仓库生成/更新首页说明书 README.md（走 MR；空仓库初始化时会自动带）')
    .action(guard(async () => readmeCommand(ctx)));

  program
    .command('doctor')
    .description('逐项体检：config / 仓库 / manifest / hook / 记账 / 落点核对状态')
    .option('--json', '机器可读输出（给 CI）')
    .action(guard(async (options: DoctorOptions) => doctorCommand(ctx, options)));

  program
    .command('uninstall')
    .description('移除 hook 与投递的文件（保留 config 和你改过的副本）')
    .option('--force', '跳过二次确认')
    .action(guard(async (options: UninstallOptions) => uninstallCommand(ctx, options)));

  if (argv.length === 0) {
    ctx.out(stripTrailingNewline(program.helpInformation()));
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    const error = e as { code?: string; exitCode?: number };
    if (typeof error.code === 'string' && error.code.startsWith('commander.')) {
      return typeof error.exitCode === 'number' ? error.exitCode : 1;
    }
    reportError(ctx, e instanceof Error ? e.message : String(e), '运行 ejdrone --help 查看用法');
    return 1;
  }
  return code;
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const normalize = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return normalize(entry) === normalize(self);
}

if (isDirectInvocation()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`致命错误：${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
