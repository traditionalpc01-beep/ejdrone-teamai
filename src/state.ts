import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { Config } from './core/types.js';

/**
 * 本地状态层：`~/.ejdrone/` 的目录布局与 config.yaml 读写。
 *
 * 所有路径都是 env 的纯函数，env 在调用时读取（不做模块级 process.env 绑定），
 * 这样测试可以注入伪造 HOME 做端到端隔离。
 */

const CONFIG_FILE = 'config.yaml';
const LEDGER_FILE = 'ledger.json';
const REPO_DIR_NAME = 'repo';
const DEBUG_LOG_FILE = 'debug.log';

function resolveEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env ?? process.env;
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value : null;
}

export function stateDir(env?: NodeJS.ProcessEnv): string {
  const e = resolveEnv(env);
  const override = nonEmpty(e.EJDRONE_HOME);
  if (override) return override;
  return join(nonEmpty(e.HOME) ?? homedir(), '.ejdrone');
}

export function configPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), CONFIG_FILE);
}

export function ledgerPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), LEDGER_FILE);
}

/** 团队仓库的机器本地 clone 落点 */
export function repoDir(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), REPO_DIR_NAME);
}

export function debugLogPath(env?: NodeJS.ProcessEnv): string {
  return join(stateDir(env), DEBUG_LOG_FILE);
}

/**
 * `.strict()` 是刻意的：拼错的键（`additionalRole` 少个 s）若被静默忽略，
 * 角色配置就失效了却没人知道。
 */
const configSchema = z
  .object({
    version: z.literal(1),
    repo: z.string().min(1),
    provider: z.enum(['gitlab', 'git']),
    gitlabBaseUrl: z.string().min(1).optional(),
    primaryRole: z.string().nullable(),
    additionalRoles: z.array(z.string().min(1)),
    agents: z.array(z.string().min(1)),
  })
  .strict();

export interface ConfigLoadResult {
  config: Config | null;
  error?: string;
}

export function loadConfig(env?: NodeJS.ProcessEnv): ConfigLoadResult {
  const path = configPath(env);
  if (!existsSync(path)) return { config: null };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { config: null, error: `Cannot read config: ${(e as Error).message} (${path})` };
  }
  if (raw.trim() === '') return { config: null, error: `Config file is empty (${path})` };

  let doc: unknown;
  try {
    doc = parse(raw, { uniqueKeys: true });
  } catch (e) {
    return { config: null, error: `Config is not valid YAML: ${(e as Error).message} (${path})` };
  }

  const parsed = configSchema.safeParse(doc);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return { config: null, error: `Config is invalid: ${reason} (${path})` };
  }
  return { config: parsed.data as Config };
}

export function saveConfig(config: Config, env?: NodeJS.ProcessEnv): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, stringifyConfig(config), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw e;
  }
  // rename 未必保留 tmp 的权限（umask / 目标已存在），这里钉死 0600
  try {
    chmodSync(path, 0o600);
  } catch {
    /* 文件系统不支持改权限时不额外失败 */
  }
}

function stringifyConfig(config: Config): string {
  const doc: Record<string, unknown> = {
    version: 1,
    repo: config.repo,
    provider: config.provider,
  };
  if (config.gitlabBaseUrl !== undefined) doc.gitlabBaseUrl = config.gitlabBaseUrl;
  doc.primaryRole = config.primaryRole;
  doc.additionalRoles = config.additionalRoles;
  doc.agents = config.agents;
  return `${stringify(doc)}\n`;
}
