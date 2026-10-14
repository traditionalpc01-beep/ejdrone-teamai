import type { Config, GitProvider } from '../core/types.js';
import { createGenericProvider } from './generic.js';
import { createGitlabProvider } from './gitlab.js';

/**
 * provider 工厂。fetchImpl 必须可注入 —— gitlab.ts 的测试全部 mock 网络，
 * 不打真实 API（token 也不该被发往别处）。
 */
export function makeGitProvider(
  config: Config,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): GitProvider {
  if (config.provider === 'gitlab') return createGitlabProvider(config, env, fetchImpl);
  return createGenericProvider(config);
}
