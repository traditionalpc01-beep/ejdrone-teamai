import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { TOOL_PATHS } from '../../src/agents/paths.js';
import { runCli, type CliContextInput } from '../../src/cli.js';
import { win32Hook } from '../../src/cli/constants.js';

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
    // Windows 上 env 键大小写不敏感，PATH 可能以 Path / path 形态出现（历史遗留的大小写抖动）
    PATH: process.env.PATH ?? process.env.Path ?? process.env.path ?? '/usr/bin:/bin',
    // 防向上发现：work 落在某个真实 git 仓库内时（开发机的工作区），`git -C <dir>` 会沿目录树
    // 向上找到外层仓库，继承它的 user.name/hooks——seed 提交假失败、测试被外层配置污染。
    // ceiling 只挡"向上找"，不影响 work 之内的 origin.git/seed/repo 各自是仓库。
    GIT_CEILING_DIRECTORIES: work,
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
      removeTree(work);
    },
  };
}

/**
 * Windows 上刚跑完 git 子进程的临时目录常还在被短暂占用，直接 rmSync 会 ENOTEMPTY / EBUSY /
 * EPERM（真机实测：一次 contribute 用例主体已过、cleanup 报错，把通过的用例记成失败）。
 * 重试几次即可放行；POSIX 上第一次就成功，行为不变。
 */
function removeTree(dir: string): void {
  const transient = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EMFILE', 'ENFILE']);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { force: true, recursive: true });
      return;
    } catch (e) {
      lastError = e;
      const code = (e as { code?: string }).code ?? '';
      if (!transient.has(code)) break;
      sleepMs(150);
    }
  }
  throw lastError;
}

/** 同步等待：cleanup 是同步钩子，不能 await。 */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 按当前 process.platform 推导期望的 hook 命令原文（与 src/cli/constants.ts 的 hookCommand 同形）：
 * POSIX 是 `EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent`；
 * win32 是 `<wrapper.cmd 正斜杠裸路径> EJDRONE_HOOK=1`（payload 在 wrapper 文件里，
 * 因为实测 `"<bash>" -lc "…"` 这种带引号首 token 在 PowerShell/pwsh 下是语法错误）；
 * win32 找不到 Git Bash 时返回 null —— 那种机器上 init 不装 hook，只打印安装指引。
 */
export function expectedHookCommand(env: NodeJS.ProcessEnv): string | null {
  const node = env.EJDRONE_NODE ?? process.execPath;
  const cli = env.EJDRONE_CLI ?? '';
  if (process.platform !== 'win32') return `EJDRONE_HOOK=1 '${node}' '${cli}' pull --silent`;
  // win32 直接委派给被测同一入口，避免测试里再复刻一份形态（形态改动只发生在一处）
  return win32Hook(env)?.command ?? null;
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
 * 往标准仓库里追加 MCP server：根一条 stdio（全员）+ be 一条 http（带 ${VAR}，只有 be 角色收到）。
 * 单独一个函数而不是塞进 seedTeamRepo —— 那会让十几个既有端到端断言因为与它们无关的原因改动。
 */
export function seedMcp(h: Harness): void {
  h.writeSeed(
    'mcp/mcp.yaml',
    [
      'servers:',
      '  - name: shared-formatter',
      '    description: 统一格式化',
      '    transport: stdio',
      '    command: npx',
      "    args: ['-y', '@acme/formatter-mcp']",
      '',
    ].join('\n'),
  );
  h.writeSeed(
    'mcp/be/mcp.yaml',
    [
      'servers:',
      '  - name: be-metrics',
      '    transport: http',
      '    url: https://metrics.example.com/mcp',
      '    headers:',
      '      Authorization: Bearer ${BE_METRICS_TOKEN}',
      '',
    ].join('\n'),
  );
  h.commitSeed('seed mcp servers');
}

/**
 * 往标准仓库里追加团队知识文档（M8 / owner B）：根一份 + be/fe 各一份，
 * 外加一个 `team-codebase` 保留名目录（采集层必须整目录跳过并告警）。
 * 单独一个函数而不是塞进 seedTeamRepo —— 与 MCP 那份同理：不让既有端到端断言
 * 因为与它们无关的原因改动。
 */
export function seedDocs(h: Harness): void {
  h.writeSeed(
    'docs/deploy.md',
    '---\ntitle: 发布流程\ntags: [deploy, 发布]\n---\n\n# 发布流程\n\n灰度发布先切 5% 流量，观察十分钟再放量。\n',
  );
  h.writeSeed(
    'docs/be/db-migrations.md',
    '---\ntitle: 数据库迁移规范\ntags: [mysql, 迁移]\n---\n\n改库必须写迁移脚本，禁止手工 ALTER。\n',
  );
  h.writeSeed(
    'docs/fe/react-style.md',
    '---\ntitle: 组件拆分优先\ntags: [react]\n---\n\n组件超过两百行就该拆。\n',
  );
  // teamai 的 codebase 知识图谱占用过的名字，我们禁用（父计划 §7.1）
  h.writeSeed('docs/team-codebase/architecture.md', '# 这份文档不该出现在任何人的机器上\n');
  h.commitSeed('seed docs');
}

/**
 * M7（owner A）：往标准仓库追加 agents 条目 —— 根一个（全员）+ be 一个（只有 be 角色收到）。
 * 与 seedMcp 同理单独成函数：塞进 seedTeamRepo 会波及一堆与 agents 无关的既有断言。
 * 两个文件都带**完整 frontmatter**，好让 md 落点的期望值能逐字节对拍。
 */
export const ROOT_AGENT_FILE = 'agents/review-assistant.md';
export const ROOT_AGENT_MD =
  '---\nname: review-assistant\ndescription: 评审助手\ntools: Read, Grep\nmodel: sonnet\n---\n\n# Review assistant\n\n逐步核对改动。\n';
export const NS_AGENT_FILE = 'agents/be/be-deploy-bot.md';
export const NS_AGENT_MD =
  '---\nname: be-deploy-bot\ndescription: 后端部署助手\n---\n\n# BE deploy bot\n\n按清单发布后端。\n';

export function seedAgents(h: Harness): void {
  h.writeSeed(ROOT_AGENT_FILE, ROOT_AGENT_MD);
  h.writeSeed(NS_AGENT_FILE, NS_AGENT_MD);
  h.commitSeed('seed team agents');
}

/**
 * M9（owner C）：往标准仓库追加 learnings 条目 —— 根一份（全员）+ be 一份（只有 be 角色收到）。
 * 文件名沿用 contribute 的落库形状 `<YYYY-MM-DD>-<slug>.md`（slug 允许中文），
 * 好让"contribute 撞名拒绝"与"镜像路径带日期名"两条端到端断言都用同一套名字。
 * 与 seedMcp/seedDocs 同理单独成函数：不让既有端到端断言因无关原因改动。
 */
export function seedLearnings(h: Harness): void {
  h.writeSeed(
    'learnings/2026-10-11-发布流程复盘.md',
    '---\ntitle: 发布流程复盘\ndate: 2026-10-11\ntags: [发布, deploy]\n---\n\n# 发布流程复盘\n\n上次回滚是因为灰度比例直接拉到了 100%。\n',
  );
  h.writeSeed(
    'learnings/be/2026-10-09-kafka积压处理.md',
    '---\ntitle: Kafka 积压处理\ndate: 2026-10-09\ntags: [kafka]\n---\n\n# Kafka 积压处理\n\n先扩消费者数量，再排查慢消息。\n',
  );
  h.commitSeed('seed learnings');
}

/**
 * 2.1（标签订阅）：往标准仓库追加带标条目 —— be ns 里一条带 ops-tools 标签的 skill、
 * 一条同 ns 未带标的对照、一条带标 rule，以及 be ns 的 MCP 文件（含带标 server）。
 * 与 seedMcp/seedDocs 同理单独成函数：不塞 seedTeamRepo，不波及既有断言。
 * 注意它独占 `mcp/be/mcp.yaml`：与 seedMcp 不能同仓使用（后者写同一文件）。
 */
export function seedTags(h: Harness): void {
  h.writeSeed(
    'skills/be/ops-helper/SKILL.md',
    '---\nname: ops-helper\ndescription: 运维助手\ntags: [ops-tools]\n---\n\n# Ops helper\n\n跨角色共用的运维工具。\n',
  );
  h.writeSeed('skills/be/ops-plain/SKILL.md', '# Ops plain\n\n同 ns 未带标，标签订阅不该把它带出来。\n');
  h.writeSeed('rules/be/ops-runbook.md', '---\ntags: [ops-tools]\n---\n\n# Ops runbook\n\n带标的运维 rule。\n');
  h.writeSeed(
    'mcp/be/mcp.yaml',
    ['servers:', '  - name: ops-relay', '    transport: stdio', '    command: npx', '    tags: [ops-tools]', ''].join('\n'),
  );
  h.commitSeed('seed tagged entries');
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
