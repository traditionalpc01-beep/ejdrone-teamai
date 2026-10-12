import { isAbsolute, join, relative } from 'node:path';

import { knowledgeDocsDir, knowledgeLearningsDir } from '../state.js';
import { resourceKey, type KindSet, type PlannedWrite, type Resource, type ResourceKind } from './types.js';

/**
 * 团队知识（M8 docs / M9 learnings）的投递：镜像到 `~/.ejdrone/knowledge/` 下的两个子目录。
 *
 * 与 skills/rules 的三处差别，逐条都是有意的设计（2.0 计划 §3.5、§7.1）：
 *
 * 1. **落点不在任何工具目录里**。16 个工具没有统一的知识落点，投进某个工具等于「只有那个工具
 *    能读到团队知识」；镜像目录 + `ejdrone recall` 才与工具无关。
 * 2. **并集语义**（`plan.ts` 的 KIND_SEMANTICS = 'union'）：同名文档不互相覆盖、也不因重名停发，
 *    所以这里必须按 `resource.name`（docs/learnings 的 name 已含 namespace 段）落文件，
 *    而不是把 ns 拍平 —— 拍平会让 `ns1/arch.md` 与 `ns2/arch.md` 互相盖掉。
 * 3. **走 apply 的整文件写入分支**，因此 1.0 的两条安全语义自动生效：成员改过的镜像副本不覆盖只点名；
 *    ledger 里有、候选集里没有 → 删除（namespace 失效、仓库删除都走这条路）。
 *
 * 落点全部由 `state.ts` 的 env 纯函数决定（`EJDRONE_HOME` 可覆盖），**不接 home 参数**：
 * 镜像根与工具目录的 home 锚点不同源，端到端测试靠伪造 HOME + EJDRONE_HOME 把两者隔开。
 */

const MIRROR_ROOT: Record<'docs' | 'learnings', (env?: NodeJS.ProcessEnv) => string> = {
  docs: knowledgeDocsDir,
  learnings: knowledgeLearningsDir,
};

/** 一条 kind=docs/learnings 的资源镜像到哪个绝对路径。 */
export function knowledgePath(
  kind: 'docs' | 'learnings',
  resource: Resource,
  env?: NodeJS.ProcessEnv,
): string {
  // name 里的 ns 段（`ns1/arch`）直接成目录层级：镜像结构与仓库里的 docs/ 子树一一对应，
  // recall 报出来的路径成员能对着仓库看懂。
  return join(MIRROR_ROOT[kind](env), `${resource.name}.md`);
}

/** 把裁决后的候选集渲染成写计划（docs 与 learnings 一次出齐）。 */
export function planKnowledge(kinds: KindSet, env: NodeJS.ProcessEnv): PlannedWrite[] {
  const writes: PlannedWrite[] = [];
  for (const kind of ['docs', 'learnings'] as const) {
    for (const resource of kinds[kind]) {
      const content = resource.files.content;
      // 采集层只产出 { content } 这一种形状（resources.ts 的 collectFlatMd）；
      // 缺了它说明上游装配写错，内部不变量直接抛，不静默投一个空文件。
      if (content === undefined) {
        throw new Error(`knowledge resource has no content: ${resourceKey(kind, resource.name)}`);
      }
      writes.push({ path: knowledgePath(kind, resource, env), content, resource: resourceKey(kind, resource.name) });
    }
  }
  return writes;
}

/** 这两个 kind 只走镜像、不进适配器（delivery 与 uninstall 共用同一条判据）。 */
export function isMirrorKind(kind: ResourceKind): kind is 'docs' | 'learnings' {
  return kind === 'docs' || kind === 'learnings';
}

/**
 * 这个绝对路径是否落在我们的知识镜像目录里。
 *
 * 为什么必须单独有这一条：`apply.ts` 的删除分支先问 `isManaged(path)`，不属于我们的就跳过。
 * 镜像根不在任何适配器的 `ownsPath` 里（它压根不在工具目录里），于是「停用 namespace 后把那份文档
 * 从镜像删掉」永远做不到 —— 账本里记着、候选集里没有了，却没人认领它，文件永久滞留。
 * 判据只认 `state.ts` 算出来的两个镜像根（`EJDRONE_HOME` 覆盖后照样对），
 * 不拿 `~/.ejdrone` 整棵子树当依据 —— 那会把 config.yaml、ledger.json、repo/ 全划成可删范围。
 */
export function isKnowledgePath(path: string, env?: NodeJS.ProcessEnv): boolean {
  return isUnder(path, knowledgeDocsDir(env)) || isUnder(path, knowledgeLearningsDir(env));
}

/** 与 `agents/common.ts` 的 `under` 同形（core 不反向依赖 agents，所以这里一份）。 */
function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
