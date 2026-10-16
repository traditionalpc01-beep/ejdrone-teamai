# 设计文档（2.1）：tags 标签订阅

- 日期：2026-10-14
- 状态：已批准（随 2.1.0 发布）
- 前置：`2026-10-11-ejdrone-teamai-design.md`（下称「1.0 设计」）
- 对标：[Tencent/teamai-cli](https://github.com/Tencent/teamai-cli) 的标签订阅（usage-guide「标签订阅」节）

## 0. 决策 reversal：为什么把 1.0 砍掉的 tags 加回来

1.0 设计 §1 非目标表曾列「tags 标签订阅 | 角色 + 多角色已覆盖，两套机制会互相绕」。该判断在
2026-10-14 的真实使用中被推翻：

- 团队出现「**角色子集共用**」需求——开发与运维都要用 ssh-connect 与云效 MCP。namespace 模型只有两个
  表达：①共用角色的订阅集里加上对方的 namespace（连坐：对方今后放入的**独占**内容全量到达）；
  ②为每个角色子集建 namespace（并集爆炸：dev∩ops、dev∩qa∩ops……每个子集一个目录）。
- 两条路都在 15-25 人规模内就劣化（①在第二个运维专属 skill 入库那天失效），说明缺口不是规模问题，
  是**粒度**问题：namespace 是「内容组」，角色订阅是组级开关，缺一个条目级的加法豁免。

结论：tags 以**条目级、只做加法**的形态回归——

1. **不与角色机制互绕**：tags 只能把**非活跃 namespace 里的具体条目**加进候选，不改变
   「ns 整体替换根」「双 ns 同名冲突停发」的方向性语义；根条目照旧全员下发，标签写了也无效但无害。
2. **一套机制覆盖全部 6 类资源**：文件类（skills/rules/agents/docs/learnings）统一走 frontmatter
   `tags:`，MCP 条目走 `tags:` 字段。teamai-cli 在 MCP 上另设逐条 `roles:` 字段，我们不做——
   两个跨 namespace 机制才是 1.0 担心的「互相绕」。

## 1. 语义

### 声明（仓库侧）

```markdown
<!-- skills/my-skill/SKILL.md / rules/*.md / agents/*.md / docs/*.md / learnings/*.md 的 frontmatter -->
---
name: my-deploy-helper
description: …
tags: [deploy, ops-tools]
---
```

```yaml
# mcp/mcp.yaml 或 mcp/<ns>/mcp.yaml 的条目
servers:
  - name: yunxiao
    transport: stdio
    # …
    tags: [ops-tools]      # 与 tools:/requires: 同类：纯下发过滤器，不进成员配置
```

- 标签名复用 namespace 的命名规则（`isValidResourceName`：小写字母开头，小写字母/数字/`-`/`_`，
  ≤120）。
- 坏形状（非字符串数组）：采集层**忽略标签并点名**（`Snapshot.warnings`），push 时也提前点名——
  静默吞掉会把「订阅了却不生效」伪装成「没人打标」。
- `completeFrontmatter` 本就保留未知键，push 不会抹掉成员写好的 tags。

### 订阅（成员侧）

- `~/.ejdrone/config.yaml` 新增 `subscribedTags: string[]`（2.0 的 config 缺该键 = 空订阅，
  schema `.default([])` 兼容）。不进 init 向导，用命令维护：
  - `ejdrone tags list`：仓库标签（来源与条数）+ 本地订阅；订阅了但仓库无人使用的点名。
  - `ejdrone tags subscribe <tags...>`（空格/逗号分隔，并集）：未知标签允许写入但提示（对齐
    roles set 对未知角色的姿态——管理员可能还没推内容）。
  - `ejdrone tags unsubscribe <tags...>`（差集）。
- 管理员侧：`ejdrone tags add/remove <kind> <名字> <tags...>` 改仓库 frontmatter / mcp 条目并开 MR
  （branchPrefix `ejdrone/tags-<op>-<kind>-<name>-`）；同名条目多份（根 + ns）必须 `--ns`
  指定（根条目 `--ns root`），不许猜。无实际变化报「无需提交」，不开空 MR。

### 下发规则

候选 = 根条目 ∪（namespace ∈ 角色激活集）∪（tags ∩ 订阅集 ≠ ∅）。裁决在
`core/plan.ts` 的 `isResourceActive` 谓词收口，`resolveKind` / `list` / `doctor` 三处共用。

- 同名裁决继承既有语义，零特判：tag 激活的 ns 条目与角色激活的另一 ns 条目同名 → 冲突停发该 kind；
  与根条目同名 → ns 整体替换根（标签是「点名要那份 ns 的专门版」的自然表达）。
- 退订 → active 集缩小 → 走既有删除链路（apply 的 `activeResources` 判定），无需新机制。
- MCP：`tags` 与 `tools`/`requires` 同为纯过滤器，不进渲染后的成员条目文本；反向采集
  （push --mcp）的 keep 列表包含 tags，重新 push 不抹团队的标签。

### 可见性

- `ejdrone list`：ns 条目因标签命中时标注 `本次会下发（tag:x）`；带标条目行尾加 `tags=...`。
- `ejdrone doctor`：新增 `tags:unknown` WARN（订阅的标签仓库无人使用），tag 参与的同名冲突
  自然进入既有 `roles:conflict`。
- pull 的 notes：订阅未生效的标签点名。

## 2. 契约变更（types.ts，全部 additive）

| 字段 | 位置 | 说明 |
|---|---|---|
| `Resource.tags?: string[]` | 采集层填 | 文件类来自 frontmatter；mcp 由条目字段提升 |
| `McpServerDef.tags?: string[]` | 条目 schema | 纯过滤器 |
| `Config.subscribedTags: string[]` | 本地订阅 | schema default([]) 保 2.0 兼容 |
| `ResolveInput.activeTags?: string[]` | 裁决输入 | 缺省 = 无豁免，行为与 2.0 逐字节相同 |

不改任何既有签名；`resolve()` 对不带 activeTags 的调用与 2.0 完全一致（既有单测即回归线）。

## 3. 与 1.0 设计的偏差登记（对应该文档 §14 的惯例）

| # | 偏差 | 理由 |
|---|---|---|
| 1 | 非目标「tags 标签订阅」推翻 | §0：角色子集共用是粒度缺口，非规模问题 |
| 2 | tags 覆盖全部 6 类（teamai 仅 skills/rules，MCP 另用 roles: 字段） | 一套机制优于两套；见 §0 第 2 条 |
| 3 | 管理员 `tags add/remove` 命令 | 与「一切入库变更走 MR」一致，frontmatter 定位/改写由工具代劳 |
