import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { expectPrivateMode } from '../helpers/mode.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../../src/core/types.js';
import {
  configPath,
  debugLogPath,
  ledgerPath,
  loadConfig,
  repoDir,
  saveConfig,
  stateDir,
} from '../../src/state.js';

let home = '';
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ejdrone-state-'));
  env = { HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const base: Config = {
  version: 1,
  repo: 'https://gitlab.example.com/team/ejdrone-teamai.git',
  provider: 'gitlab',
  gitlabBaseUrl: 'https://gitlab.example.com',
  primaryRole: 'devops',
  additionalRoles: ['backend'],
  subscribedTags: ['ops-tools'],
  agents: ['qoder-cn', 'claude'],
};

describe('paths', () => {
  it('derives everything from HOME when EJDRONE_HOME is unset', () => {
    expect(stateDir(env)).toBe(join(home, '.ejdrone'));
    expect(configPath(env)).toBe(join(home, '.ejdrone', 'config.yaml'));
    expect(ledgerPath(env)).toBe(join(home, '.ejdrone', 'ledger.json'));
    expect(repoDir(env)).toBe(join(home, '.ejdrone', 'repo'));
    expect(debugLogPath(env)).toBe(join(home, '.ejdrone', 'debug.log'));
  });

  it('prefers EJDRONE_HOME and leaves HOME untouched', () => {
    const alt = join(home, 'elsewhere');
    const isolated: NodeJS.ProcessEnv = { HOME: home, EJDRONE_HOME: alt };

    saveConfig(base, isolated);

    expect(configPath(isolated)).toBe(join(alt, 'config.yaml'));
    expect(existsSync(join(alt, 'config.yaml'))).toBe(true);
    expect(existsSync(join(home, '.ejdrone'))).toBe(false);
  });

  it('ignores an empty or whitespace EJDRONE_HOME', () => {
    expect(stateDir({ HOME: home, EJDRONE_HOME: '   ' })).toBe(join(home, '.ejdrone'));
    expect(stateDir({ HOME: home, EJDRONE_HOME: '' })).toBe(join(home, '.ejdrone'));
  });

  it('reads env at call time, never from a module-level process.env snapshot', async () => {
    const realHome = process.env.HOME;
    process.env.HOME = join(home, 'process-home');
    try {
      vi.resetModules();
      const mod = await import('../../src/state.js');
      expect(mod.stateDir()).toBe(join(home, 'process-home', '.ejdrone'));
      expect(mod.stateDir(env)).toBe(join(home, '.ejdrone'));
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });
});

describe('saveConfig / loadConfig', () => {
  it('round-trips a config', () => {
    saveConfig(base, env);

    const loaded = loadConfig(env);
    expect(loaded.error).toBeUndefined();
    expect(loaded.config).toEqual(base);
  });

  it('omits gitlabBaseUrl when it is not set', () => {
    const withoutBase: Config = { ...base };
    delete withoutBase.gitlabBaseUrl;
    saveConfig(withoutBase, env);

    expect(readFileSync(configPath(env), 'utf8')).not.toMatch(/gitlabBaseUrl/);
    expect(loadConfig(env).config).toEqual(withoutBase);
  });

  it('round-trips a codeup config（provider=codeup；organizationId 不落 config，每次现算）', () => {
    const codeup: Config = {
      ...base,
      provider: 'codeup',
      repo: 'https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git',
    };
    saveConfig(codeup, env);

    expect(loadConfig(env).config).toEqual(codeup);
    // codeupOrgId 曾短暂存在又被移除：换 token/换组织后陈旧 orgId 会让 push 打到旧组织
    // 而 pull 正常（gitless 现算），config 不允许再携带这个键
    expect(readFileSync(configPath(env), 'utf8')).not.toMatch(/codeupOrgId/);
  });

  it('creates the state directory and marks the file 0600', () => {
    saveConfig(base, env);

    expectPrivateMode(configPath(env), 0o600);
    expect(existsSync(join(home, '.ejdrone'))).toBe(true);
  });

  it('overwrites an existing config atomically and leaves no tmp file', () => {
    saveConfig(base, env);
    saveConfig({ ...base, primaryRole: 'backend' }, env);

    expect(loadConfig(env).config?.primaryRole).toBe('backend');
    const leftovers = readdirNames(join(home, '.ejdrone')).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('覆盖已存在的 config：新内容正确且权限仍为 0600（POSIX 行为回归）', () => {
    saveConfig(base, env);
    const updated: Config = { ...base, primaryRole: 'backend', agents: ['claude'] };
    saveConfig(updated, env);

    expect(loadConfig(env).config).toEqual(updated);
    expectPrivateMode(configPath(env), 0o600);
  });

  it('returns { config: null } with no error when the file does not exist', () => {
    expect(loadConfig(env)).toEqual({ config: null });
  });

  it('2.0 的 config 没有 subscribedTags 键 → 解析为空订阅（缺键不是 strict 的靶子）', () => {
    mkdirSync(join(home, '.ejdrone'), { recursive: true });
    writeFileSync(
      configPath(env),
      'version: 1\nrepo: r\nprovider: git\nprimaryRole: null\nadditionalRoles: []\nagents: []\n',
      'utf8',
    );
    const result = loadConfig(env);
    expect(result.error).toBeUndefined();
    expect(result.config?.subscribedTags).toEqual([]);
  });

  it('reports an unknown key instead of silently ignoring it', () => {
    mkdirSync(join(home, '.ejdrone'), { recursive: true });
    writeFileSync(
      configPath(env),
      'version: 1\nrepo: r\nprovider: git\nprimaryRole: dev\nadditionalRoles: []\nagents: []\nadditionalRole: dev\n',
      'utf8',
    );

    const result = loadConfig(env);
    expect(result.config).toBeNull();
    expect(result.error).toContain(configPath(env));
    expect(result.error).toMatch(/additionalRole/);
  });

  it('rejects a schema violation with a message that names the path', () => {
    mkdirSync(join(home, '.ejdrone'), { recursive: true });
    writeFileSync(configPath(env), 'version: 1\nprovider: github\n', 'utf8');

    const result = loadConfig(env);
    expect(result.config).toBeNull();
    expect(result.error).toContain(configPath(env));
    expect(result.error).toMatch(/provider/);
  });

  it('rejects version other than 1', () => {
    mkdirSync(join(home, '.ejdrone'), { recursive: true });
    writeFileSync(configPath(env), `${yamlDoc({ ...base, version: 2 })}`, 'utf8');

    expect(loadConfig(env).error).toMatch(/version/);
  });

  it('returns an error for corrupt YAML rather than throwing', () => {
    mkdirSync(join(home, '.ejdrone'), { recursive: true });
    writeFileSync(configPath(env), '@not-yaml\n  broken: [\n', 'utf8');

    const result = loadConfig(env);
    expect(result.config).toBeNull();
    expect(result.error).toMatch(/not valid YAML/);
    expect(result.error).toContain(configPath(env));
  });

  it('treats an empty file as an error, not as "no config"', () => {
    mkdirSync(join(home, '.ejdrone'), { recursive: true });
    writeFileSync(configPath(env), '   \n', 'utf8');

    expect(loadConfig(env).error).toMatch(/empty/);
  });

  it('accepts a null primaryRole before the user picks a role', () => {
    saveConfig({ ...base, primaryRole: null, additionalRoles: [] }, env);

    expect(loadConfig(env).config).toEqual({ ...base, primaryRole: null, additionalRoles: [] });
  });
});

function yamlDoc(config: Record<string, unknown>): string {
  return Object.entries(config)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
}

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
