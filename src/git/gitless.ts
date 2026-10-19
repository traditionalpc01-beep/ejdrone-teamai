import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  codeupProjectPath,
  createCodeupClient,
  encodeCodeupRepoId,
  getCurrentOrganizationId,
  readCodeupToken,
} from './codeup-api.js';
import { resolveInside } from './repo.js';
import { API_CHECKOUT_MARKER, SYNC_INCOMPLETE_MARKER } from '../state.js';

/**
 * 免 git 降级链路：本机 PATH 上没有 git 时，Codeup 团队仓库改走云效 OpenAPI 逐文件拉取，
 * 把 `<stateDir>/repo` 同步成远端默认分支的完整工作树 —— 语义等同 repo.ts fetchReset 的
 * `reset --hard`（那是 ejdrone 自己拥有的机器状态目录，成员从不在里面编辑）。
 *
 * organizationId 每次现算（一次 pull 多一个请求，团队规模完全可接受）：缓存会把
 * token 失效、换组织这类状态冻在内存里，不值得为此引入缓存耦合（provider 侧同此策略）。
 *
 * 同步成本：head 未变时直接跳过（API_CHECKOUT_MARKER 里存着上次同步的 branch+head），
 * 变了才全量重建——每会话一次 hook pull 的频率下，常态是 3 个请求（org/branches/tree）
 * 加 0 次文件下载；全量重下只在远端真的前进时发生，代价随文件数线性，适用边界是
 * 几百个文件以内的团队仓（超出建议成员装 git 走增量 fetch）。
 */

export interface ApiCheckoutResult {
  /** 远端默认分支名（与 repo.ts defaultBranch 同语义的回落：'main'） */
  branch: string;
  /** 默认分支头提交 id；空仓库（远端无任何提交）为空串，与 git 侧空仓库 head='' 一致 */
  head: string;
}

/**
 * 用 Codeup OpenAPI 把 dir 清空重建为 repoUrl 默认分支的内容。
 *
 * 顺序刻意为：token/dir 护栏 → 网络（org/branches/tree）→ **整体校验全部路径** →
 * 写 SYNC_INCOMPLETE_MARKER → 清空 → 逐文件拉取落盘 → 写 API_CHECKOUT_MARKER、
 * 撤 SYNC_INCOMPLETE_MARKER。校验放在清空之前（与 repo.ts writeFiles「先整体校验再落盘」
 * 同一思路）：坏 tree 不能把 checkout 打成一半新一半旧；INCOMPLETE 哨兵保证中途失败的
 * 半截目录不会被 readExistingSnapshot 当成团队真相。
 */
export async function syncCheckoutViaApi(
  repoUrl: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  opts?: { fetchImpl?: typeof fetch },
): Promise<ApiCheckoutResult> {
  const token = readCodeupToken(env);
  if (token === '') {
    throw new Error(
      '本机没有可用的 git，需走免 git 模式（Codeup OpenAPI 拉取）：' +
        '请设置环境变量 EJDRONE_CODEUP_TOKEN（云效个人访问令牌，也可用 YUNXIAO_ACCESS_TOKEN）',
    );
  }
  // 清空重建前的护栏：dir 来自 repoDir(ctx.env)，正常永远满足；这层挡的是把空串或
  // 相对路径误传进来时把 cwd 或未知目录 rm 掉。
  if (dir.trim() === '') throw new Error('免 git 拉取的 checkout 目录是空串，拒绝清空重建');
  if (!isAbsolute(dir)) throw new Error(`免 git 拉取的 checkout 目录必须是绝对路径：${dir}`);

  const projectPath = codeupProjectPath(repoUrl);
  if (projectPath === null) {
    throw new Error(`不是 Codeup 仓库地址，无法免 git 拉取：${repoUrl}`);
  }

  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const organizationId = await getCurrentOrganizationId(token, fetchImpl);
  const client = createCodeupClient({ token, organizationId, fetchImpl });
  const repoId = encodeCodeupRepoId(projectPath);

  const branches = await client.listBranches(repoId);
  const chosen = branches.find((b) => b.defaultBranch) ?? branches.find((b) => b.name === 'main');
  const branch = chosen?.name ?? 'main';
  const head = chosen?.commitId ?? '';

  // 空仓库（远端一个分支都没有）：与 git 路径 fetchReset「同步到空」同语义——
  // 建出带标记的空目录即可，不请求 tree（不存在的 ref 会 404），首笔提交走 bootstrap。
  if (branches.length === 0) {
    rebuildEmptyDir(dir);
    return { branch: 'main', head: '' };
  }

  const markerFile = markerPath(dir);
  // head 缓存命中：远端没动过就跳过全量重下。哨兵同时证明目录是我们建的（无哨兵视为
  // 缓存失效，走全量重建，重建时会重新落哨兵）。内容两侧统一为 `${branch}\n${head}\n`。
  if (existsSync(dir) && !existsSync(incompletePath(dir))) {
    try {
      if (readFileSync(markerFile, 'utf8') === `${branch}\n${head}\n`) {
        return { branch, head };
      }
    } catch {
      /* 哨兵读不出（损坏/权限）：视为未同步，走全量重建 */
    }
  }

  const filePaths = await client.listFilePaths(repoId, branch);
  // 健全性护栏：远端有提交、默认分支头也在，tree 却一个文件都没给——两种解释：真·空
  // 工作树（合法），或响应被截断/接口异常。后者叠加「清空重建」等于静默删成员已装内容，
  // 宁可停下来让人看。合法空树（只剩 .gitattributes 之类也会给 1 条）在团队仓不存在。
  if (filePaths.length === 0 && head !== '') {
    throw new Error(
      `Codeup 返回了空文件树但分支 ${branch} 有提交（${head}）——疑似接口异常或被截断，` +
        '已拒绝清空本地 checkout。下一步：重试一次；仍失败请检查网络或联系管理员',
    );
  }
  const root = resolve(dir);
  const targets = filePaths.map((relPath) => ({ relPath, abs: resolveInside(root, relPath) }));

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 先落 INCOMPLETE 再开始写文件：中途任何一步抛错，目录都带着「半截」标记，
  // readExistingSnapshot 见标记即拒绝把该目录当团队真相。
  writeFileSync(incompletePath(dir), `${branch}\n${head}\n`, 'utf8');
  for (const t of targets) {
    // getFile 统一解码为 utf-8 文本；团队仓 .gitattributes 已 eol=lf，原样写盘，
    // 不做任何换行转换（转换会让内容与远端字节不一致，push 侧比对全抖）。
    const content = await client.getFile(repoId, branch, t.relPath);
    mkdirSync(dirname(t.abs), { recursive: true });
    writeFileSync(t.abs, content, 'utf8');
  }
  writeFileSync(markerFile, `${branch}\n${head}\n`, 'utf8');
  rmSync(incompletePath(dir), { force: true });
  return { branch, head };
}

/** 空仓库形态：清空重建 + 落哨兵（内容空、标记 main/空 head），不再触碰网络。 */
function rebuildEmptyDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath(dir), 'main\n\n', 'utf8');
}

function markerPath(dir: string): string {
  return `${dir}/${API_CHECKOUT_MARKER}`;
}

function incompletePath(dir: string): string {
  return `${dir}/${SYNC_INCOMPLETE_MARKER}`;
}
