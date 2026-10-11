# ejdrone-skills

把团队 skills/rules 放进一个 Git 仓库，按角色裁剪后投递到各 AI 工具的用户级目录（只有 user scope，不建服务端）。
使用者视角的一切（安装、命令表、投递矩阵、安全边界）在 `README.md`；设计取舍与理由在
`docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md`。本文件只写改代码前需要知道的事。

## 命令（在仓库根目录执行，仅支持 macOS / Linux）

| 目的 | 命令 |
|---|---|
| 装依赖 | `npm install` |
| 类型检查 | `npm run typecheck` |
| 全量测试 | `npm test` |
| 单个测试文件 | `npx vitest run test/core/plan.test.ts` |
| 构建 | `npm run build`（产出 `dist/cli.js`，`dist/` 已 gitignore） |
| 源码直跑 CLI | `npm run dev -- --help` |

- 前置：Node.js ≥ 20、本机 `git` 可用。集成用例用真实 `git init --bare` 起 origin，不许 mock。
- 验收线 = `npm run typecheck` + `npm test` 全绿。碰 `src/core/` 或 `src/agents/` 必须跑全量：端到端用例比单测更容易暴露投递回归。

## 硬规则

- `src/core/types.ts` 是冻结契约。要改签名先讨论，不要就地改。
- 设计文档 §14「与本文初稿的偏差」列出的行为都是**有意的**（`remove` 只删仓库不删本地、冲突停发时仍把已记账资源标为
  active、hook 命令用绝对路径加 `EJDRONE_HOOK=1` 前缀、`DSH_HOME` 只接受绝对路径……）。看着别扭也别改回去，理由在 §14。
- §10 安全红线：不在 ledger 里的文件视为用户的，绝不删；本地改过的投递文件不覆盖，只点名；`AGENTS.md`
  区块标记外的内容一律不动；GitLab token 只从 `EJDRONE_GITLAB_TOKEN`（回落 `GL_TOKEN`）读，不落盘、不回显；
  写入路径限制在落点表目录内；SKILL.md / rule 里不写密钥。
- 工具落点只在 `src/agents/paths.ts` 一张表里定义，工具改目录约定只改这张表。其中 `probe` 字段是尚未真机核实的
  猜测，别当成已确认事实写进代码或文档。
- pull 与提交 MR 期间必须持 `src/cli/lock.ts` 的 `sync.lock`：checkout 和 `ledger.json` 是跨会话共享状态，
  交错写 ledger 会让先记的账丢失，那些文件此后再也更新不进去。
- 验证改动不要用真实 HOME：走 `test/integration/helpers.ts` 夹具（伪造 `HOME` + `EJDRONE_HOME`，成员间隔离）。
  确需真机试验，按 `docs/trials/2026-10-11-ejdrone-demo-trial.md` §6 回滚，逐字节还原。

## 代码形态

- CLI 一律经 `runCli(argv, ctx)`：返回退出码，绝不调用 `process.exit`，也不在模块级绑定 `process.env` ——
  端到端测试靠这两条才能在同一个进程里跑多个成员。
- 适配器与状态层函数显式接收 `home: string, env: NodeJS.ProcessEnv`，不在函数外读 `process.env.HOME` / `homedir()`。
- rules 的三种落点分走 `src/agents/rulesdir.ts`、`mdc.ts`、`block.ts` 三个 helper，不要在单个适配器里塞 if-else。
- block 模式两个坑（注释在 `types.ts`，改 `core/apply.ts` 或 `cli/delivery.ts` 前先读）：适配器要把自己的合成 key
  `rules:team-rules-block` 放进 `activeResources`，否则每次 pull 误删区块；某 kind 停发时看 `Resolution.haltedKinds`
  整体跳过，因为空 writes 在 block 模式等于"清空区块"。
