import { describe, expect, it } from 'vitest';

import type { Config, MrRequest } from '../../src/core/types.js';
import { createGenericProvider, looksLikeGitlab } from '../../src/git/generic.js';
import { makeGitProvider } from '../../src/git/provider.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    repo: 'https://gitlab.example.com/team/ejdrone-teamai.git',
    provider: 'git',
    primaryRole: null,
    additionalRoles: [],
    agents: [],
    ...overrides,
  };
}

const req: MrRequest = { branch: 'ejdrone/push-2026/10/11 09:30', title: 'add skill', body: 'body' };

describe('generic provider', () => {
  it('never returns a url and always explains the manual merge', async () => {
    const result = await createGenericProvider(config({ repo: 'https://code.example.com/team/repo.git' })).openMr({
      branch: 'ejdrone/push-1',
      title: 't',
      body: 'b',
    });

    expect(result.url).toBeNull();
    const text = result.instructions ?? '';
    expect(text).toContain('ejdrone/push-1');
    expect(text).toContain('已推送');
    expect(text).toContain('https://code.example.com/team/repo');
    expect(text).toContain('MR');
  });

  it('offers a pre-filled GitLab link with the branch encoded', async () => {
    const result = await createGenericProvider(config()).openMr(req);

    const text = result.instructions ?? '';
    expect(text).toContain(
      'https://gitlab.example.com/team/ejdrone-teamai/-/merge_requests/new?merge_request%5Bsource_branch%5D=ejdrone%2Fpush-2026%2F10%2F11%2009%3A30',
    );
    const link = /https:\/\/\S+merge_requests\/new\S*/.exec(text)?.[0] ?? '';
    expect(link).toBe(
      'https://gitlab.example.com/team/ejdrone-teamai/-/merge_requests/new?merge_request%5Bsource_branch%5D=ejdrone%2Fpush-2026%2F10%2F11%2009%3A30',
    );
    expect(link).not.toContain('ejdrone/push');
    expect(link).not.toContain('09:30');
  });

  it('omits the GitLab link for hosts that do not look like GitLab', async () => {
    const result = await createGenericProvider(config({ repo: 'git@github.com:team/skills.git' })).openMr(req);

    expect(result.instructions).not.toContain('merge_requests/new');
    expect(result.instructions).toContain('https://github.com/team/skills');
    expect(result.instructions).toContain('MR');
  });

  it('recognises gitlab hosts case-insensitively', () => {
    expect(looksLikeGitlab('https://GitLab.example.com/a/b.git')).toBe(true);
    expect(looksLikeGitlab('git@github.com:a/b.git')).toBe(false);
  });

  it('still gives a readable hint when the repo url is unparseable', async () => {
    const result = await createGenericProvider(
      config({ repo: 'not a url at all' }),
    ).openMr({ branch: 'b1', title: 't', body: 'b' });

    expect(result.instructions).toContain('not a url at all');
    expect(result.instructions).toContain('b1');
  });
});

describe('makeGitProvider', () => {
  // 不存在的状态目录：gitlab provider 的默认分支探测会在此快速失败并回落 main，
  // 从而保证测试永不读/写真实 HOME
  const isolated = { EJDRONE_HOME: `/tmp/ejdrone-absent-${process.pid}-${Math.random()}` };

  const noFetch: typeof fetch = async () => {
    throw new Error('should not be called');
  };

  it('selects the gitlab provider for provider=gitlab', async () => {
    const provider = makeGitProvider(config({ provider: 'gitlab' }), isolated, noFetch);

    expect(provider.kind).toBe('gitlab');
    // 无 token → 降级为指引，且绝不触碰注入的 fetch（它会抛错）
    const result = await provider.openMr(req);
    expect(result.url).toBeNull();
    expect(result.instructions).toContain('EJDRONE_GITLAB_TOKEN');
  });

  it('routes through the injected fetchImpl for the gitlab provider', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('{"web_url":"https://gitlab.example.com/team/ejdrone-teamai/-/merge_requests/9"}', {
        status: 201,
      });
    }) as unknown as typeof fetch;

    const result = await makeGitProvider(
      config({ provider: 'gitlab' }),
      { ...isolated, EJDRONE_GITLAB_TOKEN: 'x' },
      fetchImpl,
    ).openMr(req);

    expect(calls).toEqual([
      'https://gitlab.example.com/api/v4/projects/team%2Fejdrone-teamai/merge_requests',
    ]);
    expect(result.url).toBe('https://gitlab.example.com/team/ejdrone-teamai/-/merge_requests/9');
  });

  it('selects the generic provider for provider=git', async () => {
    const provider = makeGitProvider(config({ provider: 'git' }), {}, noFetch);

    expect(provider.kind).toBe('git');
    const result = await provider.openMr(req);
    expect(result.url).toBeNull();
    expect(result.instructions).toContain('已推送');
  });

  it('treats an unknown provider value as plain git rather than crashing', async () => {
    const provider = makeGitProvider(
      config({ provider: 'github' as unknown as Config['provider'] }),
      {},
      noFetch,
    );

    expect(provider.kind).toBe('git');
  });
});
