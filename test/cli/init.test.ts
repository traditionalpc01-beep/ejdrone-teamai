import { describe, expect, it } from 'vitest';

import { providerForRepo } from '../../src/cli/init.js';

/**
 * 只测 providerForRepo 的纯判定（域名 → provider、--provider 覆盖）。
 * initCommand 全流程要真 git + 网络，那是 integration 层的事。
 */

describe('providerForRepo', () => {
  it('codeup.aliyun.com → codeup（https、无 .git、scp 式都认）', () => {
    expect(providerForRepo('https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git')).toBe('codeup');
    expect(providerForRepo('https://codeup.aliyun.com/org/repo')).toBe('codeup');
    expect(providerForRepo('git@codeup.aliyun.com:org/repo.git')).toBe('codeup');
  });

  it('gitlab 行为不变：域名含 gitlab → gitlab（大小写不敏感）', () => {
    expect(providerForRepo('https://gitlab.example.com/team/repo.git')).toBe('gitlab');
    expect(providerForRepo('git@gitlab.example.com:team/repo.git')).toBe('gitlab');
    expect(providerForRepo('https://GitLab.internal.io/a/b.git')).toBe('gitlab');
  });

  it('其他主机回落 git', () => {
    expect(providerForRepo('https://github.com/a/b.git')).toBe('git');
    expect(providerForRepo('git@bitbucket.org:a/b.git')).toBe('git');
  });

  it('--provider 显式覆盖优先，codeup 是合法值', () => {
    expect(providerForRepo('https://codeup.aliyun.com/a/b.git', 'git')).toBe('git');
    expect(providerForRepo('https://gitlab.example.com/a/b.git', 'codeup')).toBe('codeup');
    expect(providerForRepo('https://github.com/a/b.git', 'gitlab')).toBe('gitlab');
  });
});
