# 2026-10-12 · M7/M8/M9 验证记录（子 Agent 下发 · 团队知识 · 经验沉淀）

对应父计划 `docs/superpowers/plans/2026-10-11-ejdrone-skills-2.0.md` §4 的 M7/M8/M9 与
§5 的全局门槛。执行子计划是 `2026-10-12-m7-m8-m9-execution.md`。
与 M5/M6 那两份记录不同，这一轮**没有对你本机做投递试验**，原因写在最后一节，不是漏做。

## 1. 门槛结果（原样命令与输出）

```
$ npm run typecheck     # tsc --noEmit
0 错误

$ npm test
Test Files  52 passed (52)
     Tests  883 passed (883)

$ npm run build         # tsc -p tsconfig.json && node scripts/copy-skills.mjs
[copy-skills] skills/** -> dist/skills/**
dist/cli.js
dist/skills: ejdrone-recall  ejdrone-share
```

M6 收尾时的基线是 42 文件 / 725 例。这一轮净增 10 个测试文件、158 例。
`dist/` 已 gitignore，`package.json` 的 `build` 多了一步 `copy-skills`（把内置技能的 markdown
复制进 `dist/skills/`，`npm` 只发布 `dist`，所以这一步是必须的；脚本用 `node:fs cpSync`，
Windows 上没有 `cp -r` 也能跑）。

## 2. §2 三项验收形态的逐条证据

| 项 | 验收形态 | 证据 |
|---|---|---|
| 3 子 Agent 下发 | `agents/` → 各工具原生目录 | `test/integration/agents.test.ts` 11 例：pull 后 claude 收到逐字节 `.md`、codex 收到 `.toml` 且**没有 tools 键**；未订阅 `be` 的角色收不到 ns agent、切回又拿到；二次 pull 零写入幂等；成员改过那份只点名不覆盖；uninstall 无残留；`trae`（表里没有 agents 落点）不被凭空造出 `agents/` 目录；doctor PASS→WARN；`remove agents` 根与 ns 同名时拒绝并列出两处路径；`push --agent` 三条（采新 agent 入库 / 多工具同名不同内容拒绝并要求 `--tool` / TOML 落点不做反向解析）。转换只在 `src/agents/agentfmt.ts`，`test/agents/agentfmt.test.ts` 17 例覆盖四种形态 + 往返不丢字段 + 「正文字节不变」 |
| 4 团队知识 | `docs/` 镜像 + `ejdrone recall` | `test/integration/knowledge.test.ts` 15 例：镜像路径 `~/.ejdrone/knowledge/docs/<ns>/<name>.md` 且**一处都不进工具目录**；账本按 `docs:be/db-migrations` 记账（name 带 ns 段）；同名根文档与 ns 文档并集共存；成员改过镜像副本 → 保留 + 点名；**停用 namespace 后那份镜像被删除**；`team-codebase` 保留名整目录跳过并告警；`recall` 命中激活 ns、不命中未激活；`--check` 两种退出码且只给判定不给正文；`--json` 给绝对路径；没 pull 过的机器提示 + 退出码 0；`doctor` 的 `knowledge:mirror` 三态；最后两例走 `member.run(['recall', …])` 验 CLI 注册本身。打分纯函数在 `src/core/recall.ts`，`test/core/recall.test.ts` 24 例（title×3/tags×2/正文×1 严格拉开顺序、同词只计一次、CJK 子串、符号链接一律不跟随、两个镜像根都扫） |
| 5 经验沉淀 | `learnings/` + `ejdrone contribute` | `test/integration/learnings.test.ts` 7 例：contribute → 远端分支 → `mergeIntoMain` → 第二个成员 pull → `~/.ejdrone/knowledge/learnings/2026-10-12-kafka-积压处理复盘.md` 出现 → `recall --check` 输出 `RELEVANT score=12`；`--ns` 入库只给订阅该 ns 的角色；`--dry-run` 远端分支集合与 main sha 逐字不变、不落锁；目标路径已存在 → 拒绝并提示改名，输出里**没有随机后缀**；缺 tags 不拒绝、入库点名让评审补；再加两例走 `member.run(['contribute', …])` 验 CLI 接线。形态与命名的纯函数在 `src/core/learning.ts`（16 例） |

内置技能这一条单独说：`ejdrone-recall` / `ejdrone-share` 的 markdown 是这个仓库里的文件，
`ejdrone readme` 那一份 MR 会带上「团队仓库还没有的」那几份（已有的路径整条跳过，被团队改过的也不覆盖），
合入后作为普通根技能投递。`push --skill` 对这两个名字是保留名，拒绝（`test/integration/readme.test.ts` 5 例，
其中一例专门验「成员本地那份 pull 下来的内置技能，push 仍然被拒且仓库那份一字未动」）。

## 3. 执行期修掉的一个真缺陷

`isManaged` 只并了适配器的 `ownsPath`，而知识镜像根 `~/.ejdrone/knowledge/` 不在任何工具目录里，
于是 `apply.ts` 的删除分支对镜像文件一路跳过 —— 表现是**不报错的滞留**：
停用 namespace 后那份文档永远删不掉，账本条目也留着。
owner B 用一条 skip 的用例把这个缺口指出来（这正是它当时测出的失败：`expected true to be false`），
修法是 `core/knowledge.ts` 新增 `isKnowledgePath`，`delivery.ts` 与 `uninstall.ts` 两处判据各并上它。
那条用例现在实跑并通过，它同时是这一缺陷的哨兵。

顺带补了两处「让降级可见」：`planAgents` 加了与 `planMcp` 同形的可选 `note`（坏 frontmatter 按原文投递时点名），
`push` 的采集范围 flag 从 `--agent` 改名 `--tool`（`agent` 从 M7 起是资源类型名，同一个命令里一个 flag 两义必然出事）。

## 4. 没有做的事，以及为什么

1. **内容级真机验证**（打开 Claude Code 的 `/agents` 确认它真把投进去的 agent 列出来、开 Qoder CN 会话
   确认 hook 触发、人工判读三次 recall 的前 5 条）。本轮的验证全部走夹具：伪造 `HOME` + `EJDRONE_HOME`，
   逐字节对拍落点内容。没在你本机做投递，是因为这一轮要同时动 `~/.claude/agents`、`~/.qoder-cn/settings.json`
   （那还是你当前会话在用的配置文件），需要单独安排一次带备份的窗口，不适合和三个子代理并行改树的时候做。
   目录层面的旁证已取：本机 `~/.claude/agents` 存在且里面是工具自家的 subagent `.md`，frontmatter 形状与我们
   投的一致；`~/.codex` 下没有 `agents/`（表里该格按 teamai 文档置 toml 落点，标 PROBE）。
2. **T9.4 Stop hook 摩擦提示** —— 按约定砍掉。探测结论：`paths.ts` 只有单值 `hookEvent`（全部 SessionStart），
   初稿预留的 `hookEvents` 数组从未落地；Stop 事件的 stdin/transcript 在 claude/codex/qoder-cn 三家里 0 家有据
   （codex 真机没有 `hooks.json`）。判据是"三选二才做"，不达线。M9 主线不依赖它。
3. **两处规则复刻**（`contribute` 复刻了 push 的 namespace 歧义判定、`learning.ts` 复刻了 frontmatter 拆分）——
   登记在父计划 §7.2 最后一行。被复刻的那两个函数是模块私有的，按执行子计划的约定子代理不改别人的文件。
   收口成一处导出是下一轮的活；在那之前，改 push 的 ns 规则必须同步改 contribute。

## 5. 下一件事

- 你点头后安排一次真机窗口：`init → pull → 打开 /agents 与 recall → doctor → 按备份逐字节还原`。
- Windows 那一栏（§2 第 6 项）仍是「代码层已交、真机未跑」，见 `2026-10-11-m10-trial.md`。
- 本轮改动已落在 `release/2.0-preview` 分支（tag `v2.0.0-preview.0`）；内容级真机窗口仍是欠账，见 §4.1。
