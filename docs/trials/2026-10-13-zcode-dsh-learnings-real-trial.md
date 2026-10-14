# 2026-10-13 zcode→dsh 经验沉淀真机验证（功能点 5 / M9）

## 目的

GA 后 zcode 适配器已就位、本机新装了 dsh desktop，验证「经验沉淀 + contribute」（2.0 功能点 5）
的完整真机链路：**zcode 成员贡献经验 → PR 评审合入 → pull → dsh 成员侧 recall 检索复用**。
夹具级跨工具用例（`test/integration/cross-tool-learnings.test.ts`）先行验证后已按使用者要求移除，
本记录是真机形态的替代证据。

## 本机起点

- `~/.ejdrone` 为活跃 demo 状态（MCP 真机试验后留下）：repo =
  `https://github.com/example/teamai-demo.git`（私有，provider=git），
  角色 shoot，原工具 zcode+qoder-cn，qoder-cn 带 SessionStart hook。
- `~/.dsh` 为 **dsh desktop 真实安装**，但目录形态与落点表 PROBE 假设不同：
  实际只有 `.agent-presets`、`.credentials.yaml`、`channel-pack`、`openai-gateway`、
  `our-free-model`、`profiles`、`sessions`、`settings.yaml.imported`、`storages`、`wb-market`，
  **没有 `skills/`、`AGENTS.md`、`hooks.json`**（这三个都是本次投递新建的）。
  `dsh` CLI 是 profile 启动器形态（`--profile`/`--dump-config`），`--dump-config` 的 profile 树里
  没有 skills/agents/hooks 相关引用。

## 执行链路（全部真实副作用）

1. 备份：config.yaml 复制 + `~/.dsh` 既有文件清单存档至
   `%LOCALAPPDATA%\Temp\ejdrone-f5-trial-backup-20261013\`（dsh 侧无既有文件会被改动，
   投递目标三个文件原本都不存在，属纯增量）。
2. `node dist/cli.js init <repo> --agent zcode,qoder-cn,dsh --role shoot --force`
   （保留既有 qoder-cn，只增 dsh）：config 更新；dsh 三件套落盘——
   `~/.dsh/skills/photo-shoot-organizer/SKILL.md`、`~/.dsh/AGENTS.md` 团队区块（仅含标记内内容）、
   `~/.dsh/hooks.json`（SessionStart → session-start.cmd wrapper 形态）。首轮投递 6 文件 / 3 工具。
3. `contribute --file <zcode-技能热加载坑笔记>`：分支
   `ejdrone/contribute-learning-766d7d25-20261013T083530Z` 推到 GitHub，
   目标 `learnings/shoot/2026-10-13-zcode-技能热加载坑.md`（provider=git 给手动开 MR 指引）。
4. gh 建 PR #5 并合入（模拟评审）。
5. `pull`：镜像出现 `~/.ejdrone/knowledge/learnings/shoot/2026-10-13-zcode-技能热加载坑.md`，
   投递 1 文件、无删除。
6. dsh 成员侧检索（recall 与工具无关，dsh 里的 agent 跑的就是同一条命令）：
   - `recall --check "zcode 技能 热加载"` → `RELEVANT score=16 threshold=2`，退出码 0；
   - `recall "热加载"` → 命中镜像绝对路径 + 片段（score=6），退出码 0。
7. `doctor`：17 PASS / 3 WARN / 0 FAIL。WARN 均为已知设计性提示
   （zcode 无 hook 落点、zcode+dsh 无 MCP 落点、qoder-cn+dsh 落点 PROBE）。

## 结论

- **经验沉淀跨工具复用成立**：learning 的产生（zcode 语境）、存储（团队仓库 learnings/shoot/）、
  消费（知识镜像 + recall）三端均不绑工具，dsh 侧检索两种形态全部命中，退出码语义正确。
- **dsh 落点表的 tool-read 侧仍为 PROBE**：投递字节级已核（三个文件都是我们建的、内容正确），
  但 dsh desktop 是否读取 `~/.dsh/skills`、`AGENTS.md`、`hooks.json` 没有证据——真机安装的
  desktop 版默认目录里原本没有这三者，profile 树也无引用。确认方式是打开 desktop 应用目视
  技能列表（人工步骤，约两分钟）。paths.ts 的 dsh probe 文案应据此更新：本机已安装 dsh desktop，
  但落点仍待内容级核实。

## 留下的常态与退场

- 本机保持「已加入」状态：工具 zcode+qoder-cn+dsh、角色 shoot、知识镜像 1 份、PR #5 已合入。
- 回滚：`node dist/cli.js uninstall` + 删除投递新建的 `~/.dsh/skills`、`~/.dsh/AGENTS.md`、
  `~/.dsh/hooks.json`（三者试验前均不存在，见备份目录里的 `dsh-files-before.txt` 清单），
  config 从备份目录还原。

## 人工验证结果（2026-10-13 16:55 前后，dsh desktop 真实会话，截图留档）

使用者在 dsh desktop 会话里实测，四项结论：

1. **agent 级复用通过**：dsh 的 agent 运行 `ejdrone recall "热加载"`，命中并准确引用了该
   learning（标题/结论/三步排查/根因全部引用正确）。功能点 5 的 dsh 侧复用在 agent 层闭环。
2. **dsh 技能落点销 PROBE（内容级）**：会话可用技能列表里出现 `photo-shoot-organizer`
   （投自 `~/.dsh/skills/`）——dsh desktop 真的读该目录。这是 M5 以来 dsh skills 落点的
   第一份内容级证据。
3. **SessionStart hook 未触发（负面证据，一轮会话）**：会话启动（≈16:46，第一轮问答耗时
   8m47s、截图消息 16:55）时远端 main 已有 hook-probe（addb614，16:45 推送）；若 hook 生效，
   启动时应有一次完整 pull。实际：账本 mtime 停在 16:36、hook-probe 未投递、debug.log 不存在
   ——`~/.dsh/hooks.json` 未被 dsh desktop 触发。与其原生目录里本就没有 hooks.json 的观察一致。
4. **附带发现（副作用）**：dsh agent 在环境分析时用裸 git 推进了共享 checkout
   （reflog 16:58:57 `reset: moving to origin/main` → addb614，无投递、无账本写入——不是
   `ejdrone pull` 的完整行为）。checkout 领先账本的漂移用一次正规 pull 修正（pull 是快照式，
   无损坏），hook-probe 随之投递到三个工具。教训：别让 agent 直接进 `~/.ejdrone/repo` 玩 git。
5. **AGENTS.md 团队区块销 PROBE（内容级，17:10 会话）**：使用者问「团队校验口令是什么」，
   dsh agent 14 秒答出锚点 `DEMO-TRIAL-20261011-A7` 并明确引用来源
   `~/.dsh/AGENTS.md` 的 ejdrone 团队规则。口令不可猜测，且应答无探索动作（规则已在上下文），
   判为 dsh 读取 AGENTS.md 团队区块的内容级证据。

**未竟项**：demo 仓库缺 `ejdrone-recall`/`ejdrone-share` 内置技能（`ejdrone readme` 未跑过），dsh agent
不知道 recall 的存在，第一轮「查团队知识」盲搜工作区 8 分 47 秒——点名 `ejdrone` 后立即会用。
修法：`ejdrone readme` 走 MR 提交内置技能，合入后 pull 即生效（dsh 已证读技能目录）。

**paths.ts 的 dsh probe 应据此更新**：skills 落点与 AGENTS.md rules 区块均内容级已核
（2026-10-13 dsh desktop 会话，技能列表 + 口令锚点两项证据）；hooks.json 落点维持待核并补记
一轮负面证据（SessionStart 未触发）。

## 收尾（2026-10-13 晚，两项跟进均完成）

1. **内置技能入库并下发**：`ejdrone readme` 就地更新未合并分支 `ejdrone/readme-20261011T090837Z`
   （.gitattributes + README + ejdrone-recall/ejdrone-share），[PR #6](https://github.com/example/teamai-demo/pull/6)
   合入后 pull 下发 6 文件到 3 工具。`~/.dsh/skills/` 现有四项：ejdrone-recall、ejdrone-share、
   hook-probe、photo-shoot-organizer。dsh 已证读技能目录，其 agent 从此有「动手前先 recall」的
   教程，8 分 47 秒盲搜问题根治。注意：dsh 技能列表是会话启动定格的，需重开会话才看到新技能。
2. **paths.ts 的 dsh probe 已改写**（本工作树，未提交）：按上文结论标注 skills/rules 内容级已核、
   hook 未核对带负面证据；文案含「未核对」字样，`doctor` 的 probe WARN 继续点名 dsh（行为核对过）。
   验收：`npm run typecheck` 0 错误 + 全量测试 54 文件 / 915 例绿（10 例为登记过的 Windows 主机跳过项）。

当天 GitHub 网络间歇抖动（fetch/gh API 多次 Connection reset / TLS 超时），readme、PR、pull
均以重试完成，非工具缺陷。
