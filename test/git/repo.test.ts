import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commitAll,
  createBranch,
  currentBranch,
  defaultBranch,
  ensureClone,
  fetchReset,
  isDirty,
  prePushScan,
  push,
  sameRepoUrl,
  writeFiles,
} from '../../src/git/repo.js';
import { API_CHECKOUT_MARKER } from '../../src/state.js';

/**
 * 跑真实 git：`git init --bare` 当 origin，不 mock child_process。
 * env 里只放伪造 HOME + 空的全局配置，绝不碰真实 HOME / 真实 git 配置。
 */

function baseEnv(home: string): NodeJS.ProcessEnv {
  const emptyConfig = join(home, 'empty-gitconfig');
  writeFileSync(emptyConfig, '', 'utf8');
  return {
    HOME: home,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: baseEnv(root),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitStatus(cwd: string, ...args: string[]): { code: number; out: string } {
  const options = { cwd, encoding: 'utf8', env: baseEnv(root), stdio: ['ignore', 'pipe', 'pipe'] } as const;
  try {
    return { code: 0, out: execFileSync('git', args, options) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

let root = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-repo-'));
  env = baseEnv(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 建一个 bare origin，并按 branch 名字推入初始内容；name 用于同一 root 里建多个 origin */
function makeOrigin(
  branch = 'main',
  files: Record<string, string> = { 'README.md': '# team\n' },
  name = 'origin',
): string {
  const origin = join(root, `${name}.git`);
  mkdirSync(origin, { recursive: true });
  gitAt(root, 'init', '--bare', '--initial-branch', branch, origin);

  const work = join(root, `seed-${name}`);
  gitAt(root, 'init', '--initial-branch', branch, work);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(work, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  gitAt(work, '-c', 'user.name=Seed', '-c', 'user.email=seed@local', 'add', '-A');
  gitAt(work, '-c', 'user.name=Seed', '-c', 'user.email=seed@local', 'commit', '-m', 'seed');
  gitAt(work, 'remote', 'add', 'origin', origin);
  gitAt(work, 'push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  // bare 仓库的 HEAD 不会跟着首次 push 自动移动，必须显式设，否则 clone 没有 origin/HEAD
  gitAt(origin, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  return origin;
}

/** 另一个 working clone，用来模拟同事往 origin 的 branch 推一个新提交 */
function coWorker(origin: string, branch: string, files: Record<string, string>): string {
  const dir = join(root, `coworker-${Math.random().toString(36).slice(2, 8)}`);
  gitAt(root, 'clone', origin, dir);
  gitAt(dir, 'checkout', '-B', branch);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  gitAt(dir, '-c', 'user.name=Cow', '-c', 'user.email=cow@local', 'add', '-A');
  gitAt(dir, '-c', 'user.name=Cow', '-c', 'user.email=cow@local', 'commit', '-m', 'from coworker');
  gitAt(dir, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  return gitAt(dir, 'rev-parse', 'HEAD').trim();
}

describe('ensureClone', () => {
  it('clones when the directory does not exist', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'state', 'repo');
    mkdirSync(join(root, 'state'), { recursive: true });

    await ensureClone(origin, dir, env);

    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# team\n');
  });

  it('only fetches (never resets) an existing clone', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);

    const headBefore = gitAt(dir, 'rev-parse', 'HEAD').trim();
    coWorker(origin, 'main', { 'README.md': '# team v2\n' });

    await ensureClone(origin, dir, env);

    expect(gitAt(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# team\n');
    expect(await isDirty(dir, env)).toBe(false);
  });

  it('clones into an empty subdir of an unrelated repo instead of fetching that repo', async () => {
    const origin = makeOrigin();
    const parent = join(root, 'unrelated');
    gitAt(root, 'init', '--initial-branch', 'main', parent);
    const dir = join(parent, 'repo');
    mkdirSync(dir, { recursive: true });

    await ensureClone(origin, dir, env);
    await ensureClone(origin, dir, env);

    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# team\n');
    expect(gitAt(dir, 'remote', 'get-url', 'origin').trim()).toBe(origin);
    // 那个不相干仓库仍然没有任何提交，也没被我们的 clone 写坏
    expect(gitStatus(parent, 'rev-parse', '--verify', 'HEAD').code).not.toBe(0);
    expect(existsSync(join(parent, 'README.md'))).toBe(false);
  });

  it('clears a non-git directory **with the api-sync marker** before cloning（免 git → 有 git 切换）', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stale.txt'), 'left by gitless mode\n', 'utf8');
    writeFileSync(join(dir, API_CHECKOUT_MARKER), 'main\nabc\n', 'utf8');

    await ensureClone(origin, dir, env);

    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# team\n');
  });

  it('refuses to clear a non-git directory without the marker（EJDRONE_HOME 配错时不许误删用户目录）', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'user-file.txt'), 'not ours\n', 'utf8');

    await expect(ensureClone(origin, dir, env)).rejects.toThrow(/拒绝清空/);
    // 用户内容原样保留
    expect(readFileSync(join(dir, 'user-file.txt'), 'utf8')).toBe('not ours\n');
  });

  it('refuses to clear a directory containing .git（半损坏仓库里可能有未推送提交）', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    mkdirSync(join(dir, '.git'), { recursive: true }); // 假 .git：rev-parse 失败但目录在

    await expect(ensureClone(origin, dir, env)).rejects.toThrow(/\.git.*拒绝自动清空/);
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('rejects an unreachable url with a git error, not a hang', async () => {
    await expect(ensureClone(join(root, 'nope.git'), join(root, 'repo'), env)).rejects.toThrow(/clone|fatal/i);
  });

  it('relinks an existing clone whose origin points somewhere else（F1：换仓库地址不再静默同步旧仓库）', async () => {
    const originA = makeOrigin('main', { 'README.md': '# team-a\n' }, 'origin-a');
    const originB = makeOrigin('main', { 'README.md': '# team-b\n' }, 'origin-b');
    const dir = join(root, 'repo');
    await ensureClone(originA, dir, env);

    // config 换成 B：ensureClone 必须改写 origin 并如实报告 relinked
    const first = await ensureClone(originB, dir, env);
    expect(first).toEqual({ relinked: true });
    expect(gitAt(dir, 'remote', 'get-url', 'origin').trim()).toBe(originB);
    // 第二次同一地址：不再 relink
    const second = await ensureClone(originB, dir, env);
    expect(second).toEqual({ relinked: false });
  });

  it('treats the same repo with different credentials / .git suffix / trailing slash as the same origin', async () => {
    // 归一化比对直接测 sameRepoUrl（导出的纯函数）：本地路径无法内嵌凭据，https 形态在
    // ensureClone 层测不了（fetch 不可达），纯函数层已覆盖三种等价差异。
    expect(sameRepoUrl('https://oauth2:tok@host/team/repo.git', 'https://host/team/repo')).toBe(true);
    expect(sameRepoUrl('/a/origin.git/', '/a/origin')).toBe(true);
    expect(sameRepoUrl('/a/origin.git', '/a/other')).toBe(false);

    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    // 尾斜杠等价：不 relink、不 set-url
    await expect(ensureClone(`${origin}/`, dir, env)).resolves.toEqual({ relinked: false });
    expect(gitAt(dir, 'remote', 'get-url', 'origin').trim()).toBe(origin);
  });

  it('scrubs credentials embedded in the repo url out of error messages', async () => {
    const url = 'https://oauth2:SUPERSECRET@localhost:1/team/repo.git';

    const error = await ensureClone(url, join(root, 'repo'), env).then(
      () => null,
      (e: Error) => e,
    );

    expect(error).not.toBeNull();
    expect(error?.message).not.toContain('SUPERSECRET');
    expect(error?.message).toContain('***');
  });
});

describe('fetchReset', () => {
  it('hard-resets the machine clone to origin/<branch> and reports head', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    const newHead = coWorker(origin, 'main', { 'skills/a/SKILL.md': '# a\n' });

    const handle = await fetchReset(dir, undefined, env);

    expect(handle).toEqual({ dir, head: newHead });
    expect(readFileSync(join(dir, 'skills/a/SKILL.md'), 'utf8')).toBe('# a\n');
  });

  it('accepts an explicit branch', async () => {
    const origin = makeOrigin('main', { 'README.md': '# team\n' });
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    const releaseHead = coWorker(origin, 'release', { 'README.md': '# release\n' });

    const handle = await fetchReset(dir, 'release', env);

    expect(handle.head).toBe(releaseHead);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# release\n');
  });

  it('drops local edits — this is ejdrone-owned machine state, not a work repo', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    writeFileSync(join(dir, 'README.md'), 'local scribble\n', 'utf8');
    expect(await isDirty(dir, env)).toBe(true);

    await fetchReset(dir, undefined, env);

    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# team\n');
    expect(await isDirty(dir, env)).toBe(false);
  });
});

describe('defaultBranch', () => {
  it('reads origin/HEAD', async () => {
    const origin = makeOrigin('trunk');
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);

    expect(await defaultBranch(dir, env)).toBe('trunk');
  });

  it('falls back to probing main on the remote when origin/HEAD is missing', async () => {
    const origin = makeOrigin('main');
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    gitAt(dir, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');

    expect(await defaultBranch(dir, env)).toBe('main');
  });

  it('falls back to master when main is absent', async () => {
    const origin = makeOrigin('master');
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    gitAt(dir, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');

    expect(await defaultBranch(dir, env)).toBe('master');
  });

  it('returns main as a last resort when neither exists', async () => {
    const origin = makeOrigin('trunk');
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    gitAt(dir, 'symbolic-ref', '-d', 'refs/remotes/origin/HEAD');

    expect(await defaultBranch(dir, env)).toBe('main');
  });
});

describe('writeFiles', () => {
  it('creates parent directories and writes every file', async () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });

    writeFiles(dir, { 'skills/ns/a/SKILL.md': '# a\n', 'rules/x.md': '# x\n' });

    expect(readFileSync(join(dir, 'skills/ns/a/SKILL.md'), 'utf8')).toBe('# a\n');
    expect(readFileSync(join(dir, 'rules/x.md'), 'utf8')).toBe('# x\n');
  });

  it('refuses paths that escape the checkout', () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });

    expect(() => writeFiles(dir, { '../evil': 'boom' })).toThrow(/escapes|relative/i);
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });

  it('refuses absolute keys', () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    const outside = join(root, 'elsewhere.md');

    expect(() => writeFiles(dir, { [outside]: 'boom' })).toThrow(/absolute/i);
    expect(existsSync(outside)).toBe(false);
  });

  it('refuses an empty key', () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });

    expect(() => writeFiles(dir, { '': 'boom' })).toThrow(/empty/i);
  });

  it('validates all keys before writing any file', () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });

    expect(() => writeFiles(dir, { 'ok.md': 'fine', '../evil': 'boom' })).toThrow();
    expect(existsSync(join(dir, 'ok.md'))).toBe(false);
  });
});

describe('createBranch / commitAll / push', () => {
  it('creates a branch from origin/<from> and commits with the injected author', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);

    await createBranch(dir, 'ejdrone/push-1', 'main', env);
    expect(await currentBranch(dir, env)).toBe('ejdrone/push-1');

    writeFiles(dir, { 'skills/new/SKILL.md': '# new\n' });
    await commitAll(dir, 'ejdrone: push new', env);

    expect(gitAt(dir, 'log', '-1', '--format=%an %ae').trim()).toBe('ejdrone-teamai ejdrone@local');
    expect(await isDirty(dir, env)).toBe(false);
  });

  it('honours EJDRONE_AUTHOR_NAME / EJDRONE_AUTHOR_EMAIL overrides', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    writeFiles(dir, { 'a.md': 'a\n' });

    await commitAll(dir, 'msg', {
      ...env,
      EJDRONE_AUTHOR_NAME: 'Team Bot',
      EJDRONE_AUTHOR_EMAIL: 'team@example.com',
    });

    expect(gitAt(dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Team Bot <team@example.com>');
  });

  it('never writes the author into git config', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    writeFiles(dir, { 'a.md': 'a\n' });

    await commitAll(dir, 'msg', env);

    expect(gitStatus(dir, 'config', '--local', '--get', 'user.name').code).not.toBe(0);
    expect(gitStatus(dir, 'config', '--local', '--get', 'user.email').code).not.toBe(0);
    expect(existsSync(join(root, '.gitconfig'))).toBe(false);
  });

  it('is a no-op when there is nothing to commit', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    const headBefore = gitAt(dir, 'rev-parse', 'HEAD').trim();

    await expect(commitAll(dir, 'empty', env)).resolves.toBeUndefined();

    expect(gitAt(dir, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
  });

  it('pushes the branch to origin', async () => {
    const origin = makeOrigin();
    const dir = join(root, 'repo');
    await ensureClone(origin, dir, env);
    await createBranch(dir, 'ejdrone/push-42', 'main', env);
    writeFiles(dir, { 'skills/push/SKILL.md': '# push\n' });
    await commitAll(dir, 'ejdrone: push', env);

    await push(dir, 'ejdrone/push-42', env);

    expect(gitAt(origin, 'rev-parse', '--verify', 'refs/heads/ejdrone/push-42').trim()).toBe(
      gitAt(dir, 'rev-parse', 'HEAD').trim(),
    );
  });
});

describe('prePushScan', () => {
  it('is a deliberate no-op extension point in v1', () => {
    expect(
      prePushScan({ 'SKILL.md': 'aws_secret_access_key = AKIAIOSFODNN7EXAMPLE\n' }),
    ).toEqual([]);
  });
});
