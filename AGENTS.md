# ejdrone-skills

把团队 skills/rules 放进一个 Git 仓库，按角色裁剪后投递到各 AI 工具的用户级目录（只有 user scope，不建服务端）。
使用者视角的一切（安装、命令表、投递矩阵、安全边界）在 `README.md`；设计取舍与理由在
`docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md`。本文件只写改代码前需要知道的事。

## 命令（在仓库根目录执行；POSIX 在 macOS 上真机验证过，Linux 只有测试与夹具，Windows 为代码层就绪、真机未验）

| 目的 | 命令 |
|---|---|
| 装依赖 | `npm install` |
| 类型检查 | `npm run typecheck` |
| 全量测试 | `npm test` |
| 单个测试文件 | `npx vitest run test/core/plan.test.ts` |
| 构建 | `npm run build`（产出 `dist/cli.js`，`dist/` 已 gitignore） |
| 源码直跑 CLI | `npm run dev -- --help` |

- 前置：Node.js ≥ 20、本机 `git` 可用。集成用例用真实 `git init --bare` 起 origin，不许 mock。
- **`npm run typecheck` 不覆盖 `test/`**（tsconfig 的 exclude 里有 test），测试文件的类型错误只有 vitest 跑到才暴露。改了测试就必须 `npm test`。
- 验收线 = `npm run typecheck` + `npm test` 全绿。碰 `src/core/` 或 `src/agents/` 必须跑全量：端到端用例比单测更容易暴露投递回归。
- 版本号只有一个来源：`package.json`。`cli.ts` 从清单读它，`src/` 里再出现字面量版本就是第二个源，发版后必报旧号
  （`test/cli/version.test.ts` 守这条）。发版用 `npm version <x> --no-git-tag-version`，`package-lock.json` 一起提交。

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
- Windows 平台判断一律调用 `src/platform.ts` 的四个函数（`isWindows` / `findGitBash` / `whichWithPathext` /
  `samePath`），各处不得自己实现平台逻辑——薄委派允许（如 `mcpfmt.whichOn` 直接转发），重复实现不允许。
- hook 命令的 Windows 形态是 `"<gitbash>" -lc "EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent"`：外层双引号
  （cmd.exe 不认单引号，且 bash 路径常含空格），**内层单引号不许改**（`HOOK_COMMAND_MARKER` 识别与
  `parseHookPaths` 都依赖它）；找不到 Git Bash 时 `hookCommand` 返回 null，`init` 降级为提示，不抛错。
  裸 `bash` 永远不用（解析到 WSL 启动器，hook 静默崩）。
- 路径相等比较走 `samePath`（Windows 大小写不敏感、`\`/`/` 等价），不许直接 `===`——已收口两处：
  `core/ledger.ts` 的 `ledgerEntry` 与 `cli/doctor.ts` 的 hook cli 归属核对；新增路径比较照此办理。
- 所有原子写统一走 `ledger.ts` 导出的 `replaceFileSync`（共四处：`state.ts` saveConfig / `hooks.ts`
  atomicWrite / `ledger.ts` saveLedger / `core/apply.ts` atomicWriteWithMode；`cli/uninstall.ts` 的
  `replaceFileAtomic` 是"保权限 + replaceFileSync"的卸载侧变体）：win32 先删已存在目标再 rename
  （规避 rename 覆盖不可靠），POSIX 行为不变。
- doctor 的 `win:*` 三条检查（`win:gitbash` / `win:git` / `win:hookbash`）仅 win32 出现，POSIX 的
  `doctor --json` 输出一个字符都不许变。

## 代码形态

- CLI 一律经 `runCli(argv, ctx)`：返回退出码，绝不调用 `process.exit`，也不在模块级绑定 `process.env` ——
  端到端测试靠这两条才能在同一个进程里跑多个成员。
- 适配器与状态层函数显式接收 `home: string, env: NodeJS.ProcessEnv`，不在函数外读 `process.env.HOME` / `homedir()`。
- 2.0 有 16 个适配器，公共行为全在 `src/agents/common.ts`；适配器文件只做「声明 id + 组装」，
  **不许出现 rulesMode / hook 的 if 判断** —— rules 的四种模式（rulesdir / mdc / block / none）在
  `planRulesFor` 里按表分派一处，模式实现分别在 `rulesdir.ts`、`mdc.ts`、`block.ts`。
- 新增一个工具 = 在 `paths.ts` 填一行表 + 建 `src/agents/<id>.ts` + 在 `index.ts` 按表顺序注册 +
  `test/agents/<id>.test.ts` 里 `describeAdapter(<id>Adapter)` 拿公共六项、再补该工具的特例。
  `adapters.test.ts` 的 tripwire 会拦住忘记注册的情况。
- 投递矩阵不手写：`src/cli/team-readme.ts` 从 `TOOL_PATHS` 生成，改表即改文档，防止两处漂移。
- block 模式两个坑（注释在 `types.ts`，改 `core/apply.ts` 或 `cli/delivery.ts` 前先读）：适配器要把自己的合成 key
  `rules:team-rules-block` 放进 `activeResources`，否则每次 pull 误删区块；某 kind 停发时看 `Resolution.haltedKinds`
  整体跳过，因为空 writes 在 block 模式等于"清空区块"。
- MCP 走**条目级合并**（`PlannedWrite.merge` + `LedgerEntry.managedKeys`）：落点是成员在用的共享配置文件，
  所以这类路径**永不进 unlink 分支**，"被本地改过"只比我们自己那几个条目（JSON 用键排序后的规范化文本，
  格式化抖动不算改过；TOML 按表块原文逐字节）。卸载时用 `managedKeys` 反向合并 `desired={}` 只撤自己那几条。
- 把 `${VAR}` 解析成明文写进成员文件时，该文件必须收紧到 0600：判据由 planMcp 标在 `merge.hasResolvedValue` 上，
  **不要让 apply 猜内容像不像密钥**（猜会把不含密钥的文件也改权限）。权限只收紧不回松。
- `mcp/mcp.yaml` 解析不出来 = MCP 整体停发，**不是空集**：当成空集会把全员已装的 server 全删掉。
  判定在 `snapshot.mcpFileError`，`buildDelivery` 据此把 `mcp` 加进 `haltedKinds`，pull 退出码 1。
- 工具有没有某项能力由 `paths.ts` 的表决定（`mcpTarget` 缺席 → 适配器不实现 `planMcp`），
  **不要在适配器或渲染层按工具 id 写 if**。分派需要区分形态时把形态加进表（`mcpTarget.style`），别在代码里猜。
- 新增 `ResourceKind` 只改三处：`types.ts` 的联合与 `RESOURCE_KINDS`、`plan.ts` 的 `KIND_ROOT` 表、
  采集入口。`KindSet = Record<ResourceKind, Resource[]>` 是全总映射，漏一处直接编译失败 ——
  别再引入 kind 白名单（`delivery.ts` 原来那句 `if (kind !== 'skills' && kind !== 'rules') continue`
  会让新 kind 的"冲突停发"变成"全员删除"）。
- 2.0 M7-M9 起有六个 kind，`plan.ts` 里除 `KIND_ROOT` 还多三张全总映射表：`KIND_SEMANTICS`
  （docs/learnings = `union`，不替换也不判冲突）、`KIND_ENTRY_EXT`、`KIND_QUALIFIED_NAME`。
  **docs/learnings 的 `Resource.name` 含 namespace 段**（`be/db-migrations`），因为 `resourceKey` 是 ledger
  的记账键并集两半都要唯一；把它改回裸名字会让"停用 ns 后删掉那份文档"永久失效。仓库路径一律经
  `plan.ts` 的 `repoPathFor(resource)`，不要在命令层再拼 `kind === 'skills' ? … : …`。
- 知识镜像根 `~/.ejdrone/knowledge/` 必须同时出现在 `delivery.ts` 的 `isManaged` 和 `uninstall.ts` 的 `owned`
  里（判据是 `core/knowledge.ts` 的 `isKnowledgePath`）。它不在任何工具目录下，适配器 `ownsPath` 天生覆盖不到，
  少接一处 `apply.ts` 的删除分支就一路跳过 —— 表现是"文件与账本永久滞留"，不是报错，测试里以
  `test/integration/knowledge.test.ts` 的「停用 namespace 后那份镜像副本被删除」为哨兵。
- 子 Agent 的能力有无同样只由 `paths.ts` 的 `agentsSubdir`/`agentsFormat` 决定（无落点的 6 个工具不实现
  `planAgents`），四种形态的转换只在 `agents/agentfmt.ts` 一处，公共投递只在 `common.ts` 的 `planAgentsFor`，
  适配器与投递层都不许按工具 id 分支。`planAgents` 带 `note` 通道：坏 frontmatter「保留原文投递」必须点名。
- `push` 的采集范围 flag 是 `--tool <工具 id>`（不再是 `--agent`）；`--agent <path|name>` 从 M7 起指子 Agent
  的反向采集，且它单独走一个 MR，与 `--skill/--rule/--mcp/--all` 混用时直接拒绝。`init --agent <ids>`
  仍是"选工具"，那个位置不改。内置 skill 名单在 `cli/constants.ts` 的 `BUILTIN_SKILL_NAMES`，
  `push` 侧按名字拒绝（改这两份内容只能在团队仓库里改并走 MR）。
