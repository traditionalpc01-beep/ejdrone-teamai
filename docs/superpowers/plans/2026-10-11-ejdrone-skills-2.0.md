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

### 对标物核对结果（Tencent/teamai-cli，2026-10-11 核对，commit `2cbf556`）

| 维度 | teamai-cli 实际做法 | 出处 |
|---|---|---|
| 支持工具 | 19 个 id + 变体：claude(tclaude/claude-internal)、codex(tcodex/codex-internal)、cursor、copilot、codebuddy、workbuddy、opencode、pi、openclaw、hermes、dsh、qoder、qoder-cn、kiro、trae、trae-cn、zcode、omp、joycode | `README.zh-CN.md` |
| 资产类型 | skills、rules、docs、env、hooks、mcp、models、agents、learnings、codebase、teamwiki | `README.zh-CN.md`、`docs/guide/zh-CN/sharing.md` |
| MCP | `mcp/mcp.yaml` + `mcp/<ns>/mcp.yaml`；server 字段 `name/description/transport(stdio\|http\|sse)/url/headers/timeout/command/args/env/requires/tools`；按工具原生格式写入（Claude 系 `mcpServers` JSON、Codex `config.toml`、Copilot `type: local/remote`、OpenCode `mcp` 键）；`${VAR}` 解析成明文落盘、文件收紧 0600、含 token 的项目级文件自动进 `.git/info/exclude` | `sharing.md` §MCP Server |
| 子 Agent | `agents/` 目录，每 agent 一个 `*.yaml` 或旧格式 `*.md`；投递时按文件名拍平到各工具 `agents/` 目录；Codex 写 `<name>.toml`、Kiro 写 `<name>.json`、Copilot 写 `<name>.agent.md`、其余写 `<name>.md`；namespace 语义与 rules 相同 | `docs/guide/zh-CN/advanced.md` §Agents 资源类型 |
| 团队知识 | `docs/` 目录整体镜像分发；recall 建索引检索 learnings + docs + rules + skills | `sharing.md` §Docs、`knowledge.md` |
| 经验沉淀 | Stop hook 按摩擦信号（打断/纠正 AI、拒绝工具、反复重试）评分，达标提示 `/teamai share`；learnings 存团队仓库；`teamai recall "query"` 检索；24h 内打开命中文档算采纳并 upvote | `docs/guide/zh-CN/knowledge.md` |
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

- [ ] **T5.1 冻结落点矩阵**：16 工具 × 5 能力格，逐格填路径/格式 + `已核实|PROBE` 标记。
  依据 teamai `sharing.md` §MCP 落点表与 `advanced.md` §Hooks，结合各工具官方文档；填不出的一律 PROBE，禁止猜。
  交付：`paths.ts` 表 + 注释。
- [ ] **T5.2 适配器组 A**（`codebuddy`、`workbuddy`、`copilot`、`kiro`）：
  Create `src/agents/codebuddy.ts`、`workbuddy.ts`、`copilot.ts`、`kiro.ts`；Test `test/agents/adapters.test.ts` 扩展。
  已知锚点：copilot 根目录读 `COPILOT_HOME`（绝对路径才生效，同 `DSH_HOME` 规则）；kiro 的 SessionStart 不以文件 hook 存在
  （teamai 以 agent 同步内嵌）→ `installHook` 允许返回 `{ installed: false, reason }`，doctor 据 reason 显示。
- [ ] **T5.3 适配器组 B**（`opencode`、`pi`、`openclaw`、`hermes`）：
  同上。锚点：opencode 根在 `~/.config/opencode/`；openclaw 只有 SessionStart+UserPromptSubmit 且 hook 是 workspace 级
  （user scope 下按「无可用 hook」处理，installed:false）；hermes 只有 SessionStart。
- [ ] **T5.4 适配器组 C**（`qoder`、`trae`、`trae-cn`）：
  同上。锚点：trae/trae-cn 无用户级 MCP 落点（仅项目级）→ mcpTarget 缺席；hook 落点全部 PROBE。
- [ ] **T5.5 注册与 doctor**：`src/agents/index.ts` 注册 16 个；`doctor` 逐工具检查 detect/hook/落点，PROBE 项 WARN。
- [ ] **T5.6 门槛**：`npm run typecheck` + `npm test` 全绿；新增适配器每个至少 3 个单测（detect / planSkills+planRules / ownsPath）。
- [ ] **T5.7 真机**：本机已装的工具（claude、qoder-cn、codex）回归投递幂等；未安装工具用临时目录伪造根目录验证 detect
  不误报。试验记录 + 逐字节还原。

**回滚**：适配器是纯增量，摘除 `index.ts` 注册即回到 1.0 行为。

### M6 · MCP 下发

**目标**：`mcp/mcp.yaml` + namespace 文件 → 各工具原生 MCP 配置，受管条目合并不动用户条目。

**契约前置**：§3.1 `McpServerDef`、§3.2 裁决扩展、§3.3 合并语义合入 `types.ts`（协调者本人做）。

**任务**：

- [ ] **T6.1 解析器**：Create `src/core/mcp.ts` — 解析 `mcp/mcp.yaml` 与 `mcp/<ns>/mcp.yaml`（zod strict；
  未知 key 报错入 warnings；`servers:` 顶层 key 缺失 = 文件级失败 → mcp 停发）。Test `test/core/mcp.test.ts`：
  合法/坏 YAML/未知 key/缺 servers key/ns 覆盖/双 ns 同名冲突。
- [ ] **T6.2 `${VAR}` 解析**：同一文件内。只从 `env` 参数（进程环境）取值；取不到 → 该 server 跳过并点名
  （interactive 打印 + `mcp list` 标 missing；silent 写 debug.log）。已解析值不进任何输出。Test 覆盖。
- [ ] **T6.3 裁决接入**：`core/plan.ts` + `core/resources.ts` 按 §3.2 接 mcp；`resolve()` 输出 mcp 候选集。
- [ ] **T6.4 合并投递**：`core/apply.ts` 实现 §3.3 六条规则；`core/ledger.ts` 读写 `managedKeys`。
  Test `test/core/apply.test.ts`：六条规则各至少一例，外加「合并中途任何一步失败不留半写文件」。
- [ ] **T6.5 适配器 `planMcp`**（可与 T6.4 并行，依赖契约）：`AgentAdapter` 新增 `planMcp(servers, home, env): PlannedWrite[]`。
  四种格式 writer 收口在 `src/agents/mcpfmt.ts`（json-mcpServers / toml-codex / json-opencode / json-copilot），
  适配器只查表调用；`mcpTarget` 缺席的工具返回空数组。`tools:` 字段过滤在 planMcp 入口统一做。
  codex 跳过 `sse`（其不支持）并 warning。`requires` 探测在此做（Windows PATHEXT 由 T10.1 的 platform 层兜底，
  M6 先做 POSIX `PATH` 查找并留接口）。
- [ ] **T6.6 命令**：`push --mcp <name>`（从本机某工具配置里反向采集一个 server 入仓库，走 MR）、
  `remove mcp <name...>`、`list mcp`、`status` 计入 mcp；doctor 加「mcp 文件可解析 / 受管条目与账本一致」检查。
- [ ] **T6.7 门槛**：typecheck + 全量测试绿；端到端用例（`test/integration/`）：仓库声明 stdio+http 两个 server →
  成员 pull → 断言 claude/codex/cursor 三工具配置文件条目正确、用户自有条目原样、二次 pull 幂等、
  停用 ns 后条目移除且用户条目不动。
- [ ] **T6.8 真机**：本机 claude + qoder-cn 实际注入一个 `npx -y` 型 stdio server 与一个不存在的 url 型 http server，
  开工具确认前者出现、后者跳过点名；`doctor` 无 FAIL。试验记录 + 逐字节还原。

**回滚**：`mcp/` 目录从团队仓库删除（MR），pull 后各工具受管条目移除（规则 3），用户条目不动。

### M7 · 子 Agent 下发

**目标**：`agents/` 目录资源 → 各工具 agents 目录，逐工具格式转换。

**契约前置**：§3.1（agents 为目录型资源）、§3.4 `agentsSubdir`/`agentsFormat`（随 M5 落点矩阵已就位）。

**任务**：

- [ ] **T7.1 解析器**：`core/resources.ts` 扩展 agents：仓库 `agents/<name>.md`、`agents/<ns>/<name>.md`；
  只收 md（teamai 的新格式 yaml 不收——多一种源格式就多一条转换链，md frontmatter 已够用，登记 §7）；
  frontmatter 缺 `name`/`description` 时自动补全（沿用 1.0 补全逻辑与「坏 YAML 保留原文 + 告警」）。
  Test 覆盖：根/ns/缺 frontmatter/坏 YAML/同名冲突。
- [ ] **T7.2 裁决接入**：同 T6.3，按 §3.2。
- [ ] **T7.3 格式转换器**：Create `src/agents/agentfmt.ts` — 输入统一 frontmatter+正文，输出四种
  （`md` 原样 / `agent-md` Copilot 形态 / `toml` Codex 形态 / `json` Kiro 形态）。
  转换字段表照 teamai `advanced.md` §Agents 矩阵抄并标 PROBE。Test：四种格式各一例 + 往返不丢字段。
- [ ] **T7.4 适配器 `planAgents`**：`AgentAdapter` 新增；`agentsSubdir` 缺席返回空。
  拍平投递（ns 目录拍平成 `<name>.<ext>`），同名冲突由裁决层已拦。
- [ ] **T7.5 命令**：`push --agent <path>`、`remove agents <name...>`（带 ns 写 `<ns>/<name>`，多位置同名拒绝并列出，
  照 teamai 语义）、`list agents`。`remove` 走 MR 删仓库文件即可——1.0 的「合入后 pull 移除」语义不变，
  不需要 teamai 的 tombstone（我们没有「仓库没变也要清理」的场景，登记 §7）。
- [ ] **T7.6 门槛**：typecheck + 全量测试绿；端到端：根 agent + ns agent → 成员 pull → claude（md）与 codex（toml）
  落点内容正确 → 切角色后 ns agent 移除、根 agent 保留。
- [ ] **T7.7 真机**：claude 真机投递一个 agent，开 `/agents` 确认可见可用。试验记录 + 逐字节还原。

**回滚**：删 `agents/` 目录（MR），pull 后移除。

### M8 · 团队知识（docs）+ recall

**目标**：`docs/` 按角色裁剪镜像到本地；`ejdrone recall` 一条命令检索知识。

**任务**：

- [ ] **T8.1 docs 资源**：docs 为单文件 md 资源（`docs/**.md`，`docs/<ns>/` 为 namespace 子树）。
  与 rules 的差异：**无覆盖语义**——ns 子树是独立集合，不替换根文件（teamai 同，避免「同名文档互相盖」）。
  `resolve()` 对 docs 跳过覆盖/冲突两条规则，只做并集。`team-codebase` 保留名禁用（teamai 教训）。
- [ ] **T8.2 镜像投递**：投递到 `~/.ejdrone/knowledge/docs/`（不进各工具目录——16 个工具没有统一的知识落点，
  镜像 + recall 是唯一不依赖工具私语的形态，登记 §7）。ledger 照常记账，删除/keep 语义同 1.0。
- [ ] **T8.3 recall 命令**：Create `src/cli/recall.ts` — `ejdrone recall "<query>" [--check] [--json]`。
  无索引全文扫描（15-25 人团队的 docs+learnings 量级在数百文件内，ripgrep 式扫描 <100ms，不建索引——
  teamai 的索引/格式版本/缩减保护那一整套都是为这个量级以上准备的，登记 §7）。
  打分：标题命中 ×3、frontmatter tags ×2、正文 ×1；输出前 5 条（路径 + 命中片段 ±2 行）。
  `--check` 输出 `RELEVANT score=<n> threshold=<n>` 或 `NOT_RELEVANT ...`，退出码 0/1，不读文件正文。
  Test `test/cli/recall.test.ts`（临时 HOME 夹具）。
- [ ] **T8.4 内置 skill**：仓库引导提交与 `ejdrone readme` 生成的内容里加一条内置 skill `ejdrone-recall`
  （教 agent：动手前先 `ejdrone recall --check "<任务关键词>"`，RELEVANT 才读文件）。
  它作为普通根 skill 下发，成员可删可改（MR 评审兜底）。
- [ ] **T8.5 门槛**：typecheck + 全量测试绿；端到端：seed docs 根 + ns → 成员 pull → 镜像存在且 ns 过滤正确 →
  recall 命中根文档、不命中未激活 ns 文档 → `--check` 两种退出码正确。
- [ ] **T8.6 真机**：本机跑三次真实 recall（中英文混合 query），人工判读前 5 条可用。试验记录 + 还原。

**回滚**：删 `docs/`（MR）+ 移除镜像目录记账。

### M9 · 经验沉淀（learnings）+ contribute

**目标**：成员把踩坑经验沉淀进团队仓库并全员可检索。主线不依赖任何新 hook。

**任务**：

- [ ] **T9.1 learnings 资源**：`learnings/<id>.md`、`learnings/<ns>/<id>.md`，单文件 md + frontmatter
  （`title`、`tags[]`、`created`；缺则补全）。语义同 docs（并集，无覆盖）。镜像到 `~/.ejdrone/knowledge/learnings/`。
  recall 扫描范围 = docs + learnings 镜像 + 当前激活 namespace 的 skills/rules 正文——后者**复用 `core` 的
  `resolve()` 对 checkout 只读跑一遍**取候选集，不在 recall 里重新实现 namespace 过滤。
- [ ] **T9.2 contribute 命令**：Create `src/cli/contribute.ts` — `ejdrone contribute --file <session.md> [--ns <ns>]`。
  校验/补全 frontmatter → 复用 push 管线（分支 + MR）到 `learnings/`。`--ns` 多 namespace 角色必给（与 push 同规则）。
  配套内置 skill `ejdrone-share`（教 agent：被反复纠正/工具连续失败时，主动总结成 learning 文件并提示用户跑 contribute；
  是否提示由用户决定，skill 里写明「只在用户说『分享给团队』时才真的 contribute」）。
- [ ] **T9.3 门槛**：typecheck + 全量测试绿；端到端：contribute → MR → 合入 → 另一成员 pull → recall 命中该 learning。
- [ ] **T9.4（stretch，可砍）Stop hook 摩擦提示**：先探针——查 claude/codex/qoder-cn 的 Stop 事件与 transcript 可读性
  （`hookEvents` 表已留位）；三选二探得通才做：会话结束按「打断次数 / 工具拒绝 / 同一工具连续失败」计分，
  达标打印一行提示（每会话最多一次）。探不通或排期超限 → 砍掉，在试验记录里写明探测结论。**砍它不阻塞 M9 验收。**
- [ ] **T9.5 真机**：完整走一遍「写 learning → contribute → 模拟评审合入 → 临时 HOME 成员 pull → recall 命中」。
  试验记录 + 逐字节还原。

**回滚**：删 `learnings/`（MR）+ 移除镜像记账。

### M10 · Windows 支持

**目标**：Windows（Git for Windows 环境）上全功能可用；macOS/Linux 零回归。

**资源前置（阻塞项，开工前必须就位）**：一台可装 Node ≥ 20 + Git for Windows 的 Windows 机器或 VM。
没有它 M10 不能开工——teamai 的 windows.md 通篇都是「不在真机上跑就发现不了」的坑。

**任务**：

- [ ] **T10.1 platform 层**：Create `src/platform.ts` —
  `isWindows`；`findGitBash(env)`（候选：`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`、
  `reg query HKLM\SOFTWARE\GitForWindows /v InstallPath`，全失败返回 null）；`whichWithPathext(name, env)`
  （Windows 匹配 `PATHEXT` 后缀，`uvx` 命中 `uvx.exe`/`uvx.cmd`）；`samePath(a, b)`（Windows 大小写不敏感、
  `\`/`/` 归一）。Test `test/platform.test.ts`：纯函数注入平台参数，不依赖真 Windows。
- [ ] **T10.2 hook 命令 Windows 形态**：`cli/constants.ts` 的 `hookCommand()`——win32 时用
  `'<gitbash>' -lc 'EJDRONE_HOOK=1 <node> <cli> pull --silent'`，gitbash 找不到 → `installHook` 返回
  installed:false + reason「需要 Git for Windows」。**裸 `bash` 永远不用**（解析到 WSL 启动器，Node 18 跑不动产物，
  hook 静默崩——teamai windows.md 用一整篇讲这个坑）。
- [ ] **T10.3 跨平台自查**：`state.ts`（0600 chmod 已 best-effort ✓）、`lock.ts`（mtime stale ✓）、
  `dirclean.ts`、`hooks.ts`（JSON 读写）、ledger 路径比较改走 `samePath`。逐项过一遍，把 `/` 硬编码替换为 `join`。
- [ ] **T10.4 e2e Windows**：`test/integration/helpers.ts` 在 win32 下的适配（fakeCli 路径、`git` 调用、
  env 键大小写不敏感——Windows 的 env 是大小写不敏感的，`PATH` 可能是 `Path`）。Windows 真机/VM 上
  `npm test` 全绿。
- [ ] **T10.5 doctor Windows 检查项**：Git Bash 存在性（FAIL + 安装指引）、hook 命令指向的 bash 路径存在、
  `git` 在 PATH。
- [ ] **T10.6 文档**：README 去掉「Windows 未支持」，加「Windows 前置：Git for Windows」；AGENTS.md 同步改。
- [ ] **T10.7 真机**：Windows 机器上 init → pull → 重开 agent 会话验证 hook 自动 pull → doctor 全绿 →
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

---

## 附：证据清单（2026-10-11 核对）

- 仓库：`https://github.com/Tencent/teamai-cli`（commit `2cbf556`，5282 stars，TypeScript）
- `README.zh-CN.md` — 工具名单、资产类型清单
- `docs/guide/zh-CN/sharing.md` — env/hooks/MCP 按 namespace 划分、MCP schema 与 16 工具落点表、密钥解析顺序、docs 分发语义
- `docs/guide/zh-CN/advanced.md` — 内置 hooks 矩阵、团队 hooks 声明、Agents 资源类型与逐工具格式、模型别名
- `docs/guide/zh-CN/knowledge.md` — 摩擦评分提示、recall 检索、upvote 采纳机制、各 agent 支持情况表
- `docs/guide/zh-CN/windows.md` — Git Bash 绝对路径、WSL 陷阱、逐工具 shell 解析
- `docs/guide/zh-CN/reference.md` — 命令参考、models 配置
