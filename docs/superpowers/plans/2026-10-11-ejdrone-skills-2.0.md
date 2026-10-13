# ejdrone-skills 2.0 迭代开发计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ejdrone-skills 从「5 工具 × skills/rules × macOS/Linux」扩到「16 工具 × skills/rules/MCP/子Agent/团队知识/经验沉淀 × macOS/Linux/Windows」。

**Architecture:** 沿用 1.0 架构骨架：Git 仓库是唯一真相源、`resolve()` 纯函数裁决、ledger 记账投递、适配器表驱动。
2.0 不改骨架，只做三类加法：① `paths.ts` 工具表 5→16；② `ResourceKind` 扩四类，新增 mcp 列表文件解析与
「受管条目合并」投递语义；③ 新增 `src/platform.ts` 收口 Windows 差异。对标腾讯 teamai-cli 的公开文档与源码，
只借鉴决策与格式，不复用代码（与 1.0 同一原则）。

**Tech Stack:** TypeScript (NodeNext/ESM)、commander、yaml、zod、vitest（真实 git 端到端）、Node.js ≥ 20。

---

## 0. 怎么执行这份计划

这份计划覆盖四个独立子系统，颗粒度到「里程碑 → 任务 → 文件」。它**冻结契约、名单、语义和验收线**，
不代替逐行 TDD 步骤。执行模型沿用 1.0 验证过的流程：

1. **每个里程碑开工前**，协调者把该里程碑的任务展开成子计划（`docs/superpowers/plans/2026-XX-XX-m<N>-<名>.md`），
   子计划才是 bite-sized TDD 步骤（写失败测试 → 实现 → 过测试 → 提交）。
2. **契约先行**：本文件 §3 的契约变更在任何代码任务前合入 `src/core/types.ts`（含注释），之后子代理只依赖契约通信。
3. **并行子代理**：标注「可并行」的任务由独立子代理执行，互不共享状态；每个子代理交付时 `npm run typecheck` + `npm test` 全绿。
4. **终审**：每个里程碑合并前过一次全仓 review（对照本文件 §2 范围，多做的砍掉、少做的补齐）。
5. **真机试验**：每个里程碑结束按 `docs/trials/2026-10-11-ejdrone-demo-trial.md` 的格式出一份试验记录
   （`docs/trials/2026-XX-XX-m<N>-trial.md`），结束后按备份**逐字节还原**本机。
6. 执行中发现「看着别扭但像是有意」的行为，先查 §7 偏差登记处和 1.0 设计文档 §14，都没有再上报协调者，**不要就地改**。

全程硬规则见根目录 `AGENTS.md`（冻结契约、安全红线、锁、临时 HOME 测试），执行前必读。

---

## 1. 背景与对标依据

### 1.0 现状（2026-10-11，commit `7ffc33a`）

`src/` 42 文件 / 约 5500 行；5 个工具适配器；`ResourceKind = 'skills' | 'rules'`；user scope；macOS/Linux；
验收 `tsc --noEmit` 0 错误 + vitest 214/214 绿。设计文档：`docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md`。

### 对标物核对结果（Tencent/teamai-cli，首轮 2026-10-11 核对 commit `2cbf556`；M7/M8/M9 相关三行于 2026-10-12 二次复核，落到源码级证据）

| 维度 | teamai-cli 实际做法 | 出处 |
|---|---|---|
| 支持工具 | 19 个 id + 变体：claude(tclaude/claude-internal)、codex(tcodex/codex-internal)、cursor、copilot、codebuddy、workbuddy、opencode、pi、openclaw、hermes、dsh、qoder、qoder-cn、kiro、trae、trae-cn、zcode、omp、joycode | `README.zh-CN.md` |
| 资产类型 | skills、rules、docs、env、hooks、mcp、models、agents、learnings、codebase、teamwiki | `README.zh-CN.md`、`docs/guide/zh-CN/sharing.md` |
| MCP | `mcp/mcp.yaml` + `mcp/<ns>/mcp.yaml`；server 字段 `name/description/transport(stdio\|http\|sse)/url/headers/timeout/command/args/env/requires/tools`；按工具原生格式写入（Claude 系 `mcpServers` JSON、Codex `config.toml`、Copilot `type: local/remote`、OpenCode `mcp` 键）；`${VAR}` 解析成明文落盘、文件收紧 0600、含 token 的项目级文件自动进 `.git/info/exclude` | `sharing.md` §MCP Server |
| 子 Agent | **新格式是 `agents/<name>.yaml`**（字段 `name`/`description`/`instructions`/`model`/`tools[]`/`targets[]`/`tool_extras.<tool>`，任一必填缺失该文件解析失败但不中断本次 pull）；旧格式 `agents/<name>.md` **逐字节复制**且只有白名单工具收（claude 系、codebuddy、joycode、omp）。投递按文件名拍平：Claude 系 `<name>.md`（frontmatter name/description/model/tools + extras）、Codex 系 `<name>.toml`（键 `name/description/developer_instructions/model`，**故意不写 tools**）、Kiro `<name>.json`（`name/description/prompt/model/tools` + 注入 `hooks.agentSpawn`）、Copilot `<name>.agent.md`（tools 过别名表）、Cursor `.md` 但 frontmatter 键叫 **`agent_id` 不是 `name`**、OpenCode `.md` 不写 `name` 且强制 **`mode: subagent`**；Qoder/Qoder CN/CodeBuddy/WorkBuddy 用 md；**Trae、Trae CN、Pi、OpenClaw、Hermes、dsh 无 agents 落点 → 整体跳过**。namespace 语义同 rules（同名整体替换）；两个活跃 ns 同名 → agents 停发、已装不动。`remove agents <name>` 写 tombstone `agents/.removed`，下次 pull **即使仓库无变化**也把 `<name>.{md,agent.md,toml,json}` 从每个工具目录删掉 | `docs/guide/zh-CN/advanced.md` §Agents + 源码 `resources/agent-format.ts`、`resources/agents.ts`、`types.ts` 落点表 |
| 团队知识 | `docs/` 作为**一个 bundle 镜像到单一目录**（`sharing.docs.localDir`，默认 `~/.teamai/docs`），**不按工具分发、只被 recall 索引**；`docs/` 不回推（`scanLocalForPush` 返回空）、`remove docs` 明确不支持（要求直接在仓库删）。`docs/<dir>/` 被任一 role 列出即成为 ns，只发给激活者，**无覆盖规则**（每个 ns 独立子树）；ns 失效后只删「与团队当前或历史版本逐字节一致」的副本，成员改过的保留点名。保留名 `RESERVED_DOCS_DIR = 'team-codebase'`（声明它的 manifest 加载失败） | `sharing.md` §Docs + 源码 `resources/docs.ts`、`manifest-schema.ts` |
| 经验沉淀 | recall 用**持久索引**（`SEARCH_INDEX_VERSION = 7`，`~/.teamai/search-index.json`）：四路采集 learnings/docs/rules/skills + codebase 图，打分 title 3 / tag 2 / body 1 × 域内 IDF ÷ √query 长度，vote +0.5/票（上限 5），域乘子 technical 1.0…support 0.3，**必须命中 title 或 tag**（docs 例外）。`recall [query…] --depth|--check|--caller`，`--check` 输出 `RELEVANT|NOT_RELEVANT score=… threshold=…`，阈值 `max(idfBaseline×1.35, 4.0)`，不读正文、不投票；配置存在但读不了 → 打印 `Nothing was searched: …` 并 **exit 1**。learnings 必填 frontmatter `title/author/date/tags`（2–5 个），正文 Context/Solution/Lessons/Related Skills，文件名 `<slug>-<YYYY-MM-DD>-<rand6>.md`；`contribute --file --title --namespace [--dry-run]` 先写持久队列 `pending-learnings/` 再 publish 到**孤儿分支 `teamai-learnings` 的 worktree**——**不走 MR、不碰默认分支**；`--namespace` 只接受活跃 learnings ns 否则 exit 1。置信度 = `min(1, recalled×0.1+upvoted×0.3)×0.4 + recency×0.3 + upvote/recall×0.3`；晋升判据 confidence ≥0.90、upvoted ≥5、贡献者 ≥2、年龄 ≥14 天 | `docs/guide/zh-CN/knowledge.md` + 源码 `recall.ts`、`utils/search-index.ts`、`contribute.ts`、`utils/learnings-publish.ts`、`contribute-check.ts` |
| Windows | hook 命令用 Git Bash 绝对路径（标准安装位置 → 注册表 `HKLM\SOFTWARE\GitForWindows`），裸 `bash` 会解析到 WSL 启动器（自带 Node 18）导致 hook 静默崩溃；每个 GUI 工具解析自己的 hook shell；`requires` 匹配走 `PATHEXT`；shell profile 注入要沿 `source` 链找目标文件 | `docs/guide/zh-CN/windows.md`、`advanced.md` §Hooks |
| 环境变量/密钥 | `env/env.yaml` + `env/secrets.yaml`（只声明 key 不写值），成员 `teamai env set` 本地存值（0600），`env exec` 叠加运行 | `sharing.md` §Env |

源码规模旁证：teamai-cli `src/` 单文件最大 222KB（`local-agent.ts`）、`mcp-reconcile.ts` 164KB、`hooks.ts` 155KB——
它的大部分复杂度来自 project scope、HTTP 后端与 dashboard，这些 2.0 仍然不做（§2）。

## 2.0 一句话目标

团队 15-25 人、内网 GitLab、单人维护的约束不变；把 1.0 砍掉的能力里**团队现在真正要的**补回来，其余继续砍。

---

## 2. 范围（冻结）

### 做

| # | 能力 | 验收形态 |
|---|---|---|
| 1 | 工具 5 → 16 | `paths.ts` 16 行表项；每工具 skills/rules 落点、hook 落点；doctor 逐项可查 |
| 2 | MCP 下发 | `mcp/mcp.yaml` + `mcp/<ns>/mcp.yaml` → 各工具原生 MCP 配置文件（受管条目合并，不动用户自己的 server） |
| 3 | 子 Agent 下发 | `agents/` → 各工具原生 agents 目录（按工具转换格式） |
| 4 | 团队知识（docs） | `docs/` 镜像到 `~/.ejdrone/knowledge/`，`ejdrone recall "<query>"` 可检索 |
| 5 | 经验沉淀（learnings） | `learnings/` + `ejdrone contribute --file`（走 MR）+ recall 可检索；Stop hook 摩擦提示为 stretch |
| 6 | Windows 支持 | Windows 真机上 init → pull → hook 自动 pull → doctor 全绿；e2e 在 Windows 跑通 |

### 16 个工具名单（冻结；替换原则见下）

现有 5 个：`claude`、`qoder-cn`、`cursor`、`codex`、`dsh`。
新增 11 个：`qoder`、`copilot`、`codebuddy`、`workbuddy`、`opencode`、`pi`、`openclaw`、`hermes`、`kiro`、`trae`、`trae-cn`。

- 从 teamai 名单里砍掉 `zcode`、`omp`(Oh My Pi)、`joycode`：zcode 的 hook 要走 `wscript.exe` 启动器（特例成本），
  omp/joycode 公开格式文档最少；三个都不是团队已知在用的工具。
- **替换原则**（名单本身要改时适用）：数量不超过 16；入选需同时满足「用户级配置目录可探测、配置格式有公开文档或真机可读、
  有可用 hook 机制或可接受无 hook」。换掉谁、补谁，登记到 §7。

### 不做（每项一句理由；与 1.0 非目标表并列生效）

| 不做 | 理由 |
|---|---|
| hooks 资源下发（团队自定义 hook） | 安全面最大的一类下发（可执行命令），teamai 要三个治理开关才放行；团队当前无需求，2.1 再评估 |
| models 统一下发 / 模型别名 | 1.0 非目标理由仍成立：团队对模型出口无限制 |
| env / secrets 子系统（`env.sh`、`secrets.yaml`、`env exec`） | 独立大子系统；2.0 里 MCP 的 `${VAR}` 只从**进程环境**解析兜底，2.1 候选 |
| learnings 的摩擦自动评分提示 | 依赖逐工具 Stop hook + transcript 解析；列为 M9 stretch，探不通就砍，不阻塞主线 |
| recall 采纳 upvote | 依赖 PostToolUse 读追踪，teamai 19 个工具里 8 个不支持、3 个未验证；投入产出不合算，2.1 候选 |
| `zcode` / `omp` / `joycode` | 见上「替换原则」 |
| teamwiki / codebase 知识图谱 / dashboard / votes / session 统计 | teamai 侧仍标 beta 且依赖本地服务与上报；与「不建服务端」冲突 |
| project scope、多项目、tags、GitHub provider、HTTP provider、服务端 | 1.0 非目标继续有效，本轮不重开 |

---

## 3. 契约冻结（`src/core/types.ts` 升级）

以下变更在任何实现任务之前合入，合入即冻结；子代理不得就地改签名，有异议报协调者。
`// 2.0:` 前缀注释标注新增项。完整 diff 由 M5 前置任务落盘，此处冻结语义。

### 3.1 ResourceKind 与 Resource

```ts
// 2.0: 扩四类。skills/rules 语义不变。
export type ResourceKind = 'skills' | 'rules' | 'mcp' | 'agents' | 'docs' | 'learnings';
```

- `skills`、`agents`：目录型资源，`files` 为「仓库内相对路径 → 内容」；agents 必含 frontmatter 的 md（旧格式不收 yaml，见 M7）。
- `rules`、`docs`、`learnings`：单文件 md，`files = { content: 正文 }`（docs/learnings 带 frontmatter）。
- `mcp`：**不是文件资源**。`mcp/mcp.yaml` 是列表文件，解析后每个 server 变成一个 `Resource`
  （`kind: 'mcp'`, `name` = server 名），结构化内容放新增字段 `payload`：

```ts
// 2.0: 仅 mcp 使用；其他 kind 必须为 undefined（zod 校验保证）。
export interface Resource { /* 原有字段不变 */ payload?: McpServerDef }

export interface McpServerDef {
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  url?: string;                    // http/sse
  headers?: Record<string, string>;
  timeoutMs?: number;
  command?: string;                // stdio
  args?: string[];
  env?: Record<string, string>;
  requires?: string[];             // PATH 探测（Windows 走 PATHEXT）
  tools?: string[];                // 只下发给这些工具 id；缺省 = 所有支持 MCP 的工具
}
```

### 3.2 裁决语义（`resolve()` 不变，规则扩展）

`ResolveInput` / `Resolution` 的 `skills`/`rules` 两个字段改为 `Record<ResourceKind, Resource[]>` 形式
（`haltedKinds` 语义不变）。四类新资源的裁决规则与 1.0 §7 完全一致：

1. 候选集 = 根条目 ∪ 激活 namespace 条目；同 `(kind, name)` 时 namespace **整体替换**根条目。
   mcp 按 server `name`、其余按资源 `name`。
2. 两个激活 namespace 定义同 `(kind, name)` → 该 kind 整体停发，其他 kind 不受影响。
3. 解析失败（坏 YAML、缺 frontmatter、未知顶层 key）→ 该条目跳过并记 warning；**mcp.yaml 文件级解析失败 → mcp 全 kind 停发、已装内容不动**（teamai 同策略，验证有效）。
4. manifest 不可解析 → 全量停发（1.0 已有）。

namespace 声明**不加新机制**：1.0 的 `roles[].namespaces` 对全部 kind 生效
（`skills/<ns>/`、`mcp/<ns>/mcp.yaml`、`agents/<ns>/`、`docs/<ns>/`、`learnings/<ns>/` 同一名称）。
manifest `version: 1` 不变，1.0 团队仓库零迁移；新目录缺席 = 该 kind 空集。

### 3.3 受管条目合并（mcp 专用，2.0 最大设计点）

mcp 落点是**与用户条目共存的共享配置文件**（`~/.claude.json`、`~/.codex/config.toml` 等），整文件覆写不可接受，
block 标记在 JSON/TOML 里也不存在。新增投递语义：

```ts
export interface PlannedWrite {
  path: string; content: string; resource: ResourceKey;
  region?: { start: string; end: string };            // 1.0 已有
  // 2.0: 与 region 互斥。存在时 content 为空，由 apply 层读原文件做条目级合并：
  merge?: {
    format: 'json' | 'toml';
    pointer: string[];                                // 条目表位置，如 ['mcpServers'] 或 ['mcp_servers']
    entries: Record<string, string>;                  // 条目 key → 已解析 ${VAR} 后的条目 JSON/TOML 文本
  };
}
```

合并规则（实现落在 `core/merge.ts` 纯函数 + `core/apply.ts` 接入，逐条有测试）：

1. 我方条目集合 = `merge.entries` 的 keys；`LedgerEntry` 新增 `managedKeys?: Record<string,string>`
   （条目 key → 当时投递文本的 `sha256:`）。执行时从计划的初稿 `string[]` 改成这个形状：
   只记 keys 就无法实现规则 2（没有"上次投递的那份文本"可比）。
2. 本次有、上次也有：文件里该条目与上次投递相符 → 覆写；不相符 → 用户改过 → keep 点名，不动。
   **相符的判定是规范化比较**：JSON 键排序后比（格式化/键序抖动不算"成员改过"），TOML 按块原文逐字节比。
3. 本次没有、上次有：同上判定，未改过 → 删除该条目；改过 → keep。
4. 文件里存在、两次投递都没有的 key → 用户的，永不触碰、永不重排（TOML 侧连注释与表序都逐字节不变）。
5. 文件不存在 → 新建（0600）；文件存在但解析失败或形状认不出 → 该工具本次 mcp 投递整体跳过并 FAIL 级点名，**不改文件**。
   TOML 只认 `[mcp_servers.<name>]` + 其子表这种受控形态；遇到 `[[`、内联表 `mcp_servers = {…}`、引号/括号不平衡一律判异形跳过
   —— 宁可不投，也不要在成员手写的 TOML 里猜。
6. 任何写出前先把整个新文件内容算好再落盘（沿用「先算完整 plan」原则）；含已解析 `${VAR}` 值的文件收紧 0600，
   已解析值**永不打印**到 stdout/stderr/log。渲染阶段抛错时 `writeFileSync` 一次都不能被调用。
7. 执行中补的三条（计划初稿没覆盖）：
   - **恒发一条 merge write**：工具有 `mcpTarget` 且 mcp 未停发时，`planMcp` 返回恰好一条 write，`entries` 可以为空。
     否则"最后一个 server 停投"永远清不掉，成员文件里留下没人认领的孤儿条目。
   - **合成 resource key** `mcp:<tool>-merge`（照 block 的 `rules:team-rules-block` 惯例）并计入 `activeResources`，
     这样 1.0 的"冲突停发 ≠ 清空"不变量对 mcp 自动成立。
   - **merge 落点与 hookFile 是同一个文件**（Qoder CN 的 `settings.json`）：两条写路径各自只动自己的键，
     `hooks` 与 `mcpServers` 互不破坏，权限也照原文件保留。

### 3.4 ToolPathSpec 扩展（`src/agents/paths.ts`）

```ts
// 2.0 新字段（均可选，缺席 = 该工具不支持此能力）：
agentsSubdir?: string;        // 子 Agent 落点（相对工具根）
agentsFormat?: 'md' | 'toml' | 'json' | 'agent-md';  // 投递时的转换目标
mcpTarget?: {                 // 用户级 MCP 落点
  file: string;               // 相对工具根（claude 例外：~/.claude.json 在 HOME 下，用绝对锚点字段表达）
  format: 'json-mcpServers' | 'toml-codex' | 'json-opencode' | 'json-copilot';
};
hookEvents?: string[];        // 该工具支持的 hook 事件全集（1.0 只有 SessionStart 一个）
```

16 工具 × (skills/rules/agents/mcp/hook) 的落点矩阵是 M5 任务 1 的交付物（一张表，每格标 `已核实` 或 `PROBE`），
合入 `paths.ts` 注释。已知格式从 teamai `sharing.md` 落点表照抄并标 PROBE，真机核对后逐项销记。

### 3.5 本地状态与镜像

- `~/.ejdrone/knowledge/docs/`、`~/.ejdrone/knowledge/learnings/`：投递镜像，recall 只读这里。
  由 `state.ts` 新增 `knowledgeDocsDir(env)` / `knowledgeLearningsDir(env)`，与现有路径函数同形（env 注入，不读全局）。
- `config.yaml`（`version: 1`）不变；`ledger.json` 加可选 `managedKeys`（向后兼容：旧文件无此字段按空集处理）。
- 新环境变量（全部可选，测试注入用）：无。沿用 `EJDRONE_HOME` / `EJDRONE_NODE` / `EJDRONE_CLI`。

---

## 4. 里程碑

顺序与依赖：**M5 先行**（工具矩阵是 M6/M7 的输入）→ **M6 与 M7 可并行** → **M8**（可与 M6/M7 并行）→ **M9 依赖 M8** →
**M10 最后**（横切面，且要前面所有功能在 Windows 上复验）。每个里程碑独立完成「设计冻结 → 并行子代理 → 终审 →
全量测试 → 真机试验 → 还原」闭环，全部完成才算 2.0。

### M5 · 工具矩阵 5 → 16

**目标**：11 个新适配器上线，skills/rules/hook 三类能力配齐；未核实落点全部走 PROBE 机制（doctor WARN 点名）。

**契约前置**：§3.4 落点矩阵表合入 `paths.ts`（此任务由协调者本人做，不派子代理）。

**任务**（每组一个子代理，可并行；每个适配器一个文件 + 对应测试文件）：

- [x] **T5.1 冻结落点矩阵**：16 工具 × 5 能力格，逐格填路径/格式 + `已核实|PROBE` 标记。
  依据 teamai `sharing.md` §MCP 落点表与 `advanced.md` §Hooks，结合各工具官方文档；填不出的一律 PROBE，禁止猜。
  交付：`paths.ts` 表 + 注释。
- [x] **T5.2 适配器组 A**（`codebuddy`、`workbuddy`、`copilot`、`kiro`）：
  Create `src/agents/codebuddy.ts`、`workbuddy.ts`、`copilot.ts`、`kiro.ts`；Test `test/agents/adapters.test.ts` 扩展。
  已知锚点：copilot 根目录读 `COPILOT_HOME`（绝对路径才生效，同 `DSH_HOME` 规则）；kiro 的 SessionStart 不以文件 hook 存在
  （teamai 以 agent 同步内嵌）→ `installHook` 允许返回 `{ installed: false, reason }`，doctor 据 reason 显示。
- [x] **T5.3 适配器组 B**（`opencode`、`pi`、`openclaw`、`hermes`）：
  同上。锚点：opencode 根在 `~/.config/opencode/`；openclaw 只有 SessionStart+UserPromptSubmit 且 hook 是 workspace 级
  （user scope 下按「无可用 hook」处理，installed:false）；hermes 只有 SessionStart。
- [x] **T5.4 适配器组 C**（`qoder`、`trae`、`trae-cn`）：
  同上。锚点：trae/trae-cn 无用户级 MCP 落点（仅项目级）→ mcpTarget 缺席；hook 落点全部 PROBE。
- [x] **T5.5 注册与 doctor**：`src/agents/index.ts` 注册 16 个；`doctor` 逐工具检查 detect/hook/落点，PROBE 项 WARN。
- [x] **T5.6 门槛**：`npm run typecheck` + `npm test` 全绿；新增适配器每个至少 3 个单测（detect / planSkills+planRules / ownsPath）。
- [x] **T5.7 真机**：本机已装的工具（claude、qoder-cn、codex）回归投递幂等；未安装工具用临时目录伪造根目录验证 detect
  不误报。试验记录 + 逐字节还原。

**回滚**：适配器是纯增量，摘除 `index.ts` 注册即回到 1.0 行为。

### M6 · MCP 下发

**目标**：`mcp/mcp.yaml` + namespace 文件 → 各工具原生 MCP 配置，受管条目合并不动用户条目。

**契约前置**：§3.1 `McpServerDef`、§3.2 裁决扩展、§3.3 合并语义合入 `types.ts`（协调者本人做）。

**任务**：

- [x] **T6.1 解析器**：Create `src/core/mcp.ts` — 解析 `mcp/mcp.yaml` 与 `mcp/<ns>/mcp.yaml`（zod strict；
  未知 key 报错入 warnings；`servers:` 顶层 key 缺失 = 文件级失败 → mcp 停发）。Test `test/core/mcp.test.ts`：
  合法/坏 YAML/未知 key/缺 servers key/ns 覆盖/双 ns 同名冲突。
- [x] **T6.2 `${VAR}` 解析**：同一文件内。只从 `env` 参数（进程环境）取值；取不到 → 该 server 跳过并点名
  （interactive 打印 + `mcp list` 标 missing；silent 写 debug.log）。已解析值不进任何输出。Test 覆盖。
- [x] **T6.3 裁决接入**：`core/plan.ts` + `core/resources.ts` 按 §3.2 接 mcp；`resolve()` 输出 mcp 候选集。
- [x] **T6.4 合并投递**：`core/apply.ts` 实现 §3.3 六条规则；`core/ledger.ts` 读写 `managedKeys`。
  Test `test/core/apply.test.ts`：六条规则各至少一例，外加「合并中途任何一步失败不留半写文件」。
- [x] **T6.5 适配器 `planMcp`**（可与 T6.4 并行，依赖契约）：`AgentAdapter` 新增 `planMcp(servers, home, env): PlannedWrite[]`。
  四种格式 writer 收口在 `src/agents/mcpfmt.ts`（json-mcpServers / toml-codex / json-opencode / json-copilot），
  适配器只查表调用；`mcpTarget` 缺席的工具返回空数组。`tools:` 字段过滤在 planMcp 入口统一做。
  codex 跳过 `sse`（其不支持）并 warning。`requires` 探测在此做（Windows PATHEXT 由 T10.1 的 platform 层兜底，
  M6 先做 POSIX `PATH` 查找并留接口）。
- [x] **T6.6 命令**：`push --mcp <name>`（从本机某工具配置里反向采集一个 server 入仓库，走 MR）、
  `remove mcp <name...>`、`list mcp`、`status` 计入 mcp；doctor 加「mcp 文件可解析 / 受管条目与账本一致」检查。
- [x] **T6.7 门槛**：typecheck + 全量测试绿；端到端用例（`test/integration/`）：仓库声明 stdio+http 两个 server →
  成员 pull → 断言 claude/codex/cursor 三工具配置文件条目正确、用户自有条目原样、二次 pull 幂等、
  停用 ns 后条目移除且用户条目不动。
- [x] **T6.8 真机**：本机 claude + qoder-cn 实际注入一个 `npx -y` 型 stdio server 与一个不存在的 url 型 http server，
  开工具确认前者出现、后者跳过点名；`doctor` 无 FAIL。试验记录 + 逐字节还原。

**回滚**：`mcp/` 目录从团队仓库删除（MR），pull 后各工具受管条目移除（规则 3），用户条目不动。

### M7 · 子 Agent 下发

**目标**：`agents/` 目录资源 → 各工具 agents 目录，逐工具格式转换。

**契约前置**：§3.1（agents 为目录型资源）、§3.4 `agentsSubdir`/`agentsFormat`（由协调者随 M7 前置任务落 `paths.ts`）。

**2026-10-12 二次复核后固定的三张表**（子代理照此实现，不要再回去猜）：

1. **有 agents 落点的工具 = 10 个**：`claude`、`qoder`、`qoder-cn`、`cursor`、`codex`、`copilot`、`codebuddy`、
   `workbuddy`、`opencode`、`kiro`。**`dsh`、`pi`、`openclaw`、`hermes`、`trae`、`trae-cn` 无 agents 落点**
   （teamai 源码 `types.ts` 落点表里这些 id 根本没有 agents 键；openclaw 真机 `~/.openclaw/agents` 存在但那是
   工具自家目录、非团队 agent 载体）→ `agentsSubdir` 缺席 → 适配器不实现 `planAgents`，**照 mcp 的先例：能力有无只由表决定**。
2. **四种目标形态**：`md`（Claude 系 / Qoder 系 / CodeBuddy / WorkBuddy，frontmatter `name/description/tools/model`）·
   `agent-md`（Copilot，文件名 `<name>.agent.md`）· `toml`（Codex，键 `name/description/developer_instructions/model`，
   **故意不写 tools**）· `json`（Kiro，键 `name/description/prompt/model/tools`）。
3. **两处工具怪癖登记为 PROBE，不在本轮实现**：Cursor 的 frontmatter 键叫 `agent_id` 而非 `name`、
   OpenCode 不写 `name` 且强制 `mode: subagent`。两者本机均未安装、无法真机核实，先按 `md` 投，
   落点表 `probe` 文案点名「teamai 对该工具改写 frontmatter 键，未核」；真机核实后再补形态（§7 已登记）。
   Kiro 的 `hooks.agentSpawn` 注入不做——那是 teamai 把 hook 藏在 agent 文件里的做法，我们 agents 与 hooks 分属两条链路。

**任务**：

- [x] **T7.1 解析器**：`core/resources.ts` 扩展 agents：仓库 `agents/<name>.md`、`agents/<ns>/<name>.md`；
  只收 md（teamai 的新格式 yaml 不收——多一种源格式就多一条转换链，md frontmatter 已够用，登记 §7）；
  frontmatter 缺 `name`/`description` 时自动补全（沿用 1.0 `completeFrontmatter` 与「坏 YAML 保留原文 + 告警」）。
  Test 覆盖：根/ns/缺 frontmatter/坏 YAML/同名冲突。
- [x] **T7.2 裁决接入**：agents 走 §3.2 完整规则（覆盖 + 冲突停发），同 skills/rules。
- [x] **T7.3 格式转换器**：Create `src/agents/agentfmt.ts` — 输入统一 frontmatter+正文，输出上述四种。
  公共入口 `renderAgent(spec, format)`；适配器只查 `agentsFormat` 调它，**不许按工具 id 写 if**。
  Test：四种格式各一例 + 往返不丢字段 + 「正文字节不变」断言（转换只动 frontmatter/封装）。
- [x] **T7.4 适配器 `planAgents`**：`AgentAdapter` 新增可选方法；`agentsSubdir` 缺席返回空。
  拍平投递（ns 目录拍平成 `<name>.<ext>`），同名冲突由裁决层已拦。
- [x] **T7.5 命令**：`push --agent <path>`、`remove agents <name...>`（带 ns 写 `<ns>/<name>`，多位置同名拒绝并列出，
  照 teamai 语义）、`list agents`。`remove` 走 MR 删仓库文件即可——1.0 的「合入后 pull 移除」语义不变，
  不需要 teamai 的 tombstone（我们没有「仓库没变也要清理」的场景，登记 §7）。
- [x] **T7.6 doctor**：agents 落点逐项可查（有落点但目录不存在 = WARN；停发 = FAIL 点名）。
- [x] **T7.7 门槛**：typecheck + 全量测试绿；端到端：根 agent + ns agent → 成员 pull → claude（md）与 codex（toml）
  落点内容正确 → 切角色后 ns agent 移除、根 agent 保留 → 二次 pull 幂等。
- [ ] **T7.8 真机（部分完成，2026-10-13）**：agent 投递到真实 Windows 成员目录后的**内容级**核对已过（claude 收到 `kafka-ops.md`、codex 收到 `kafka-ops.toml` 且确实没有 tools 键、ns agent 只给订阅者）；仍欠「打开真实 Claude Code 会话确认 `/agents` 把它列出来」—— 试了 headless `claude -p` 与 `--include-hook-events`，本机 150s 内零输出（退出码 124），登记为环境阻塞。证据见 `docs/trials/2026-10-13-windows-real-trial.md` §4 与 §7.3。
  试验记录 + 逐字节还原。

**回滚**：删 `agents/` 目录（MR），pull 后移除。

### M8 · 团队知识（docs）+ recall

**目标**：`docs/` 按角色裁剪镜像到本地；`ejdrone recall` 一条命令检索知识。

**二次复核确认的对标事实**：teamai 的 docs 也是**镜像到单一本地目录**（默认 `~/.teamai/docs`）且**只被 recall 索引、
不按工具分发**，与我们的 `~/.ejdrone/knowledge/docs/` 同形——这条不是我们的发明。另外 teamai 的 docs
**不支持从本地回推**（`scanLocalForPush` 返回空）、`remove docs` 明确不支持。这两条我们照抄：知识入库只有 `push --doc`
之外的路（直接在仓库 `docs/` 提交走 MR），避免「成员本地目录里的文件算不算团队资产」这条含糊账。

**任务**：

- [x] **T8.1 docs 资源**：docs 为单文件 md 资源（`docs/**.md`，`docs/<ns>/` 为 namespace 子树）。
  与 rules 的差异：**无覆盖语义**——ns 子树是独立集合，不替换根文件（teamai 同，避免「同名文档互相盖」）。
  `resolve()` 对 docs 跳过覆盖/冲突两条规则，只做并集。`team-codebase` 保留名禁用（teamai 教训；2.1 若加 codebase 就不撞车）。
- [x] **T8.2 镜像投递**：投递到 `~/.ejdrone/knowledge/docs/<ns>/<name>.md`（根条目不带 ns 段），
  **不进各工具目录**——16 个工具没有统一的知识落点，镜像 + recall 是唯一不依赖工具私语的形态，登记 §7。
  ledger 照常记账，删除/keep 语义同 1.0：成员改过的镜像副本不覆盖、只点名；ns 失效才删。
- [x] **T8.3 recall 命令**：Create `src/cli/recall.ts` — `ejdrone recall "<query>" [--check] [--json]`。
  无索引全文扫描（15-25 人团队的 docs+learnings 量级在数百文件内，扫描 <100ms，不建索引——
  teamai 的 index v7 / 域乘子 / hotness / vote / 去重键那一整套都是为这个量级以上准备的，登记 §7）。
  打分：标题命中 ×3、frontmatter tags ×2、正文 ×1；输出前 5 条（路径 + 命中片段 ±2 行）。
  `--check` 输出 `RELEVANT score=<n> threshold=<n>` 或 `NOT_RELEVANT ...`，退出码 0/1，不读文件正文之外的事
  （teamai 的 `--check` 同样「不投票、不写日志」，这条语义是 hook/skill 预检用的，必须一致）。
  Test `test/cli/recall.test.ts`（临时 HOME 夹具）。
- [x] **T8.4 内置 skill**：仓库引导提交与 `ejdrone readme` 生成的内容里加一条内置 skill `ejdrone-recall`
  （教 agent：动手前先 `ejdrone recall --check "<任务关键词>"`，RELEVANT 才读文件）。
  它作为普通根 skill 下发，成员可删可改（MR 评审兜底）。teamai 把 `teamai-recall` 设为保留名、永不 push，
  我们沿用：`ejdrone-recall` 与 `ejdrone-share` 两个名字在 push 侧拒绝（防成员把内置 skill 改名推回覆盖团队版）。
- [x] **T8.5 doctor/status**：knowledge 镜像目录存在性、docs 停发点名、镜像与账本一致性（照 mcp 那四项的形）。
- [x] **T8.6 门槛**：typecheck + 全量测试绿；端到端：seed docs 根 + ns → 成员 pull → 镜像存在且 ns 过滤正确 →
  recall 命中根文档、不命中未激活 ns 文档 → `--check` 两种退出码正确 → 成员改过镜像副本后 pull 只点名不覆盖 →
  ns 失效后镜像副本删除。
- [x] **T8.7 真机**：本机跑三次真实 recall（中英文混合 query），人工判读前 5 条可用。试验记录 + 还原。

**回滚**：删 `docs/`（MR）+ 移除镜像目录记账。

### M9 · 经验沉淀（learnings）+ contribute

**目标**：成员把踩坑经验沉淀进团队仓库并全员可检索。主线不依赖任何新 hook。

**二次复核确认的对标事实**：teamai 的 `contribute` **不走 MR**——先写持久队列 `pending-learnings/`，
再 publish 到孤儿分支 `teamai-learnings` 的 worktree，靠「不碰默认分支」换来免评审。它必填 frontmatter
`title/author/date/tags`（tags 2–5），文件名 `<slug>-<YYYY-MM-DD>-<rand6>.md`（rand6 防同人同日撞名），
摩擦分是 interrupt/toolReject/correction 各 ×20 + toolError 梯度、阈值 20 且 toolCount ≥ 15，每会话最多提示一次。
这些我们**有意不照抄**，理由逐条登记 §7：我们的仓库是团队 GitLab、经验入库要走评审（这是本项目存在的理由）。

**任务**：

- [x] **T9.1 learnings 资源**：`learnings/<id>.md`、`learnings/<ns>/<id>.md`，单文件 md + frontmatter
  （`title`、`tags[]`、`date`；缺则由文件名/正文/当天补全，**不因为缺 tags 拒绝入库**）。语义同 docs（并集，无覆盖）。
  镜像到 `~/.ejdrone/knowledge/learnings/`。
  recall 扫描范围 = docs + learnings 镜像 + 当前激活 namespace 的 skills/rules 正文——后者**复用 `core` 的
  `resolve()` 对 checkout 只读跑一遍**取候选集，不在 recall 里重新实现 namespace 过滤。
- [x] **T9.2 contribute 命令**：Create `src/cli/contribute.ts` — `ejdrone contribute --file <path> [--title <t>] [--ns <ns>] [--dry-run]`。
  校验/补全 frontmatter → 生成 `learnings/<YYYY-MM-DD>-<slug>.md`（slug 允许中文，取不到就退回文件名；
  **目标路径已存在就拒绝并提示改名**，不做 rand6）→ 复用 push 管线（分支 + MR）到 `learnings/`。
  `--ns` 多 namespace 角色必给（与 push 同规则）。`--dry-run` 只打印落库后的文件内容与目标路径，不建分支、不开 MR。
  配套内置 skill `ejdrone-share`（教 agent：被反复纠正/工具连续失败时，主动总结成 learning 文件并提示用户跑 contribute；
  skill 里写明「只在用户说『分享给团队』时才真的 contribute」）。
- [x] **T9.3 门槛**：typecheck + 全量测试绿；端到端：contribute → MR → 合入 → 另一成员 pull → recall 命中该 learning →
  `--dry-run` 不落任何 git 副作用。
- [x] **T9.4（stretch）已砍 —— 探测不达线**：先探针——查 claude/codex/qoder-cn 的 Stop 事件与 transcript 可读性
  （`hookEvents` 表已留位）；三选二探得通才做：会话结束按「打断次数 / 工具拒绝 / 同一工具连续失败」计分
  （照 teamai 的量纲：单项 ×20、阈值 20、每会话最多一次），达标打印一行提示。
  探不通或排期超限 → 砍掉，在试验记录里写明探测结论。**砍它不阻塞 M9 验收。**
- [x] **T9.5 真机**：完整走一遍「写 learning → contribute → 模拟评审合入 → 临时 HOME 成员 pull → recall 命中」。
  试验记录 + 逐字节还原。

**回滚**：删 `learnings/`（MR）+ 移除镜像记账。

### M7 / M8 / M9 落地状态（2026-10-12）

三个里程碑的代码与测试全部合入工作树，全量门槛 **`npm run typecheck` 0 错误 + `npm test` 52 文件 / 883 例全绿**
（M6 收尾时是 42 文件 / 725 例）。执行期定下的偏差与遗留项已登记到 §7.2，
逐条证据在 `docs/trials/2026-10-12-m7-m8-m9-verification.md`。

**内容级真机验证（打开 `/agents` 确认 Claude 真的列出投出去的 agent、开 Qoder CN 会话确认 hook 触发）没有做**，
登记的原因不是"忘了"，而是这一轮把投递落在你本机 `~/.claude`、`~/.qoder-cn` 上会与当前会话共用配置文件，
需要单独安排一次带备份的窗口（与 M10 的 Windows 真机遗留项同性质）。目录与文件层面的证据已在夹具里逐字节对拍。

### M10 · Windows 支持

**目标**：Windows（Git for Windows 环境）上全功能可用；macOS/Linux 零回归。

**资源前置（阻塞项，开工前必须就位）**：一台可装 Node ≥ 20 + Git for Windows 的 Windows 机器或 VM。
没有它 M10 不能开工——teamai 的 windows.md 通篇都是「不在真机上跑就发现不了」的坑。

**任务**：

- [x] **T10.1 platform 层**：Create `src/platform.ts` —
  `isWindows`；`findGitBash(env)`（候选：`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`、
  `reg query HKLM\SOFTWARE\GitForWindows /v InstallPath`，全失败返回 null）；`whichWithPathext(name, env)`
  （Windows 匹配 `PATHEXT` 后缀，`uvx` 命中 `uvx.exe`/`uvx.cmd`）；`samePath(a, b)`（Windows 大小写不敏感、
  `\`/`/` 归一）。Test `test/platform.test.ts`：纯函数注入平台参数，不依赖真 Windows。
- [x] **T10.2 hook 命令 Windows 形态**：`cli/constants.ts` 的 `hookCommand()`——win32 时用
  `'<gitbash>' -lc 'EJDRONE_HOOK=1 <node> <cli> pull --silent'`，gitbash 找不到 → `installHook` 返回
  installed:false + reason「需要 Git for Windows」。**裸 `bash` 永远不用**（解析到 WSL 启动器，Node 18 跑不动产物，
  hook 静默崩——teamai windows.md 用一整篇讲这个坑）。
- [x] **T10.3 跨平台自查**：`state.ts`（0600 chmod 已 best-effort ✓）、`lock.ts`（mtime stale ✓）、
  `dirclean.ts`、`hooks.ts`（JSON 读写）、ledger 路径比较改走 `samePath`。逐项过一遍，把 `/` 硬编码替换为 `join`。
- [x] **T10.4 e2e Windows**（2026-10-13 Windows 10 真机：typecheck 0 错误 + 53 文件 / 881 例全绿，10 例为 POSIX 分支语义在 Windows 主机上结构性构造不出来而按主机跳过）：`test/integration/helpers.ts` 在 win32 下的适配（fakeCli 路径、`git` 调用、
  env 键大小写不敏感——Windows 的 env 是大小写不敏感的，`PATH` 可能是 `Path`）。Windows 真机/VM 上
  `npm test` 全绿。
- [x] **T10.5 doctor Windows 检查项**：Git Bash 存在性（FAIL + 安装指引）、hook 命令指向的 bash 路径存在、
  `git` 在 PATH。
- [x] **T10.6 文档**：README 去掉「Windows 未支持」，加「Windows 前置：Git for Windows」；AGENTS.md 同步改。
- [ ] **T10.7 真机（主体完成，2026-10-13）**：Windows 真机 init → pull → doctor 全绿 → uninstall → 逐字节还原全部执行；「重开真实 agent 会话」换成**把安装好的那条 hook 命令真交给六种启动方式跑**，判据从日志增长改成行为（推一条新 skill，hook 跑完它自己回到成员目录）—— 六路全通。剩下的真实会话确认与 `/agents` 同因，登记为环境阻塞（headless `claude -p` 本机零输出）。见 `docs/trials/2026-10-13-windows-real-trial.md` §3/§4/§7.3。
  试验记录 + 逐字节还原（Windows 侧同样按备份还原）。

**回滚**：文档级回退（重新标注不支持）；代码层 platform 分支对 POSIX 无影响。

---

## 5. 全局门槛（每个里程碑都必须过）

1. `npm run typecheck` 0 错误 + `npm test` 全绿（含新增用例）。全量必须跑，不许只跑新增文件——
   1.0 的教训是投递回归只有端到端抓得住。
2. 契约（`types.ts`）变更只在里程碑的「契约前置」任务里发生，由协调者合入；子代理发现契约不够用 → 上报，不就地改。
3. 终审对照 §2：多做的东西（顺手加的 hook 下发、索引、upvote）一律砍掉或移到 2.1 清单。
4. 真机试验记录归档 `docs/trials/`，本机逐字节还原；会话日志不动。
5. 每个里程碑合入后更新本文件 §7（偏差登记）与 README 命令表。

## 6. 风险清单

| 风险 | 应对 |
|---|---|
| 16 工具落点大半靠文档与 teamai 转述，未逐一真机 | PROBE 机制兜底（doctor WARN 点名）；T5.1 禁止猜测填表 |
| §3.3 受管条目合并是全新语义，复杂度集中 | M6 契约前置由协调者本人写；六条规则逐条测试先行；teamai `mcp-reconcile.ts` 164KB 是反面教材，我们的语义只有它的一个子集，超子集的需求一律推迟 |
| Windows 无真机 | M10 资源前置写死，机器不到位就不开工，不用 POSIX 测试冒充 Windows 验证 |
| Stop hook 事件各工具差异大 | M9 主线不依赖它；stretch 探不通就砍 |
| 团队实际用不满 16 个工具 | 名单替换原则（§2）；doctor 只检查用户 init 时选定的工具 |
| 新 kind 让 plan 算法变重 | 裁决语义完全复用 1.0 §7（docs/learnings 去掉覆盖/冲突两条），不加新分支类型 |

## 7. 偏差登记处（执行中持续追加）

| 项 | teamai 做法 | 2.0 做法 | 理由 |
|---|---|---|---|
| agents 源格式 | yaml（新）+ md（旧） | 只收 md + frontmatter | 少一条转换链；md 已覆盖 name/description/tools/model |
| agents 删除 | tombstone 文件 | 走 MR 删文件，pull 移除 | 1.0「仓库是唯一真相源」语义已覆盖；无「仓库没变也要清理」场景 |
| docs/learnings namespace | 覆盖/冲突规则随资源类型不同 | docs/learnings 纯并集，无覆盖无冲突 | 文档互相覆盖没有收益，只有惊讶 |
| 团队知识落点 | 镜像 + 索引 + 工具私有格式 | 只镜像到 `~/.ejdrone/knowledge/` + recall CLI | 16 工具无统一知识落点；索引为更大规模准备，暂不需要 |
| recall | 建索引、run id、upvote 采纳 | 无索引全文扫描 + `--check` 预检 | 数百文件量级扫描足够；upvote 依赖 PostToolUse，2.1 候选 |
| MCP `${VAR}` | 进程环境 + env.yaml + 本地 secrets 库三级 | 只从进程环境解析 | secrets 子系统是 2.1 候选；缺值跳过并点名即可用 |
| MCP 项目级落点 | 支持（含 gitExclude、Codex trust） | 不支持 | 我们无 project scope |
| Windows hook | 逐工具解析各自 shell（WorkBuddy 用自带 PortableGit） | 统一 Git Bash 绝对路径，没有就 installed:false；workbuddy 是否必须走其自带 PortableGit `sh.exe` 列入 M10 真机探测清单 | 统一路径覆盖面最大；workbuddy 的特例先探测再决定要不要开口子 |
| learnings 提示 | Stop hook 摩擦评分自动提示 | 主线 = 内置 skill 教 agent 主动建议；自动提示为 stretch | 见 §2 不做表 |
| 含已解析值的文件权限 | 写入时收紧到 0600 | 同样收紧，但**不回松** | 回松要把原权限记进账本；0600 不会让成员丢访问，反而防同机他人读明文 token。真机卸载后 `~/.claude.json` 仍 0600 是预期 |
| `status` 里的本机私有 server | 不列 | 列在"待推送"并紧跟 `push --mcp` 用法 | 措辞可再议；`push --all` 已明确不含 MCP，改文案要连带动命令面一批用例 |
| 疑似密钥进仓库 | 靠成员自觉 + 评审 | `push --mcp` 自动把 env/headers 里的凭据改写成 `${VAR}`；凭据出现在 command/args/url 时**拒绝入库** | 换掉整条命令会把服务地址一起吞掉，只有作者会拆；静默提交明文是红线 |

### 执行期追加（M5/M6 落地时定下，后续里程碑照此，不要"顺手改回" teamai 的做法）

| 项 | teamai 做法 | 本项目做法 | 理由 |
|---|---|---|---|
| `mcp.yaml` 超时字段 | `timeout` | 只认 `timeout`，内部字段 `timeoutMs` | 两种拼法都收会让"写错的也生效"，文档教不出唯一写法 |
| MCP 文件里的同名条目 | 有 ownership 记录 + 位置证据的复杂认领 | 账本没有、文件里已有 → `foreign-entry` 跳过不覆盖（`--force` 才动） | 我们没有那套 ownership 记录，猜领别人的条目比不投更糟 |
| MCP 落点表结构 | 独立 reconcile 模块（164KB） | `paths.ts` 每行一个 `mcpTarget{format,file,homeFile,pointer}` | 一张表可读；`homeFile` 表达 Claude 的 `~/.claude.json` 不在 `~/.claude/` 下 |
| CodeBuddy MCP | 三个候选文件按"读哪个看先后"搬迁 | 只写首选 `~/.codebuddy/.mcp.json` | 搬迁逻辑是为版本迁移准备的，我们没那个历史包袱；该成员若已有别的文件，doctor 会点名 |
| Codex MCP | 写入后调 `codex app-server` 自动信任 | 不写 trust，pull 末尾提示一次"首次在 codex 内确认" | 自动信任属 project scope 的事，我们只有 user scope |
| `[[` / 内联表 / 不平衡引号的 TOML | 完整 TOML 解析 | 判异形 → 该工具整体跳过 + FAIL 点名 | 宁可不投，也不要在成员手写 TOML 里猜；无 TOML 依赖 |
| JSON 合并 | parse→改→重序列化 | 同样 parse→只动 pointer 那一层→按原缩进/结尾换行重序列化 | 整文件重排不可避免，所以"成员改过没有"只比我方条目的规范化文本 |
| detect | 各工具自己的复杂判定 | 仍然只看根目录存在 | 16 工具后误报面变大，但 `init` 由成员自己勾，不发明新判据 |
| 卸载留下的空目录 | 按 ownership 记录清理 | 只报告不删 | 分不清是谁建的（`~/.trae/rules` 是原生目录），删了就是动成员目录 |
| Windows hook 命令引号形态 | 按平台各自 shell 惯例 | 外层双引号包裹 `"<gitbash>" -lc "..."`，内层保持单引号（计划文本写的单引号外层是有意偏差） | cmd.exe 不认单引号，且 Git Bash 路径常含空格（`C:\Program Files\...`）；内层单引号是 `HOOK_COMMAND_MARKER` 与 `parseHookPaths` 的依赖，改不动 |
| M10 真机验证 | `windows.md` 通篇真机坑 | 代码层 + 注入 platform 单测交付，Windows 真机全量测试与 T10.7 流程登记为遗留项（见 `docs/trials/2026-10-11-m10-trial.md`） | 本环境无 Windows 真机；计划 §6 明示不用 POSIX 测试冒充 Windows 验证 |
| foreign-entry 的 `--force` 口子 | `--force` 才动 | **暂不接**：apply 层不传 force、`pull --force` 显式跳过 merge，输出文案已声明"受管条目投递不受 --force 影响" | 不开"force 覆盖成员条目"的行为（安全红线相邻）；`merge.ts` 的 force 形参保留但永不生效 |

---

## 7.1 M7/M8/M9 前置决策（2026-10-12 源码级复核后冻结，执行 agent 不要再回到 teamai 的做法）

| 项 | teamai 做法（已核实） | 2.0 做法 | 理由 |
|---|---|---|---|
| agents 源格式 | 新格式 `agents/<name>.yaml`（`instructions` 为正文），旧格式 md 只对白名单工具逐字节复制 | 只收 `agents/<name>.md` + frontmatter | 「白名单工具收旧格式、其余收新格式」要维护两份工具名单；md frontmatter 已含 name/description/tools/model |
| agents 无落点的工具 | Trae / Trae CN / Pi / OpenClaw / Hermes / dsh 的落点表里**根本没有 agents 键** | 这 6 个 `agentsSubdir` 缺席 → 不实现 `planAgents`，delivery 按「没有该能力」跳过 | 与 M6 的 `mcpTarget` 同一条原则：能力有无只由 `paths.ts` 决定，代码里不写工具 id 判断 |
| Cursor agent 的 frontmatter 键 | 写成 `agent_id` 而不是 `name` | 本轮按 `md` 原样投，落点表 `probe` 点名「未核」 | Cursor 本机未装、无法内容级验证；现在就照抄一个改名分支，验证不了也无从回归 |
| OpenCode agent | 不写 `name`，强制 `mode: subagent` | 同上，按 `md` 投 + PROBE | 同上 |
| Codex agent 的 tools | **故意不写 tools** | 照抄：`toml` 形态只出 `name/description/developer_instructions/model` | 这是对方实测后的取舍，我们没有理由重新发明 |
| Kiro agent | `json` 里注入 `hooks.agentSpawn`（把 hook 藏在 agent 文件里） | 注入不做，只出 `name/description/prompt/model/tools` | 我们 agents 与 hooks 是两条独立链路；混在一起会让「装了什么 hook」无处可查 |
| agents 删除 | tombstone 文件 `agents/.removed`，pull 时即使仓库无变化也扫全工具删 | 走 MR 删仓库文件，pull 后按 ledger 移除 | 1.0「仓库是唯一真相源」已覆盖；tombstone 是为「本地清理」准备的，我们没有那个场景 |
| docs 回推 | `scanLocalForPush` 返回空、`remove docs` 不支持 | 照抄：镜像目录不是入库来源，仓库 `docs/` 只能直接提交走 MR | 镜像是投递产物，允许回推等于把「成员本地散文件」当团队资产 |
| `team-codebase` | 保留名，声明它的 manifest 加载失败 | 沿用禁用 | 我们现在没有 codebase，禁用是给 2.1 留的免费保险 |
| recall 索引 | `SEARCH_INDEX_VERSION=7` 持久索引 + 域乘子 + hotness + vote + 去重键 | 无索引全文扫描（title ×3 / tags ×2 / 正文 ×1），输出前 5 条 | 数百文件量级；索引那套是为更大规模与采纳统计准备的 |
| learnings frontmatter | `title/author/date/tags` 必填，tags 须 2–5 个，缺则拒绝 | `title/date/tags` 能补则补，**缺 tags 不拒绝** | 硬要求 tags 会让第一次贡献卡在格式上；我们靠 MR 评审补，不靠校验器 |
| learnings 文件名 | `<slug>-<YYYY-MM-DD>-<rand6>.md`（rand6 防同人同日撞名） | `learnings/<YYYY-MM-DD>-<slug>.md`，目标已存在则**拒绝并提示改名** | rand6 是为免 MR 的孤儿分支追加写准备的；我们走 MR，撞名会在评审里现形，文件名里塞随机数只会让引用变难 |
| contribute 落库 | 持久队列 `pending-learnings/` + 孤儿分支 `teamai-learnings` worktree，不碰默认分支 | 复用 1.0 的 push 管线：分支 + MR，人工合入 | 经验入库走评审是这个项目存在的前提；免评审分支等于第二个真相源 |

---

## 7.2 M7/M8/M9 执行期追加（落地时定下，后续改动照此，不要"顺手改回"）

| 项 | teamai / 初稿做法 | 本项目做法 | 理由 |
|---|---|---|---|
| `push` 的采集范围 flag | 初稿里 `--agent <工具 id>` | 改名 `--tool <工具 id>`；`--agent <path\|name>` 从 M7 起专指子 Agent 反向采集 | 一个命令里同一个 flag 两种含义（工具 id / 子 Agent 文件）必然出事；`agent` 已成资源类型名，让位给它，范围用 `--tool`。`init --agent <ids>` 不改（那里说的就是"你在用哪些工具"） |
| 子 Agent 一次 push 混两类资源 | 同一个 MR 里带 | 拒绝：`--agent` 必须单独跑 | 两类互不相干的变更放一个 MR 里，评审看不出彼此影响、回滚也只能一起回 |
| `planAgents` 的告警出口 | 初稿没留 | 契约加可选 `note`（与 `planMcp` 同形），坏 frontmatter「保留原文投递」逐条点名 | 静默降级会被成员理解成"团队下发了但我没拿到"；这条与 §10 的"跳过要能被看见"同源 |
| docs/learnings 的资源名 | 裸文件名 | `Resource.name` = kind 根以下的相对路径去扩展名（`be/db-migrations`），`namespace` 字段同时保留 | `resourceKey` 是 ledger 的记账键；并集语义下同名的根条目与 ns 条目都要投，键相同会让停用后的那份**永远删不掉**（不在 active 集合里的那条被另一条顶活着） |
| 知识镜像的管辖判定 | 初稿没写 | `delivery.ts` 的 `isManaged` 与 `uninstall.ts` 的 `owned` 都并上 `core/knowledge.ts` 的 `isKnowledgePath` | 镜像不在任何工具目录里，适配器 `ownsPath` 天生覆盖不到；漏掉的结果是"停用 ns 后那份文档永久滞留"，而且是**不报错的滞留**。这一条是执行期实测出来的缺陷，哨兵用例在 `test/integration/knowledge.test.ts` |
| 内置 skill 怎么到人手里 | 靠管理员手抄 | `ejdrone readme` 那一份 MR 同时带上仓库还没有的 `skills/ejdrone-*/SKILL.md`；已存在（哪怕被团队改过）就整条跳过不带 | 命令没人被教过就等于没有；覆盖团队改过的版本等于用工具绕过评审。markdown 仍是唯一来源（`scripts/copy-skills.mjs` 在 build 时复制进 `dist/`，不在 TS 里再抄一份） |
| Codex 的 agent `.toml` 反向采集 | 做完整 TOML 解析 | 拒绝并点名原因与出路（照 MCP 侧对 TOML 的同一决定） | 我们只做受控的表块拼接，为了 `push` 再引入一个 TOML 解析器不划算 |
| learning 的分支名 | 用标题 slug | `ejdrone/push-learning-<目标路径短哈希>-` | 中文 slug 进 git ref 名在 Windows 与部分 GitLab 版本上是自找麻烦；分支名是给人看的短串，不需要可读 |
| T9.4 摩擦提示 | 做 | **砍** | 探测结论：`paths.ts` 只有单值 `hookEvent`（全为 SessionStart），`hookEvents` 数组从未落地；Stop 事件的可读 stdin/transcript 在 claude/codex/qoder-cn 三家里 0 家有据（codex 真机没有 hooks.json）。按"三选二才做"的判据不达线，M9 主线（contribute + recall）不依赖它 |
| contribute 与 push 的规则重复 | — | 遗留：命名空间歧义判定与 frontmatter 拆分各有一处复刻（`cli/contribute.ts`、`core/learning.ts`） | 契约层那两个函数是模块私有的，子代理按约定不改别人的文件。收口成一处导出的机会在下一轮做，**在那之前改 push 的 ns 规则必须同步改 contribute** |

---

## 7.3 Windows 真机执行期追加（2026-10-13，`docs/trials/2026-10-13-windows-real-trial.md`）

M10 的资源前置到位后第一次在 Windows 真机上跑，下列结论**覆盖本文更早的相应表述**，后续改动照此。

| 项 | 本文 / AGENTS.md 原写法 | 真机结论 | 理由与实测 |
|---|---|---|---|
| T10.2 hook 命令形态 | `"<gitbash>" -lc "EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent"` | 工具配置里写 `<wrapper 正斜杠裸路径> EJDRONE_HOOK=1`，`bash -lc` 那整串（含内层单引号）搬进 `~/.ejdrone/hooks/session-start.cmd` | 六路实测：旧形态在 cmd 与 Git Bash 通、**PowerShell/pwsh ParserError**（带引号的可执行路径打头必须配 `&`，而 `&` 在 cmd/bash 里是语法符号）——不存在既带引号首 token 又三 shell 通吃的写法。搬进 wrapper 后六路全通，且 `HOOK_COMMAND_MARKER`、`parseHookPaths` 的依赖一个没动（marker 作尾随参数被 batch 当 `%1` 忽略） |
| 用 8.3 短路径消掉引号 | —— | **不可采用** | 本机 `D:\Program Files\Git` 所在卷关闭了短名生成：`D:\PROGRA~1` 不存在，`Scripting.FileSystemObject.ShortPath` 原样返回长路径 |
| 路径含空格（用户名带空格）| 未覆盖 | 唯一可行是 `cmd.exe /c "<wrapper>"`（cmd + PowerShell 通、Git Bash 断，MSYS 把 `/c` 当路径转换），打 `degraded` 标记 + doctor `win:hookbash` WARN | 含空格时无法通吃；宁可口名也不静默 |
| §3.3 规则 6「含已解析值收紧 0600」 | 无条件红线 | **Windows 表达不出来**：NTFS 无组/其他位，`chmodSync` 只能动只读位，实测权限位停在 `0o666`；保护来自 `%USERPROFILE%` 的 NTFS ACL 继承（同机管理员仍读得到明文 token） | 按用户裁定登记为有意偏差，不新增 `icacls` 子系统（它会改成员既有文件 ACL 且不可回松），列为 2.1 候选 |
| 「不用 POSIX 测试冒充 Windows 验证」 | 硬约束 | 反向同样成立：**也不能用 Windows 主机跑 POSIX 分支语义**。10 例（`':'` 切 PATH、`X_OK` 恒真、`join()` 产反斜杠、字面 `c:\…` 假路径）在 Windows 主机上结构性构造不出来，改为主机跳过并写明由哪一侧负责 | 27 例红全部来自这一类与权限位，无一例是投递算法缺陷 |
| Windows e2e 超时 | `testTimeout: 20000` | 按平台抬线：win32 90s / POSIX 保持 20s；临时目录 cleanup 对 ENOTEMPTY/EBUSY/EPERM 重试 | Windows 上 git 子进程慢 2-4 倍，一次 `contribute` 多成员用例撞线；cleanup 撞文件占用 |
| `findGitBash` 的「没装 Git」分支 | 靠「macOS 上 reg 必然失败」制造 null | 注册表读取器改为显式可注入形参；doctor 的 `gitBash` 同理 | Windows 真机上 reg 会命中本机安装，旧写法把要验证的 FAIL 路径整个漏掉 |
| 团队仓库 `.gitattributes`（新增交付物） | 本文从未出现 | `ejdrone readme` 的 MR 与空仓库首笔提交带一份 `* text=auto eol=lf`；仓库已有则不带 | Git for Windows 安装器默认 `core.autocrlf=true` → 仓库存 LF、Windows 成员检出 CRLF → 成员换 OS 后所有投递内容被判「本地已修改」，全员静默收不到更新；codex 的 `.toml` 还会嵌进字面 `\r\n` |
| `submitMrChange` 的 checkout 归属 | 未规定 | 用 `finally` 在任何退出路径把机器克隆还给默认分支（空仓库那一路本就在 targetBranch，不还原） | `createBranch` 切到临时分支而 `fetchReset` 只 `reset --hard` 不改 HEAD；实测 `contribute` 后紧接 `contribute --dry-run` 因「目标路径已存在」被拒 —— 只读命令把未合入内容当团队真相 |
| uninstall 遇到「撤完区块只剩空白」的文件 | 「留成空文件即可」 | **仍然不删**，但新增一行 `留下空白文件 …` 点名 | 真机留下过 0 字节 `.codex/AGENTS.md` 且零提示，成员以为已清干净。不删的理由与同文件「空目录只报告不删」一致（`~/.codex/AGENTS.md` 是工具原生路径，分不清谁建的），且既有钉子用例 `failure.test.ts` 明确钉着「区块文件绝不整文件删除」——尊重它而不是推翻 |

## 附：证据清单（2026-10-11 核对）

- 仓库：`https://github.com/Tencent/teamai-cli`（commit `2cbf556`，5282 stars，TypeScript）
- `README.zh-CN.md` — 工具名单、资产类型清单
- `docs/guide/zh-CN/sharing.md` — env/hooks/MCP 按 namespace 划分、MCP schema 与 16 工具落点表、密钥解析顺序、docs 分发语义
- `docs/guide/zh-CN/advanced.md` — 内置 hooks 矩阵、团队 hooks 声明、Agents 资源类型与逐工具格式、模型别名
- `docs/guide/zh-CN/knowledge.md` — 摩擦评分提示、recall 检索、upvote 采纳机制、各 agent 支持情况表
- `docs/guide/zh-CN/windows.md` — Git Bash 绝对路径、WSL 陷阱、逐工具 shell 解析
- `docs/guide/zh-CN/reference.md` — 命令参考、models 配置
