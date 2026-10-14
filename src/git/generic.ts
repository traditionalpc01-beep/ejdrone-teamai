import type { Config, GitProvider, MrRequest, MrResult } from '../core/types.js';
import { newMrWebUrl, parseRepoRef } from './gitlab.js';

/**
 * 裸 git provider：只负责把"分支已推送、请手动合并"讲清楚。
 * host 看起来像 GitLab 时顺手给出新建 MR 链接，省用户手敲。
 */

export function looksLikeGitlab(repoUrl: string): boolean {
  return /gitlab/i.test(repoUrl);
}

export function createGenericProvider(config: Config): GitProvider {
  return {
    kind: 'git',
    async openMr(req: MrRequest): Promise<MrResult> {
      return { url: null, instructions: genericInstructions(config, req) };
    },
  };
}

function genericInstructions(config: Config, req: MrRequest): string {
  const lines = [
    `分支 ${req.branch} 已推送到远端（git push 已完成），当前 provider 为 git，无法自动开 MR。`,
    `请到项目页面（${repoWebUrl(config.repo)}）手动创建 MR：源分支 ${req.branch}，标题「${req.title}」。`,
  ];
  const link = maybeNewMrLink(config.repo, req.branch);
  if (link) lines.push(`直达链接: ${link}`);
  else lines.push('合并该分支后，其他成员下次 pull 即可拿到变更。');
  return lines.join('\n');
}

function repoWebUrl(repoUrl: string): string {
  const ref = parseRepoRef(repoUrl);
  return ref ? `${ref.baseUrl}/${ref.projectPath}` : repoUrl;
}

function maybeNewMrLink(repoUrl: string, branch: string): string | null {
  if (!looksLikeGitlab(repoUrl)) return null;
  const ref = parseRepoRef(repoUrl);
  if (!ref) return null;
  return newMrWebUrl(ref.baseUrl, ref.projectPath, branch);
}
