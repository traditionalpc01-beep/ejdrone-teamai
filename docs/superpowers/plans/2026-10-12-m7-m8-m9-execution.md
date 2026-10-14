# M7 / M8 / M9 执行子计划 —— 子 Agent 下发 · 团队知识 · 经验沉淀

> 父计划：`docs/superpowers/plans/2026-10-11-ejdrone-teamai-2.0.md`（§2 范围、§3 契约、§7/§7.1 偏差登记为准）。
> 本文件把 M7/M8/M9 展开成 bite-sized 任务，是三个执行子代理的**唯一任务清单**。
> 全程硬规则见根目录 `AGENTS.md`；违反其中任何一条的交付一律退回。

**状态（2026-10-12）**：契约前置已由协调者落盘并全量测试通过 —— 三个新 kind 的编译期分派点、采集、裁决语义、
镜像投递与 delivery 接线都已就位。子代理**只做下面标了 owner 的文件**，不要顺手改契约。

---

## 0. 已落地的契约（子代理不得修改）

| 位置 | 内容 |
|---|---|
| `src/core/types.ts` | `ResourceKind = 'skills'\|'rules'\|'mcp'\|'agents'\|'docs'\|'learnings'`；`RESOURCE_KINDS` 六项；`KindSemantics = 'override'\|'union'`；`AgentAdapter.planAgents?` |
| `src/core/plan.ts` | `KIND_ROOT` / `KIND_SEMANTICS` / `KIND_ENTRY_EXT` / `KIND_QUALIFIED_NAME` 四张表；`resolveKind` 对 `union` 走「只过滤、不替换、不判冲突」分支；导出 `repoPathFor(resource)` |
| `src/core/resources.ts` | `collectFlatMd(kind, …, qualifiedName)` —— agents（`qualifiedName=false`）与 docs/learnings（`true`）共用；保留名 `team-codebase` 整目录跳过 |
| `src/core/knowledge.ts` | `knowledgePath()` / `planKnowledge(kinds, env)` / `isMirrorKind()` —— 镜像写计划，落点由 `state.ts` 的 env 函数决定 |
| `src/state.ts` | `knowledgeDir` / `knowledgeDocsDir` / `knowledgeLearningsDir`（`~/.ejdrone/knowledge/{docs,learnings}`，`EJDRONE_HOME` 可覆盖） |
| `src/agents/paths.ts` | `AgentsFormat = 'md'\|'agent-md'\|'toml'\|'json'`、`AGENTS_EXT`、`ToolPathSpec.agentsSubdir?/agentsFormat?`、`agentsTarget()`、`agentsRoot()` |
| `src/cli/delivery.ts` | 适配器循环里 `!halted.has('agents') && adapter.planAgents` 才投；循环后 `planKnowledge(...)` 一次出 docs+learnings；`managedRoots` 含 agents 目录与镜像根 |
| `src/cli/kinds.ts` | 六个 kind 的拼写与单数别名（`agent`/`doc`/`learning`） |

**关键不变量（照抄自父计划，别重新发明）**：

1. 能力有无只由 `paths.ts` 表决定。适配器与 delivery 里**不许出现按工具 id 的 if**（`mcpTarget` 的先例）。
2. docs/learnings 的 `Resource.name` 含 namespace 段（`ns1/arch`），这是 ledger 记账键唯一性的来源。
   破坏它的后果：停用 namespace 后那份文档永远删不掉。
3. 停发 ≠ 清空。`resolve()` 对停发 kind 把候选集清成空数组，`activeResourcesWithConflictHold` 负责把账本里的
   条目补回 active —— 不要绕过它去「顺手删干净」。
4. `src/core/types.ts` 是冻结契约。觉得不够用 → 回报协调者，不就地改签名。

---

## 1. 并行边界与文件归属

三个子代理同时在一个工作树里跑，**归属重叠=交付作废**：

| Owner | 里程碑 | 独占文件（新建/修改） | 只读参考 |
|---|---|---|---|
| **A** | M7 子 Agent | `src/agents/paths.ts`（**只填 10 行的 agents 两列**）、`src/agents/agentfmt.ts`、16 个适配器文件里的 `planAgents`、`src/agents/common.ts`（公共套件挂钩）、`src/agents/ownsPath` 相关分支、`src/cli/agentscollect.ts`（push --agent）、`test/agents/*.test.ts`、`test/integration/agents.test.ts` | `core/plan.ts`、`cli/delivery.ts`、`cli/push.ts`、`cli/mr.ts` |
| **B** | M8 团队知识 | `src/cli/recall.ts`、`src/core/recall.ts`（打分与扫描纯函数）、`test/core/recall.test.ts`、`test/cli/recall.test.ts`、`test/integration/knowledge.test.ts`、`skills/ejdrone-recall/SKILL.md`（若仓库有引导 skill 目录，见 `src/cli/init.ts` 的 seed 逻辑） | `core/knowledge.ts`、`core/resources.ts`、`state.ts` |
| **C** | M9 经验沉淀 | `src/cli/contribute.ts`、`src/core/learning.ts`（frontmatter 校验/补全、slug 与文件名生成）、`test/core/learning.test.ts`、`test/cli/contribute.test.ts`、`test/integration/learnings.test.ts`、内置 skill `ejdrone-share` | `cli/push.ts`、`cli/mr.ts`、`core/knowledge.ts`、`core/recall.ts`（B 的产物，**只读调用**） |

**协调者保留的收口动作**（子代理不要做，避免三个人在同一个文件里打架）：
`src/cli.ts` 的命令注册（`recall`、`contribute`、`push --agent`）、`README.md`、`src/cli/team-readme.ts` 生成物、
`AGENTS.md` 的 M7/M8/M9 不变量段、`docs/trials/` 试验记录。

因此 B/C 的测试**直接调用导出的命令函数**（`recallCommand(ctx, …)` / `contributeCommand(ctx, …)`）而不是走 `runCli`；
A 也是直接测适配器与 `planAgents`。等协调者接线后再补一层端到端 CLI 用例。

**唯一允许三人都碰的公共文件是 `src/cli/delivery.ts` 之外的测试夹具**：`test/integration/helpers.ts` 若需扩展
（比如 seed `agents/`、`docs/` 目录），A/B/C 各自加**新导出函数**，不改既有函数签名，函数名带里程碑前缀
（`seedAgents`、`seedDocs`、`seedLearnings`），冲突时协调者手工合并而不是覆盖。

---

## 2. M7 · 子 Agent 下发（owner A）

冻结事实（父计划 §7.1，来自 teamai 源码级复核）：有 agents 落点的只有 10 个工具 ——
`claude`、`qoder`、`qoder-cn`、`cursor`、`codex`、`copilot`、`codebuddy`、`workbuddy`、`opencode`、`kiro`；
`dsh`、`pi`、`openclaw`、`hermes`、`trae`、`trae-cn` **没有**（teamai 落点表里这些 id 根本没有 agents 键）。

- [x] **T7.1 落点表填值**：`paths.ts` 的 10 行各加 `agentsSubdir: 'agents'`（`pi` 那种多级写法用不上，这里都是根下
  `agents/`）与 `agentsFormat`：claude/qoder/qoder-cn/codebuddy/workbuddy/cursor/opencode = `md`；
  codex = `toml`；copilot = `agent-md`；kiro = `json`。`probe` 文案各补一句 agents 落点的核实状态，
  本机未装的工具（cursor/copilot/opencode/kiro/codebuddy/workbuddy 视真机情况）**必须写「未核」而不是删掉 PROBE**。
  Cursor 与 OpenCode 额外记一句：teamai 对它们改写 frontmatter 键（`agent_id` / 强制 `mode: subagent`），
  本轮按 `md` 原样投、留 PROBE。
- [x] **T7.2 agentfmt**：`src/agents/agentfmt.ts` 纯函数 `renderAgent(input: { name; description; tools?; model?; body }, format): string`。
  四种输出各自单测；再加一条「正文一字不变」断言（转换只动 frontmatter/封装）。
  `md` 用 `resources.ts` 的 `completeFrontmatter` 补 name/description（缺 frontmatter 要能补上，坏 YAML 保留原文并告警）。
  `toml` 只出 `name/description/developer_instructions/model`，**不写 tools**（父计划 §7.1）。
  `json` 出 `name/description/prompt/model/tools`，不注入 `hooks.agentSpawn`。
  `agent-md` 与 `md` 同内容，只差文件名（`AGENTS_EXT` 已给）。
- [x] **T7.3 适配器 `planAgents`**：在 `common.ts` 里做一份公共实现（查 `agentsTarget()`，无落点返回 `[]`，
  拍平投递 `<dir>/<name><ext>`），适配器只声明式接上。`ownsPath` 必须把 agents 目录纳管，否则卸载留孤儿。
- [x] **T7.4 命令面**：`list agents`（已由 kinds 自动认得，确认 `list.ts` 的表格对新 kind 出得来）、
  `remove agents <name...>`（确认 `repoPathFor` 给出的路径对：根 `agents/<n>.md`、ns `agents/<ns>/<n>.md`；
  同名出现在根与 ns 两处时照 teamai 语义**拒绝并列出**）、`push --agent <path>`（`src/cli/agentscollect.ts`：
  从选定工具的 agents 目录反向取一个文件写回仓库，走 MR；多工具同名且内容不同时要点名让你选）。
- [x] **T7.5 doctor**：agents 落点逐项可查（勾选了工具有落点、但目录不存在 → WARN；`agents/` 停发 → 点名）。
- [x] **T7.6 门槛**：`npm run typecheck` + `npm test` **全量**绿（不只跑新增文件）。
  端到端 `test/integration/agents.test.ts`：根 agent + ns agent → pull → claude(`.md`) 与 codex(`.toml`) 内容正确
  → 切角色后 ns agent 移除、根 agent 保留 → 二次 pull 幂等 → 成员改过投递文件后 pull 只点名不覆盖 → uninstall 无残留。
- [x] **T7.7 真机**：claude 投一个 agent，`/agents` 里可见可用；codex 看 `<name>.toml` 是否被列出。
  2026-10-13 已关闭（GA 收尾，证据在 `docs/trials/2026-10-13-windows-real-trial.md` §9）：真实 Claude Code 会话的
  `/agents` 面板列出了投递字节（项目级 `.claude/agents/` 与成员真实 `~/.claude/agents` 各目视一次，后者 216 份
  自有 agent 对账还原逐字节一致）；SessionStart hook 在真实 claude 进程里触发并自动拉回新推的 skill。
  headless `-p` 在该机不可用（端口被另一网关占用、成员 token 被拒），目视走 TUI 路线完成。

## 3. M8 · 团队知识（owner B）

- [x] **T8.1 扫描与打分**：`src/core/recall.ts` 纯函数 ——
  入参（镜像目录列表 + query + env/home），输出打分后的候选（title ×3 / frontmatter tags ×2 / 正文 ×1，前 5 条）。
  无索引（父计划 §7.1：teamai 的 index v7 是为更大规模准备的）。
  扫描范围 = `~/.ejdrone/knowledge/docs/` + `learnings/`；**不要**在这里重新实现 namespace 过滤
  —— 若要带 skills/rules 正文，复用 `resolve()` 对 checkout 只读跑一遍。
- [x] **T8.2 命令**：`src/cli/recall.ts` 导出 `recallCommand(ctx, query, options: { check?: boolean; json?: boolean })`。
  默认输出「路径 + 命中片段 ±2 行」；`--check` 输出 `RELEVANT score=<n> threshold=<n>` / `NOT_RELEVANT ...`，
  返回 0/1，**不投票不写日志**（这条语义是给 hook/skill 预检用的，必须与 teamai 一致）；`--json` 机器可读。
  镜像目录不存在 → 提示「还没 pull 过」并返回 0（不是错误状态）。
- [x] **T8.3 内置 skill**：`ejdrone-recall` —— 教 agent 动手前先 `ejdrone recall --check "<关键词>"`，RELEVANT 才读文件。
  放进 `src/cli/init.ts` 的种子内容与 `src/cli/team-readme.ts` 生成的 README；`push` 侧把 `ejdrone-recall` /
  `ejdrone-share` 设为**保留名拒绝入库**（照 teamai 的 `teamai-recall` 永不 push）。
  落地证据：`skills/ejdrone-recall/SKILL.md`、`src/cli/constants.ts` 的 `BUILTIN_SKILL_NAMES`、
  `test/integration/readme.test.ts` 5 例（含「成员本地那份 pull 下来的内置技能，push 仍被拒且仓库那份一字未动」）。
- [x] **T8.4 docs 镜像回归**：契约层已接好，B 负责把行为钉住：ns 过滤、`docs/<ns>/<name>.md` 镜像路径、
  成员改过镜像副本 → keep 点名、ns 失效 → 删除、`team-codebase` 保留名跳过。
- [x] **T8.5 门槛**：typecheck + 全量测试绿；端到端 `test/integration/knowledge.test.ts` 覆盖 T8.4 全部五条 +
  recall 命中根文档 / 不命中未激活 ns 文档 / `--check` 两种退出码。
  （2026-10-12 合入时 52 文件 / 883 例全绿；2026-10-13 Windows 真机 53 文件 / 893 例全绿。）
- [x] **T8.6 真机**：本机三次真实 recall（中英混合 query），人工判读前 5 条可用性，结论写进试验记录（协调者归档）。
  （2026-10-13 Windows 真机做了 5 组中英混合 query，含 `rebalance partition` 正确判 NOT_RELEVANT，
  见 `docs/trials/2026-10-13-windows-real-trial.md`。）

## 4. M9 · 经验沉淀（owner C，依赖 B 的 recall 扫描范围）

- [x] **T9.1 learning 文件形态**：`src/core/learning.ts` —— frontmatter `title/date/tags[]`，
  **缺则补、不缺不拒绝**（teamai 要求 tags 2–5 个否则不让提，我们靠 MR 评审补，见父计划 §7.1）；
  slug 允许中文、长度受限；文件名 `learnings/<YYYY-MM-DD>-<slug>.md`，**目标已存在就拒绝并提示改名**（不加 rand6）。
  （`test/core/learning.test.ts` 16 例。）
- [x] **T9.2 命令**：`src/cli/contribute.ts` 导出 `contributeCommand(ctx, options: { file: string; title?: string; ns?: string; dryRun?: boolean })`：
  读文件 → 校验/补全 frontmatter → 复用 `push` 的分支 + MR 管线写进 `learnings/`（**不是** teamai 的孤儿分支）→
  输出 MR 链接或 generic provider 的手动开 MR 指引。`--dry-run` 只打印落库后的文件内容与目标路径，
  **一个 git 副作用都不许有**（不建分支、不 push、不开 MR）。`--ns` 多 namespace 角色必给，与 push 同规则。
  （`test/cli/contribute.test.ts` + `test/integration/learnings.test.ts` 7 例，`--dry-run` 断言远端分支集合与 main sha 逐字不变。）
- [x] **T9.3 内置 skill**：`ejdrone-share` —— 被反复纠正/工具连续失败时主动总结成 learning 并提示用户跑 contribute；
  只在用户明确说「分享给团队」时才真的执行。（`skills/ejdrone-share/SKILL.md`，保留名同 T8.3。）
- [x] **T9.4 门槛**：typecheck + 全量测试绿；端到端 `test/integration/learnings.test.ts`：
  contribute → 合入 → 另一成员 pull → 镜像里出现该 learning → recall 命中它；`--dry-run` 无副作用；同名文件拒绝。
- ~~**T9.5（stretch，可砍）** Stop hook 摩擦提示~~ **已砍**（2026-10-12 探测结论：`paths.ts` 只有单值
  `hookEvent`（全为 SessionStart），Stop 事件的可读 stdin/transcript 在 claude/codex/qoder-cn 三家 0 家有据，
  按「三选二才做」判据不达线；登记在父计划 §7.2）。

---

## 5. 每个 owner 的交付格式（回报协调者时用这个结构）

1. 做完/没做完的 T 编号清单，**逐条附证据**：测试文件路径 + 用例名 + 最后一次 `npm test` 的 pass/fail 数字。
2. 契约不够用的地方（若有）：写清楚卡在哪一行、你想要什么签名 —— **不要自己改 `types.ts`**。
3. 与父计划 §2 范围的偏差：多做的（顺手加的索引、tombstone、upvote、`--force` 口子）自己砍掉再交。
4. `git status --short` 的输出，确认只动了归属之内的文件。

验收线：**`npm run typecheck` 0 错误 + `npm test` 全量绿**，且 §10 安全红线一条都没破
（不在 ledger 里的文件绝不删；本地改过的投递文件只点名不覆盖；写入路径限制在落点表目录内）。
