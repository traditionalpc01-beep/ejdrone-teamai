import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Config, MrRequest } from '../../src/core/types.js';
import { createGitlabProvider, parseRepoRef } from '../../src/git/gitlab.js';
import { ensureClone } from '../../src/git/repo.js';
import { repoDir } from '../../src/state.js';

/**
 * 网络全部走注入的 fetchImpl；token 用一个假值，好在断言里验证它不会外泄。
 * git 部分（target_branch 探测）跑真实 git，origin 是 `git init --bare`。
 */

const TOKEN = 'glpat-FAKE-TOKEN-1234567890';

let root = '';
const MANUAL_URL =
  'https://gitlab.example.com/team/ejdrone-teamai/-/merge_requests/new?merge_request%5Bsource_branch%5D=ejdrone%2Fpush-1';

function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const emptyConfig = join(root, 'empty-gitconfig');
  writeFileSync(emptyConfig, '', 'utf8');
  return {
    HOME: root,
    EJDRONE_HOME: join(root, 'state'),
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: fakeEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-gitlab-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    repo: 'https://gitlab.example.com/team/ejdrone-teamai.git',
    provider: 'gitlab',
    primaryRole: 'devops',
    additionalRoles: [],
    agents: ['claude'],
    ...overrides,
  };
}

const req: MrRequest = { branch: 'ejdrone/push-1', title: 'push skills', body: '来自 ejdrone' };

interface Call {
  url: string;
  init: RequestInit;
}

interface FakeFetch {
  impl: typeof fetch;
  calls: Call[];
}

function fetchResponding(status: number, body: string): FakeFetch {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function fetchRejecting(error: Error): FakeFetch {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    throw error;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  expect(call).toBeDefined();
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

function headerOf(call: Call | undefined, name: string): string | undefined {
  const headers = call?.init.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe('parseRepoRef', () => {
  it('parses an https url with nested groups', () => {
    expect(parseRepoRef('https://gitlab.example.com/group/sub/project.git')).toEqual({
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'group/sub/project',
    });
  });

  it('parses an scp-like ssh url', () => {
    expect(parseRepoRef('git@gitlab.example.com:group/sub/project.git')).toEqual({
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'group/sub/project',
    });
  });

  it('tolerates a missing .git suffix, a port and an ssh:// scheme', () => {
    expect(parseRepoRef('https://gitlab.example.com:8443/team/proj')).toEqual({
      baseUrl: 'https://gitlab.example.com:8443',
      projectPath: 'team/proj',
    });
    expect(parseRepoRef('ssh://git@gitlab.example.com/team/proj.git')?.baseUrl).toBe(
      'https://gitlab.example.com',
    );
  });

  it('returns null when there is no group/project path', () => {
    expect(parseRepoRef('https://gitlab.example.com/project.git')).toBeNull();
    expect(parseRepoRef('')).toBeNull();
    expect(parseRepoRef('ftp://host/a/b.git')).toBeNull();
  });
});

describe('openMr on success', () => {
  it('POSTs the encoded project path with the token header and a full body', async () => {
    const fetch_ = fetchResponding(201, '{"web_url":"https://gitlab.example.com/team/p/-/merge_requests/7"}');

    const result = await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN }),
      fetch_.impl,
    ).openMr(req);

    expect(result).toEqual({ url: 'https://gitlab.example.com/team/p/-/merge_requests/7' });
    expect(fetch_.calls).toHaveLength(1);
    expect(fetch_.calls[0]?.url).toBe(
      'https://gitlab.example.com/api/v4/projects/team%2Fejdrone-teamai/merge_requests',
    );
    expect(fetch_.calls[0]?.init.method).toBe('POST');
    expect(headerOf(fetch_.calls[0], 'PRIVATE-TOKEN')).toBe(TOKEN);
    expect(bodyOf(fetch_.calls[0])).toEqual({
      source_branch: 'ejdrone/push-1',
      target_branch: 'main',
      title: 'push skills',
      description: '来自 ejdrone',
      remove_source_branch: true,
    });
  });

  it('honours gitlabBaseUrl and strips its trailing slash', async () => {
    const fetch_ = fetchResponding(201, '{"web_url":"https://gl.internal/team/proj/-/merge_requests/1"}');
    const cfg = config({ gitlabBaseUrl: 'https://gl.internal/', repo: 'git@code.mirror.example.com:team/proj.git' });

    await createGitlabProvider(cfg, fakeEnv({ GL_TOKEN: TOKEN }), fetch_.impl).openMr(req);

    expect(fetch_.calls[0]?.url).toBe('https://gl.internal/api/v4/projects/team%2Fproj/merge_requests');
  });

  it('prefers EJDRONE_GITLAB_TOKEN over GL_TOKEN', async () => {
    const fetch_ = fetchResponding(201, '{"web_url":"https://gitlab.example.com/a/b/-/merge_requests/2"}');

    await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: 'primary-token', GL_TOKEN: 'fallback-token' }),
      fetch_.impl,
    ).openMr(req);

    expect(headerOf(fetch_.calls[0], 'PRIVATE-TOKEN')).toBe('primary-token');
  });

  it('falls back to GL_TOKEN when the primary var is absent or blank', async () => {
    const fetch_ = fetchResponding(201, '{"web_url":"https://gitlab.example.com/a/b/-/merge_requests/4"}');

    await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: '   ', GL_TOKEN: 'fallback-token' }),
      fetch_.impl,
    ).openMr(req);

    expect(headerOf(fetch_.calls[0], 'PRIVATE-TOKEN')).toBe('fallback-token');
  });

  it('targets the real default branch of the local clone', async () => {
    const origin = join(root, 'origin.git');
    mkdirSync(origin, { recursive: true });
    gitAt(root, 'init', '--bare', '--initial-branch', 'master', origin);
    const seed = join(root, 'seed');
    gitAt(root, 'init', '--initial-branch', 'master', seed);
    writeFileSync(join(seed, 'README.md'), '# team\n', 'utf8');
    gitAt(seed, '-c', 'user.name=S', '-c', 'user.email=s@l', 'add', '-A');
    gitAt(seed, '-c', 'user.name=S', '-c', 'user.email=s@l', 'commit', '-m', 'seed');
    gitAt(seed, 'remote', 'add', 'origin', origin);
    gitAt(seed, 'push', 'origin', 'refs/heads/master:refs/heads/master');
    gitAt(origin, 'symbolic-ref', 'HEAD', 'refs/heads/master');

    const e = fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN });
    await ensureClone(origin, repoDir(e), e);
    const fetch_ = fetchResponding(201, '{"web_url":"https://gitlab.example.com/a/b/-/merge_requests/5"}');

    await createGitlabProvider(config(), e, fetch_.impl).openMr(req);

    expect(bodyOf(fetch_.calls[0]).target_branch).toBe('master');
  });
});

describe('openMr degradation — never throws for a pushed branch', () => {
  it('without a token: instructions, no API call, no token material in the text', async () => {
    const fetch_ = fetchResponding(201, '{}');

    const result = await createGitlabProvider(config(), fakeEnv(), fetch_.impl).openMr(req);

    expect(fetch_.calls).toHaveLength(0);
    expect(result.url).toBeNull();
    expect(result.instructions).toContain('EJDRONE_GITLAB_TOKEN');
    expect(result.instructions).toContain(MANUAL_URL);
    expect(result.instructions).not.toContain(TOKEN);
    expect(result.instructions).not.toContain('glpat-');
  });

  it('on 401: instructions carry the status and GitLab message', async () => {
    const fetch_ = fetchResponding(401, '{"message":"401 Unauthorized"}');

    const result = await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN }),
      fetch_.impl,
    ).openMr(req);

    expect(result.url).toBeNull();
    const text = result.instructions ?? '';
    expect(text).toContain('401');
    expect(text).toContain('Unauthorized');
    expect(text).toContain('ejdrone/push-1');
    expect(text).toContain(MANUAL_URL);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('PRIVATE-TOKEN');
  });

  it('on 403: mentions the token as the likely culprit', async () => {
    const fetch_ = fetchResponding(403, '{"message":"403 Forbidden"}');

    const result = await createGitlabProvider(
      config(),
      fakeEnv({ GL_TOKEN: TOKEN }),
      fetch_.impl,
    ).openMr(req);

    expect(result.instructions ?? '').toContain('403');
  });

  it('summarises a structured 400 payload', async () => {
    const fetch_ = fetchResponding(400, '{"message":{"source_branch":["has already been taken"]}}');

    const result = await createGitlabProvider(config(), fakeEnv({ GL_TOKEN: TOKEN }), fetch_.impl).openMr(req);

    const text = result.instructions ?? '';
    expect(text).toContain('400');
    expect(text).toContain('has already been taken');
    expect(text).not.toContain(TOKEN);
  });

  it('survives a network failure and a non-JSON body', async () => {
    const down = fetchRejecting(new TypeError('fetch failed: getaddrinfo ENOTFOUND gitlab.example.com'));
    const result = await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN }),
      down.impl,
    ).openMr(req);

    expect(result.url).toBeNull();
    expect(result.instructions).toContain('ENOTFOUND');
    expect(result.instructions).toContain('ejdrone/push-1');

    const html = fetchResponding(502, '<html>bad gateway</html>');
    const bad = await createGitlabProvider(config(), fakeEnv({ GL_TOKEN: TOKEN }), html.impl).openMr(req);
    expect(bad.instructions).toContain('502');
    expect(bad.instructions).toContain('bad gateway');
  });

  it('redacts a token that appears anywhere in the response', async () => {
    const fetch_ = fetchResponding(500, `{"message":"upstream leaked ${TOKEN}"}`);

    const result = await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN }),
      fetch_.impl,
    ).openMr(req);

    expect(result.instructions).not.toContain(TOKEN);
    expect(result.instructions).toContain('[redacted]');
  });

  it('a 2xx without web_url still yields a usable link', async () => {
    const fetch_ = fetchResponding(200, '{"id":11}');

    const result = await createGitlabProvider(
      config(),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN }),
      fetch_.impl,
    ).openMr(req);

    expect(result.url).toBeNull();
    expect(result.instructions).toContain(MANUAL_URL);
  });

  it('throws only for a repo url that cannot be a GitLab project', async () => {
    const fetch_ = fetchResponding(201, '{}');
    const provider = createGitlabProvider(
      config({ repo: '/local/only/path.git' }),
      fakeEnv({ EJDRONE_GITLAB_TOKEN: TOKEN }),
      fetch_.impl,
    );

    await expect(provider.openMr(req)).rejects.toThrow(/project path/i);
    expect(fetch_.calls).toHaveLength(0);
  });

  it('the provider reports its kind', () => {
    expect(createGitlabProvider(config(), fakeEnv(), fetchResponding(200, '{}').impl).kind).toBe('gitlab');
  });
});
