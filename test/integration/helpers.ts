import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TOOL_PATHS } from '../../src/agents/paths.js';
import { runCli, type CliContextInput } from '../../src/cli.js';

/**
 * 端到端夹具：真实 git（`git init --bare` 当 origin），绝不 mock child_process。
 * 所有 HOME / EJDRONE_HOME 都是伪造目录，成员状态互相隔离。
 */

const ROLES_YAML = `version: 1
roles:
  - id: be
    description: 后端
    namespaces:
      - be
  - id: fe
    description: 前端
    namespaces:
      - fe
`;

function gitAt(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function commit(cwd: string, env: NodeJS.ProcessEnv, message: string): void {
  gitAt(cwd, env, '-c', 'user.name=Seed Bot', '-c', 'user.email=seed@example.com', 'commit', '-m', message);
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
  all: string;
}

export interface Member {
  name: string;
  home: string;
  state: string;
  env: NodeJS.ProcessEnv;
  run(args: string[], override?: Partial<CliContextInput>): Promise<RunResult>;
  path(...parts: string[]): string;
  read(...parts: string[]): string;
  exists(...parts: string[]): boolean;
  write(rel: string, content: string): void;
}

export interface Harness {
  work: string;
  origin: string;
  seed: string;
  member(name?: string): Member;
  /** 写文件进 seed 工作树（相对路径） */
  writeSeed(rel: string, content: string): void;
  removeSeed(rel: string): void;
  /** add + commit + push origin main */
  commitSeed(message: string): void;
  /** 把远端分支合进 main 并推上去（模拟 MR 被评审合入） */
  mergeIntoMain(branch: string): void;
  remoteBranches(): string[];
  seedRead(rel: string): string;
  cleanup(): void;
}

export function createHarness(): Harness {
  const work = mkdtempSync(join(tmpdir(), 'ejdrone-e2e-'));
  const origin = join(work, 'origin.git');
  const seed = join(work, 'seed');
  const emptyConfig = join(work, 'gitconfig-empty');
  writeFileSync(emptyConfig, '', 'utf8');

  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    EJDRONE_NONINTERACTIVE: '1',
  };

  gitAt(work, baseEnv, 'init', '--bare', '--initial-branch=main', origin);
  mkdirSync(seed, { recursive: true });
  gitAt(seed, { ...baseEnv, HOME: work }, 'init', '--initial-branch=main', '.');
  gitAt(seed, { ...baseEnv, HOME: work }, 'remote', 'add', 'origin', origin);

  const seedEnv: NodeJS.ProcessEnv = { ...baseEnv, HOME: work };

  const writeSeed = (rel: string, content: string): void => {
    const abs = join(seed, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  };

  const membersRoot = join(work, 'members');
  let memberIndex = 0;

  const member = (name?: string): Member => {
    const label = name ?? `m${(memberIndex += 1)}`;
    const home = join(membersRoot, label);
    mkdirSync(home, { recursive: true });
    // doctor 会核对 hook 命令里的绝对路径是否还存在，所以这里要给"真的存在"的路径
    const fakeCli = join(home, 'fake-ejdrone-cli.js');
    writeFileSync(fakeCli, '// 占位入口，只为让 doctor 认为 hook 指向有效路径\n', 'utf8');
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      HOME: home,
      EJDRONE_HOME: join(home, '.ejdrone'),
      EJDRONE_NODE: process.execPath,
      EJDRONE_CLI: fakeCli,
    };

    const run = async (args: string[], override: Partial<CliContextInput> = {}): Promise<RunResult> => {
      const outLines: string[] = [];
      const errLines: string[] = [];
      const code = await runCli(args, {
        env,
        home,
        cwd: home,
        interactive: false,
        out: (text) => outLines.push(text),
        err: (text) => errLines.push(text),
        ...override,
      });
      const out = outLines.join('\n');
      const err = errLines.join('\n');
      return { code, out, err, all: `${out}\n${err}` };
    };

    const absOf = (...parts: string[]): string => join(home, ...parts);

    return {
      name: label,
      home,
      state: env.EJDRONE_HOME as string,
      env,
      run,
      path: absOf,
      read: (...parts) => readFileSync(absOf(...parts), 'utf8'),
      exists: (...parts) => existsSync(absOf(...parts)),
      write: (rel, content) => {
        const abs = absOf(rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      },
    };
  };

  /** 让工具"探测"到某工具已安装：建出根目录 */
  return {
    work,
    origin,
    seed,
    member,
    writeSeed,
    removeSeed: (rel) => {
      rmSync(join(seed, rel), { force: true, recursive: true });
    },
    commitSeed: (message) => {
      gitAt(seed, seedEnv, 'add', '-A');
      const { stdout } = { stdout: gitAt(seed, seedEnv, 'status', '--porcelain') };
      if (stdout.trim() !== '') {
        commit(seed, seedEnv, message);
        gitAt(seed, seedEnv, 'push', 'origin', 'main');
      }
    },
    mergeIntoMain: (branch) => {
      gitAt(seed, seedEnv, 'fetch', 'origin');
      gitAt(seed, seedEnv, 'checkout', 'main');
      gitAt(seed, seedEnv, '-c', 'user.name=Merger', '-c', 'user.email=merger@example.com', 'merge', '--no-ff', '-m', `merge ${branch}`, `origin/${branch}`);
      gitAt(seed, seedEnv, 'push', 'origin', 'main');
    },
    remoteBranches: () =>
      gitAt(seed, seedEnv, 'ls-remote', '--heads', 'origin')
        .split('\n')
        .map((line) => line.split('\t')[1] ?? '')
        .filter((name) => name !== '')
        .map((name) => name.replace('refs/heads/', '')),
    seedRead: (rel) => readFileSync(join(seed, rel), 'utf8'),
    cleanup: () => {
      rmSync(work, { force: true, recursive: true });
    },
  };
}

/** 标准团队仓库：根条目 + be/fe 两个 namespace + 多文件 skill */
export function seedTeamRepo(h: Harness): void {
  h.writeSeed('manifest/roles.yaml', ROLES_YAML);
  h.writeSeed('skills/root-note/SKILL.md', '# Root note\n\n全员共享的发布流程。\n');
  h.writeSeed('skills/be/be-deploy/SKILL.md', '# BE deploy\n\n部署后端服务。\n');
  h.writeSeed('skills/be/be-deploy/scripts/run.sh', 'echo deploy\n');
  h.writeSeed('skills/fe/fe-review/SKILL.md', '# FE review\n\n前端评审清单。\n');
  h.writeSeed('rules/style.md', '# Style\n\n统一风格。\n');
  h.writeSeed('rules/be/db.md', '# DB rule\n\n改库要写迁移。\n');
  h.writeSeed('rules/fe/react.md', '# React rule\n\n组件拆分优先。\n');
  h.commitSeed('seed team assets');
}

/**
 * 伪造 HOME 下要"探测到"这些工具，就得先有它们的根目录。
 * 根目录名一律取自 paths.ts 的表 —— 硬编码表会在新增工具时静默回落成 `.<id>`，
 * 于是测试"装了"而适配器看的是另一个目录。
 */
export function installTools(member: Member, ids: string[]): void {
  for (const id of ids) {
    const spec = TOOL_PATHS[id];
    if (!spec) throw new Error(`installTools: paths.ts 里没有工具 ${id}`);
    mkdirSync(member.path(spec.rootRel), { recursive: true });
  }
}
