import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { CheckoutHandle, PrePushScan } from '../core/types.js';
import { API_CHECKOUT_MARKER, SYNC_INCOMPLETE_MARKER } from '../state.js';

const execFileAsync = promisify(execFile);

/**
 * 对团队仓库本地 clone 的所有 git 操作。
 *
 * 每条命令都走 `execFile('git', argv)`，绝不拼 shell 字符串 —— 分支名、URL、路径
 * 都来自配置或用户输入，拼接即注入。
 */

const DEFAULT_AUTHOR_NAME = 'ejdrone-teamai';
const DEFAULT_AUTHOR_EMAIL = 'ejdrone@local';

function gitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    // 无人值守（hook 触发的 pull / CI）时绝不卡在密码或凭据提示上
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };
}

interface GitResult {
  stdout: string;
  stderr: string;
}

async function git(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  try {
    const res = await execFileAsync('git', args, {
      env: gitEnv(opts.env),
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: res.stdout, stderr: res.stderr };
  } catch (e) {
    throw describeGitError(args, e);
  }
}

function describeGitError(args: string[], e: unknown): Error {
  const err = e as { stderr?: unknown; message?: unknown };
  const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
  const detail = stderr !== '' ? stderr : String(err.message ?? e);
  return new Error(
    `git ${scrubCredentials(args.join(' '))} failed: ${scrubCredentials(firstLines(detail, 3))}`,
  );
}

/** 仓库 URL 可能内嵌凭据（https://oauth2:tok@host），出错信息里要把它们抹掉 */
export function scrubCredentials(text: string): string {
  return text.replace(/(\w+):\/\/[^/\s@]*:[^/\s@]*@/g, '$1://***@');
}

function firstLines(text: string, count: number): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(0, count)
    .join(' | ');
}

async function isGitRepo(dir: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (!existsSync(dir)) return false;
  try {
    // 必须是"dir 自己就是仓库根"：状态目录若恰好落在某个别的仓库里，
    // rev-parse 会向上找到那个仓库，我们就会对它 fetch origin
    const { stdout } = await git(['-C', dir, 'rev-parse', '--show-toplevel'], { env });
    return samePath(stdout.trim(), dir);
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  return realpathOr(a) === realpathOr(b);
}

/** macOS 的 /var 与 /private/var 是同一目录的不同路径，比较前先归一化 */
function realpathOr(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/**
 * dir 不存在 / 不是仓库 → clone；已是仓库 → 先比对 origin 与传入 url，不一致就 set-url 再 fetch。
 * 不做任何 reset：工作树的同步是 fetchReset 的职责。
 *
 * 为什么必须比对 origin（F1）：`init --force <新repo>`（团队迁移仓库地址）后，已是仓库的分支
 * 原来只 `fetch origin`，从不更新 origin —— 本地 checkout 静默继续同步**旧**仓库：pull 拉旧的、
 * push 推旧的、doctor `repo` 项验的是旧的却报"可达"。返回 `relinked` 让调用方把这回事告诉用户。
 */
export async function ensureClone(
  url: string,
  dir: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ relinked: boolean }> {
  if (await isGitRepo(dir, env)) {
    let current: string | null = null;
    try {
      const { stdout } = await git(['-C', dir, 'remote', 'get-url', 'origin'], { env });
      current = stdout.trim();
    } catch {
      // 没有 origin（或读不到）：当作不一致走 set-url（它会创建/更新 origin）
      current = null;
    }
    if (current !== null && sameRepoUrl(current, url)) {
      await git(['-C', dir, 'fetch', 'origin'], { env });
      return { relinked: false };
    }
    await git(['-C', dir, 'remote', 'set-url', 'origin', url], { env });
    await git(['-C', dir, 'fetch', 'origin'], { env });
    return { relinked: true };
  }
  // dir 存在但不是 git 仓库：先看清里面是什么再决定动不动。
  // - 空目录（含不存在）：没有可丢的内容，直接 clone（git 本身允许 clone 进空目录）。
  // - 含 .git：rev-parse 失败多半是 .git 半损坏（断电残留 lock、对象缺失），里面可能有
  //   未推送的本地提交——绝不静默清空，让人来决定。
  // - 带免 git 链路的哨兵（API_CHECKOUT_MARKER / SYNC_INCOMPLETE_MARKER）：是 ejdrone
  //   自己的 API 同步产物，清掉再 clone（典型：机器从免 git 切回有 git）。
  // - 两者都不是：视为用户的目录（EJDRONE_HOME 可能被配到了真实数据目录），拒绝动它。
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  if (entries.length > 0) {
    if (entries.includes('.git')) {
      throw new Error(
        `${dir} 里有 .git 但不是可用仓库（可能半损坏，或有未推送的本地提交），拒绝自动清空。` +
          '下一步：确认不需要其中的本地内容后手动删除该目录，或修复 .git 后重跑',
      );
    }
    const ownedByApiSync =
      entries.includes(API_CHECKOUT_MARKER) || entries.includes(SYNC_INCOMPLETE_MARKER);
    if (!ownedByApiSync) {
      throw new Error(
        `${dir} 已存在、不是 git 仓库、也没有本工具的同步标记，拒绝清空（EJDRONE_HOME 是否指向了错误位置？）。` +
          '下一步：确认该目录内容可弃后手动删除，或修正 EJDRONE_HOME 后重跑',
      );
    }
    rmSync(dir, { recursive: true, force: true });
  }
  await git(['clone', url, dir], { env });
  return { relinked: false };
}

/**
 * 两个仓库地址是否指向同一个仓库（归一化比对）。团队迁仓库地址时常伴随三种等价差异，
 * 不归一就把"同一个仓库"误判成"换了仓库"：
 * - 内嵌凭据：`https://oauth2:tok@host/x` 与 `https://host/x` 是同一仓库。为什么不能只用
 *   本文件的 scrubCredentials：它把凭据换成 `***@` 占位，`https://***@host/x` 与
 *   `https://host/x` 仍不相等 —— 而成员 config 里写带凭据的地址、clone 出来的 origin 就是它；
 * - 尾部 `/` 与 `.git` 后缀：托管端两种形态都接受。
 * 本函数只用于比对，返回值不进任何输出，不存在凭据外泄面。
 */
export function sameRepoUrl(a: string, b: string): boolean {
  const normalize = (url: string): string => {
    const withoutCreds = url.trim().replace(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/[^/@]*@/, '$1://');
    return withoutCreds.replace(/\/+$/, '').replace(/\.git$/, '');
  };
  return normalize(a) === normalize(b);
}

async function remoteHasBranch(dir: string, branch: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await git(['-C', dir, 'ls-remote', '--heads', 'origin', branch], { env });
  return stdout.trim() !== '';
}

/** 远端是否已有任何分支/提交。新建的空团队仓库返回 false。 */
export async function remoteHasAnyCommit(dir: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await git(['-C', dir, 'ls-remote', '--heads', 'origin'], { env });
  return stdout.trim() !== '';
}

/**
 * 默认分支名。回落链：origin/HEAD → 远端的 main → 远端的 master → 'main'。
 * `git fetch` 不刷新 origin/HEAD（只有 clone / remote set-head 会），所以本地符号引用
 * 缺失或过期时必须能靠 ls-remote 探测出来。
 */
export async function defaultBranch(dir: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await git(['-C', dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      env,
    });
    const short = stdout.trim();
    if (short.startsWith('origin/')) return short.slice('origin/'.length);
    if (short !== '') return short;
  } catch {
    /* origin/HEAD 未设置，走远端探测 */
  }
  for (const candidate of ['main', 'master']) {
    try {
      if (await remoteHasBranch(dir, candidate, env)) return candidate;
    } catch {
      /* 探测失败（不可达的远端等）继续下一个 */
    }
  }
  return 'main';
}

/**
 * 同步到远端最新：fetch origin → reset --hard origin/<branch> → 返回 checkout 句柄。
 *
 * ⚠️ `reset --hard` 的语义前提：这是 ejdrone 自己拥有的**机器本地 clone**
 * （`<stateDir>/repo`），成员从不在里面编辑，丢弃本地工作树状态是正确行为。
 * 绝不要把本函数指向用户的工作仓库 —— 那会毁掉他们未提交的改动。
 */
export async function fetchReset(dir: string, branch?: string, env?: NodeJS.ProcessEnv): Promise<CheckoutHandle> {
  const target = branch ?? (await defaultBranch(dir, env));
  await git(['-C', dir, 'fetch', 'origin'], { env });

  // 刚建好的空仓库没有任何提交，reset origin/main 会以 "unknown revision" 失败，
  // 而设计流程的第一步正是在空仓库上 init。这里把它当合法状态：同步到"空"。
  if (!(await remoteHasAnyCommit(dir, env))) return { dir, head: '' };

  if (!(await remoteHasBranch(dir, target, env))) {
    const { stdout } = await git(['-C', dir, 'ls-remote', '--heads', 'origin'], { env });
    const names = stdout
      .split('\n')
      .map((line) => /refs\/heads\/(.+)$/.exec(line)?.[1]?.trim())
      .filter((name): name is string => Boolean(name));
    throw new Error(
      `远端没有分支 ${target}（现有分支：${names.join(', ') || '无'}）。` +
        '下一步：在团队仓库设置默认分支，或修正本地 origin/HEAD',
    );
  }

  await git(['-C', dir, 'reset', '--hard', `origin/${target}`], { env });
  const { stdout } = await git(['-C', dir, 'rev-parse', 'HEAD'], { env });
  return { dir, head: stdout.trim() };
}

/**
 * 批量写文件到 checkout。先整体校验再落盘，避免半个 plan 写坏工作树。
 * 路径穿越（`../`、绝对路径）一律抛错。
 */
export function writeFiles(dir: string, files: Record<string, string>): void {
  const root = resolve(dir);
  const targets: Array<{ abs: string; content: string }> = [];
  for (const [relPath, content] of Object.entries(files)) {
    targets.push({ abs: resolveInside(root, relPath), content });
  }
  for (const t of targets) {
    const parent = dirname(t.abs);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(t.abs, t.content, 'utf8');
  }
}

/**
 * checkout 内的路径安全校验（唯一 owner，gitless.ts 的 API 拉取与本文件的 writeFiles
 * 共用）：空路径、NUL、绝对路径、逃逸 checkout 的相对路径一律抛错。远端数据（git
 * checkout 或 Codeup tree 响应）进 checkout 前必须过这道闸。
 */
export function resolveInside(root: string, relPath: string): string {
  if (relPath === '' || relPath.trim() === '') {
    throw new Error(`Refusing to write an empty path inside ${root}`);
  }
  if (relPath.includes('\0')) throw new Error('Refusing to write a path containing NUL');
  if (isAbsolute(relPath)) {
    throw new Error(`Refusing to write absolute path ${relPath} (checkout paths must be relative)`);
  }
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write ${relPath}: escapes the checkout at ${root}`);
  }
  return abs;
}

/**
 * 建（或重置）分支。`from` 省略时从当前 HEAD 起 —— 空仓库还没有 origin/<任何分支>，
 * 首笔引导提交只能这样开出来。
 */
export async function createBranch(
  dir: string,
  branch: string,
  from?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const args = ['-C', dir, 'checkout', '-B', branch];
  if (from) args.push(`origin/${from}`);
  await git(args, { env });
}

function authorArgs(env: NodeJS.ProcessEnv | undefined): string[] {
  const e = env ?? process.env;
  const name = nonEmpty(e.EJDRONE_AUTHOR_NAME) ?? DEFAULT_AUTHOR_NAME;
  const email = nonEmpty(e.EJDRONE_AUTHOR_EMAIL) ?? DEFAULT_AUTHOR_EMAIL;
  // 只对本次命令生效：写用户的 git config 会污染他所有仓库的提交署名
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value.trim() : null;
}

/** 提交 checkout 里的全部改动；无改动时静默返回（不抛 "nothing to commit"）。 */
export async function commitAll(dir: string, message: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await git(['-C', dir, 'add', '-A'], { env });
  const { stdout } = await git(['-C', dir, 'status', '--porcelain'], { env });
  if (stdout.trim() === '') return;
  await git([...authorArgs(env), '-C', dir, 'commit', '-m', message], { env });
}

export async function push(dir: string, branch: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await git(['-C', dir, 'push', 'origin', branch], { env });
}

/**
 * 远端分支名（去掉 origin/ 前缀，排除 origin/HEAD）。
 * push 命令用它找同一资源的既有 `ejdrone/push-*` 分支，避免开重复 MR。
 */
export async function listRemoteBranches(dir: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const { stdout } = await git(['-C', dir, 'branch', '--remote', '--format=%(refname:short)'], { env });
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const short = line.trim();
    if (short === '' || short === 'origin/HEAD') continue;
    names.add(short.startsWith('origin/') ? short.slice('origin/'.length) : short);
  }
  return [...names].sort();
}

/**
 * 从 checkout 移除文件/目录并暂存删除（`git rm -r --ignore-unmatch`）。
 * 与 writeFiles 一样先做路径穿越校验，绝不允许删到 checkout 之外。
 */
export async function removePaths(
  dir: string,
  relPaths: string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (relPaths.length === 0) return;
  const root = resolve(dir);
  for (const rel of relPaths) resolveInside(root, rel);
  await git(['-C', dir, 'rm', '-r', '-q', '--ignore-unmatch', '--', ...relPaths], { env });
}

/** 当前分支短名；游离 HEAD 时 git 自己返回 'HEAD' */
export async function currentBranch(dir: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { env });
  return stdout.trim();
}

export async function isDirty(dir: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await git(['-C', dir, 'status', '--porcelain'], { env });
  return stdout.trim() !== '';
}

/**
 * 推送前密钥扫描扩展点。v1 明确不做检测：资源都要过 MR 评审，
 * 由人兜底；后续接 secret 扫描只需替换此实现。
 */
export const prePushScan: PrePushScan = () => [];
