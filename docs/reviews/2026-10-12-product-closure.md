# ejdrone-skills《产品闭环评估》报告

> 评审人：许清楚（产品经理）· 日期：2026-10-12 · 任务：用户要求评审的第一部分（产品闭环）
> 被评版本：仓库当前工作树（未提交态：17 个修改 + 5 个新增 = 1.0 上线态 + M5/M6/M10 代码层），`commit 7ffc33a` 之后的 M10 Windows 代码层改动
> 范围声明：**只评当前已实现功能是否形成完整闭环**。M7（子 Agent）、M8（docs + recall）、M9（learnings）是后续里程碑、本就没有，**不计入缺口**。本文所有"缺口"均指已实现功能内部的不完整、不一致或静默失败
> 依据：README.md / AGENTS.md / 设计文档 §7 §9 §10 §14 / 2.0 计划 §2 §3.3 §7 / docs/trials 三份真机记录 / src 全量走查 / test/integration 十个文件
> 质量基线采信协调者已验证数据（typecheck 0 错误、vitest 704/704、build 成功、doctor macOS 9 项零 win: 前缀）；本报告为只读评审，未重跑全量（评审期间另跑 `npm run typecheck` 复核通过）

---

## ① 闭环总矩阵（旅程 × 状态 × 结果）

以 README 命令表为骨架的七步旅程。结论先行：**七步全部有入口、有出口、有反馈，未发现"用户会卡住且没有指引"的硬断点**；问题集中在两类软断点——"静默"（坏了不说）与"误导"（说了但不对），见 ④⑤。

| # | 旅程步骤 | 入口前提 | 代码实际行为（src/cli/） | 成功出口 | 失败/降级出口 | 用户可见反馈 | 断点判定 |
|---|---|---|---|---|---|---|---|
| ① | 管理员建团队仓库 | Git 托管空仓库 + 全员 write 权限 | `init.ts:147 initCommand` → `snapshot.ts:32 openSnapshot`（空仓库 `fetchReset` 返回 `head:''`，`git/repo.ts:152-158`）→ 选工具/角色 → `saveConfig` → 装 hook → 首次 pull | config 落盘（0600）、hook 装上、首次投递完成 | 仓库不可达 → err + 下一步；已有 config → 提示 `--force` | `已写入 config…`、逐工具 hook 结果、`已投递 N 个文件` | 无断点。空仓库 README 不在 init 时生成，而在第一笔 MR 式变更（`roles add`/`push`/`readme`）时由 `mr.ts:74,86-90` bootstrap 分支自动带上——与 README"空仓库的第一笔提交会自带一份 README.md"表述一致 |
| ② | 成员 init（交互/非交互） | 团队仓库地址 | 交互：`choose` 勾工具（detect 预选）、选角色（唯一角色预选）；非交互：`--agent/--role`；`init.ts:45-125` | config + hook + 首次 pull | 未探测到工具且无 `--agent` → err + 下一步；未知工具 id → err + 列出全部可选；`--provider` 非法 → err；角色不在 manifest → 提示仍写入（pull 时告警） | 探测结果、config 摘要、hook 逐工具结果、首次 pull 摘要 | 无断点。非交互模式下"探测到即全选"是有意行为（`已探测到并选用`），成员可用 `--agent` 收紧 |
| ③ | hook 安装与会话启动自动 pull | init 完成 | `constants.ts:22-33 hookCommand`：绝对路径 node + cli + `EJDRONE_HOOK=1` 前缀；win32 为 `"<gitbash>" -lc "…"` 外层双引号形态；`pull.ts:176-180` silent 恒 0 | 每次开会话自动同步 | 无 hook 落点的 7 个工具（trae/trae-cn/opencode/copilot/pi/openclaw/hermes/kiro）→ `installed:false` + reason，doctor `hook:<id>` WARN"请手动定期运行 ejdrone pull"；win32 无 Git Bash → 全不装 + 逐工具安装指引（`init.ts:127-145`），手动 pull 不受影响 | hook 装上/未装原因逐工具打印 | 无断点。遗留：hook 装了 ≠ 工具会执行（PROBE 状态，doctor PASS 只证明条目在文件里）——真机阻塞类，m5-trial §4 已登记 |
| ④ | 成员日常分享（push → MR → 合入） | 本地写好 skill/rule/mcp | `push.ts:355 pushCommand`：采集（`--skill/--rule/--mcp/--all`/交互勾选）→ namespace 裁决（`--role` 经 manifest 映射、多 ns 必须 `--ns`、无角色推根，`push.ts:203-245`）→ frontmatter 自动补全 → 分支（同名资源复用未合并分支，`mr.ts:75-80`）→ `prePushScan`（空实现扩展点）→ commit → push → MR | 分支 + MR（gitlab 自动；generic 手动指引）；重复 push 就地更新 | token 缺失 → 分支已推 + "设置 EJDRONE_GITLAB_TOKEN 后重跑"指引（`gitlab.ts:96`）；HTTP 错误 → token 抹除后指引；空仓库 → bootstrap 首笔直接落 main + README；锁竞争 → err + 锁路径 | `待推送：` 清单、分支名、MR 链接或手动指引、`合入后其他成员下次会话自动拿到` | 无断点。评审合入是人工环节（产品定位：复用现有 MR 流） |
| ⑤ | 队友收到更新 | MR 合入 | 会话启动 hook `pull --silent`；或手动 `ejdrone pull` | 新条目落地、团队删除的条目被清、幂等 | 离线 → fatal + 下一步（`list --source local` 确实可离线用，`list.ts:43-64` 先扫后连）；坏 manifest → 全量停发 + 退出码 1 + 指到文件，修好自动恢复（failure.test.ts 四例） | `已投递 N…删除 N…保留 N`、保留逐条点名、冲突/停发文案 + 下一步 | 无断点 |
| ⑥ | 角色切换（roles set） | 已知角色 id | `roles.ts:84 rolesSet`：只改本地 config（primary/additional），不触发投递 | config 更新 + 提示跑 pull | 未知角色 → 提示仍写入；非法 id → err + 下一步 | `已更新本地角色…下一步：运行 ejdrone pull` | 无断点（有明确下一步；不 pull 则旧内容残留是有意语义，本地 config 与投递分离） |
| ⑦ | 退出（uninstall --force） | 已初始化 | `uninstall.ts:39`：交互确认或 `--force`（非交互无 `--force` 拒绝）；遍历全注册表撤 hook（只处理真有我们条目的，`uninstall.ts:62-74`）；删记账且哈希匹配的文件；区块未改过则撤、改过则保留点名；MCP 按 `managedKeys` 反向合并只撤自己条目；config 保留 | hook 清理、投递文件删除、区块撤除、账本收窄 | hook 清理失败 → 保留并给"下一步"（但指向错误路径，见 F3）；空目录只报告不删 | `清理完成：删除 N…撤掉 N 处团队区块`、保留逐条点名、空目录报告、config 保留路径与 `npm uninstall` 说明 | 无断点。想彻底清状态需手动 `rm -rf ~/.ejdrone`（输出有说明，m5/m6-trial 回滚节验证过逐字节还原） |

**旅程 × 测试背书映射**（test/integration/ 十个文件）：

| 旅程 | 直接背书的用例 |
|---|---|
| ① 建仓库 | demo-trial 真机（空仓库 init → roles add bootstrap，缺陷 1 修复后）；failure.test.ts `roles add 改写 manifest 并开分支`；lifecycle `init：装上 hook…` |
| ② 成员 init | interactive.test.ts 两条（勾选/不设角色）；lifecycle `非交互且没有安装任何工具`；all-tools 16 工具一次 init |
| ③ hook + 自动 pull | lifecycle `装上 claude/codex 的 hook，重复 init 也只留一条`；all-tools `16 个工具的 hook 条目各归各文件`；review-fixes `hook 失效要能被看见` 两条；真机：m5-trial 步骤 6（重启会话技能出现，qoder-cn 内容级证据） |
| ④ push → 合入 | lifecycle `作者 push，评审合入后另一个成员…` / `同一资源再次 push 就地更新` / `没有角色时推到仓库根目录`；mcp-commands `push --mcp` 9 例；failure `push 在 generic provider 下`；真机：demo-trial（GitHub generic 路径） |
| ⑤ 队友收到更新 | lifecycle `status 报出待推送与落后` / `团队删除` / `manifest 写坏` 四例 / `仓库不可达`；mcp.test.ts 共存 8 例 |
| ⑥ 角色切换 | lifecycle `be → fe 后…`；mcp.test.ts `停用 be 角色后只有 be 那条被撤走` |
| ⑦ 卸载 | failure.test.ts uninstall 6 例（改过保留/用户 hook 文件/空目录/区块撤除/只剩区块留空文件/改过区块保留）；interactive `uninstall 二次确认被拒`；真机：m5/m6-trial 卸载后逐字节还原 |

---

## ② 场景覆盖核对表

逐项核对这些场景在代码里的实际处理与反馈。"结论"列：闭环 = 有处理有反馈；静默缺口 = 有处理但用户看不到；误导 = 有反馈但内容不对。

| # | 场景 | 代码位置 | 实际处理 | 用户可见反馈 | 测试背书 | 结论 |
|---|---|---|---|---|---|---|
| 1 | 16 工具 detect | `agents/common.ts:57 detectTool`（根目录存在判定） | init 交互预选/非交互选用探测到的；doctor `agent:<id>` 根目录不存在 WARN | `已探测到并选用` / doctor WARN + 重选指引 | all-tools、test/agents 表驱动套件 | 闭环（detect 误报如 `~/.pi` 因别的软件存在，由 init 人工勾选缓解，m5-trial §4 登记） |
| 2 | PROBE 机制 | `agents/paths.ts probe 字段` + `doctor.ts:34-38 probeUnverified` | 未核对落点在 doctor 汇成一条 `probe` WARN，只报选定工具，其余折成 note | WARN + 逐工具 probe 文案；note 一行带过 | doctor.test.ts；m5-trial §5 | 闭环 |
| 3 | skills 根 + namespace | `core/plan.ts:36-76 resolveKind` | 候选 = 根 ∪ 激活 ns；同名 ns 整体替换根 | `list` 标注 `根条目` / `namespace=` / 本次是否下发 | plan.test.ts、lifecycle、all-tools | 闭环 |
| 4 | rules 根 + namespace（四种模式） | `plan.ts` 同 3 + `common.ts:78-105 planRulesFor` 按表分派 rulesdir/mdc/block/none | 同 3；none 模式不写任何文件 | 落点即反馈；`list` 同 3 | all-tools 按 rulesMode 逐模式断言 | 闭环 |
| 5 | mcp 根 + namespace | `core/mcp.ts:161-205 collectMcp` | ns 目录只认 manifest 声明的；同名 ns 替换根；未声明 ns 点名跳过 | `list mcp` 标注 + 停发说明 | mcp.test.ts、mcp-commands | 闭环 |
| 6 | 双 namespace 同名冲突停发 | `plan.ts:61-66`（conflicted → haltedKinds）+ `delivery.ts:117-128 activeResourcesWithConflictHold` | 该 kind 整体停发、已记账资源标 active 保已装；其他 kind 不受影响 | `冲突：…` + `该类型本次停发（已装内容保留）` + 下一步；退出码 1 | lifecycle `两个订阅角色定义同名条目`；mcp.test.ts `mcp 整体停发`；review-fixes `停发 ≠ 清空区块` | 闭环 |
| 7 | 多角色订阅 | `state.ts configSchema`（primary + additional）+ `plan.ts:106-126 activeNamespaces` | 角色 id 并集映射 namespaces | `status`/`roles list` 显示主/附加 | lifecycle `--add fe` | 闭环 |
| 8 | gitlab provider | `git/provider.ts` + `git/gitlab.ts` | 自动开 MR；token 只从 `EJDRONE_GITLAB_TOKEN`/`GL_TOKEN` 读、错误里 maskToken | MR 链接；token 缺失 → 分支已推 + 重跑指引；HTTP 错 → 状态码 + 手动链接，**token 不回显** | failure `generic provider 输出里没有 token 字样`（哨兵断言）；gitlab 单测 mock | 闭环 |
| 9 | git（generic）provider | `git/generic.ts` + `mr.ts:126-133` | 只推分支 + 打印手动 MR 指引，绝不报成 push 失败 | `已推送分支…` + 手动指引 + 合入后 pull 验证 | failure.test.ts；真机 demo-trial（GitHub） | 闭环 |
| 10 | 交互 init | `init.ts:69-74,111-124` + `context.ts:73-87 choose` | 勾工具（detect 预选）、选角色（唯一角色预选）、可多选附加角色 | 菜单 + `[已选]` 标记 | interactive.test.ts 两条 | 闭环 |
| 11 | 非交互 init | `init.ts:47-67,93-109` | `--agent/--role` 跳过交互；都没有 → 报错不猜 | `已探测到并选用` / err + 下一步 | lifecycle、failure | 闭环 |
| 12 | `--silent` hook 模式 | `pull.ts:74-93,176-180` | 正常进度丢弃；问题只进 `~/.ejdrone/debug.log`；恒返回 0 | 正常时无任何输出、不写日志；有问题时写 debug.log | failure `--silent 恒返回 0` / `一切正常时不写 debug.log` | 闭环（取舍评估见 ④） |
| 13 | `--force` | `pull.ts:29-53 forceOverwrite` | 只覆盖 ledger 记账过的整文件；region/merge 显式排除；未记账同名文件是用户的，不删 | `--force：即将覆盖 N 个本地改过的文件（区块与受管条目投递不受 --force 影响…）` | review-fixes `--force 不越界` 两条；lifecycle `pull --force 覆盖` | 闭环。遗留：merge 的 `force` 口子未接（F6） |
| 14 | 仓库离线（快照回落） | `snapshot.ts:32-56` + `doctor.ts:194-217` | pull：fatal + 下一步（已装内容不变，下次重试）；doctor：repo WARN + `readExistingSnapshot` 回落本地快照并提示"可能不是最新"；`list --source local` 离线可用 | err + 下一步 / WARN + 提示 | failure `仓库不可达`；doctor 单测 | 闭环 |
| 15 | 坏 manifest/roles.yaml | `core/manifest.ts` zod + `pull.ts:114-119` + `doctor.ts:221-227` | 全量停发、已装不动、退出码 1；doctor FAIL 指到文件与出错位置；修好自动恢复 | `角色 manifest 无法解析，本次全量停发…` + 下一步 | failure.test.ts 四例（含 --json） | 闭环 |
| 16 | 坏 mcp.yaml（整体停发） | `core/mcp.ts:87-155 parseMcpFile` 文件级失败 + `delivery.ts:77-80` | 文件级失败 → mcp 全 kind 停发，**不当成空集**（避免清空全员已装）；退出码 1 | pull/list/status/doctor 四处都说清 + 指向 `mcp/mcp.yaml` | mcp.test.ts `mcp.yaml 写坏`；mcp-commands `list mcp 直接失败`；doctor 四项用例 | 闭环 |
| 17 | 用户改过投递文件（保留 + 点名） | `core/apply.ts:286-302`（modified-locally / foreign-file 分流） | 不覆盖，进 kept 逐条点名，退出码 1 | `保留 <path>（<resource>：本地已修改 / 非本工具投递的文件）` | lifecycle `手改已投递的 skill`；failure silent 版 | 闭环 |
| 18 | 缺 `${VAR}` | `core/mcp.ts:223-234 resolveVars` + `common.ts:133-136` | 整条跳过并点名缺哪个变量；值绝不进输出/日志/账本；退出码保持 0（成员侧问题不染红） | `环境变量未定义 ${X}，server "y" 本次跳过`；doctor `mcp:var` WARN + `export` 指引 | mcp.test.ts `缺环境变量`；m6-trial 哨兵 0 命中 | 闭环 |
| 19 | requires 可执行缺失 | `agents/mcpfmt.ts:34-54 whichOn` + `:181-191` | PATH 找不到（win32 走 PATHEXT）→ 该 server 跳过 + 点名可执行名 | `server "x" 需要的可执行文件「npx」不在 PATH 上，本次跳过` | mcpfmt.test.ts（含 PATHEXT 注入）；m6-trial 真机 | 闭环 |
| 20 | foreign-entry（账本没有、文件里有同名条目） | `core/merge.ts:218`（规则 6）+ `core/apply.ts:199-207` | 不覆盖，kept 点名到条目 key | `保留 <path>（条目 "x"：非本工具投递的文件）` | merge.test.ts 规则 6；ledgercheck | 闭环，但两点遗留：`--force` 口子未接（F6）；条目级场景复用"非本工具投递的**文件**"文案，略歧义（P3） |
| 21 | codex 跳过 sse | `agents/mcpfmt.ts:79-80 tomlCodexEntry` 返 null + `:193-195` | 该 server 对 codex 跳过 + warning | `Codex：不支持 sse transport，server "x" 本次跳过` | mcpfmt.test.ts | 闭环 |
| 22 | TOML 异形 | `core/merge.ts:306-495 classifyTomlLine/tomlScan`（`[[`、内联表、括号/引号不平衡、重复表等一律判异形）→ `core/apply.ts:188-193 applyMergeWrite` | 认不出 → `ok:false` → **该工具本次 mcp 静默不投、不改文件** | **无任何反馈**（pull 摘要照常"已投递 N"，退出码 0）；计划 §3.3 规则 5 要求的是"FAIL 级点名" | 只有 merge.test.ts 单测（ok:false），无任何"用户可见反馈"断言 | **静默缺口（F2，P1）** |
| 23 | Windows 无 Git Bash | `cli/constants.ts:22-33 hookCommand` 返 null + `init.ts:127-145` + `doctor.ts:368-393` | hook 一个都不装、逐工具安装指引；手动 pull 不受影响；doctor `win:gitbash/git` FAIL + 指引、`win:hookbash` 核对 bash 路径 | init 逐工具指引；doctor 三条 FAIL/WARN | constants.test.ts、doctor.test.ts（平台注入） | 闭环（代码层；真机未执行，F8） |
| 24 | 锁竞争 | `cli/lock.ts`（5min stale）+ `pull.ts:56-69` + `mr.ts:50-61` | silent pull 直接跳过返 0（那个进程会同步好）；交互 pull/push 报错 + pid + 锁文件路径 | 交互：`已有 ejdrone 进程正在同步…下一步：等它结束/删除 <lock>` | review-fixes `并发同步` 两条 | 闭环。遗留：>5min 的合法 pull 会被抢锁（F10，P3 观察） |
| 25 | 卸载：改过/未改过区别对待 | `uninstall.ts:85-175` | 未改过 → 删/撤；改过 → 保留 + 点名 + 账本收窄；区块只撤标记内；MCP 反向合并；config 保留 | `清理完成…` + 保留逐条点名 + 空目录只报告 | failure.test.ts 6 例；真机 m5/m6-trial 逐字节还原 | 闭环 |
| 26 | MCP 与 hook 同一文件（qoder-cn settings.json） | `paths.ts` mcpTarget.file 与 hookFile 同指 + `hooks.ts`/`merge.ts` 各只动自己的键 | 两条写路径互不破坏，权限照原文件 | 无（用户不应感知） | mcp.test.ts `hooks 与 MCP 落在同一个文件` | 闭环 |
| 27 | 成员侧 MCP 配置文件损坏/异形（新成员无账本） | 同 22 + `doctor.ts:110-138 mcpManagedCheck` | pull 静默不投；`status`/`list mcp --source local` 的本地扫描会点名"不是合法 JSON"；doctor 对新成员全绿（无 managedKeys 条目） | **pull 无反馈**；status/list 有；doctor 盲区 | 无 | **静默缺口 + doctor 盲区（F2，P1）** |
| 28 | 本地 checkout origin 与 config.repo 不一致 | `git/repo.ts:100-106 ensureClone`（已是仓库就只 `fetch origin`，从不比对/更新 origin URL） | `init --force <新repo>` 后本地 `~/.ejdrone/repo` 仍指向旧 origin：pull 拉旧仓库、push 推旧仓库、doctor `repo` 检查实际验的是旧仓库却报"可达" | 无任何提示 | 无 | **静默死角（F1，P1）** |

---

## ③ 状态流转表

五类状态的入口、出口与用户可见反馈；重点标"进了某状态出不来"或"出来了用户不知道"的死角。

### 3.1 config（`~/.ejdrone/config.yaml`）

| 状态 | 入口 | 出口 | 用户可见反馈 | 死角 |
|---|---|---|---|---|
| 无 | 全新机器 | `init` 原子写入（0600） | 所有命令：`尚未初始化（找不到 config）…下一步：运行 ejdrone init <repo>` | 无 |
| 合法 | init / roles set | 各命令读取；`init --force` 覆盖 | `已写入 config：repo=… provider=…` | 无 |
| 坏（YAML 错/缺键/拼错键，strict 有意为之） | 手改坏 | `init --force` 重建 | `Config is invalid: <原因>…下一步：修正该文件，或用 ejdrone init <repo> --force` | 无 |
| 旧格式 | —（1.0 起即 `version:1` strict，无历史格式） | — | — | 无 |

### 3.2 ledger（`~/.ejdrone/ledger.json`）

| 状态 | 入口 | 出口 | 用户可见反馈 | 死角 |
|---|---|---|---|---|
| 无 | 首次 pull 前 | 首次投递后生成 | pull 正常；doctor `ledger` PASS"尚无投递记录" | 无 |
| 合法 | 每次 pull/uninstall 后重写 | — | doctor `ledger` PASS / WARN 列不一致路径 | 无 |
| 坏（JSON 坏/结构坏） | 磁盘损坏/手改 | 删除后下次 pull 重建 | pull `提示：Invalid ledger…` + 按空账本继续；doctor `ledger` FAIL + `删除 ledger 后重新 ejdrone pull` | **半死角（F7）**：未改过的文件下次 pull 自动重记（`apply.ts:288-291` hash 相等分支），但**被本地改过的文件**会判 foreign-file 永久保留、每次 pull 点名，需用户手删才能重新接管；doctor 提示语"账本丢失只会让下次 pull 重新记账"对后者不成立 |
| 1.0 旧格式（无 managedKeys） | 1.0 升级而来 | 正常读取（可选字段，`ledger.ts:49-54`） | 无感 | 无（回归测试钉住：缺字段 ≠ 非法） |

### 3.3 sync.lock（`~/.ejdrone/sync.lock`）

| 状态 | 入口 | 出口 | 用户可见反馈 | 死角 |
|---|---|---|---|---|
| 无 | 每次 pull/MR 开始 | `acquireLock` 创建，`release` 删除 | 无（用户不感知） | 无 |
| 持有（另一进程） | 两个 AI 会话同时启动 / push 与 hook pull 相撞 | 对方结束 | silent pull：静默跳过返 0；交互：`已有 ejdrone 进程正在同步（pid N）…下一步：等它结束/删除 <lock>` | 无 |
| stale（>5min） | 进程崩溃/机器休眠 | 自动回收重试（`lock.ts:49-56`） | 无感 | **观察项（F10）**：超过 5 分钟的合法 pull（超大仓库/极慢网络）会被另一会话抢锁，理论上重现"交错写 ledger"这一锁要防的事故；5min 阈值属保守取值，暂列 P3 |

### 3.4 snapshot（`~/.ejdrone/repo` + 解析结果）

| 状态 | 入口 | 出口 | 用户可见反馈 | 死角 |
|---|---|---|---|---|
| 在线 | clone/fetch + reset | 正常解析 manifest/资源 | pull 正常摘要 | 无 |
| 离线回落 | 网络失败 | doctor：`repo` WARN + 基于本地旧快照继续检查；pull：fatal 退出 | doctor：`仓库暂时同步不了…以下检查基于本地已有快照，可能不是最新`；pull：`同步团队仓库失败…离线时可先 ejdrone list --source local` | 无（回落有"可能不是最新"提示） |
| mcpFileError | `mcp/*.yaml` 文件级解析失败 | 修好后自动恢复 | 停发说明 + 指向文件；pull 退出码 1 | 无 |
| manifestError | roles.yaml 坏 | 修好后自动恢复 | 全量停发说明 + 指向文件；pull 退出码 1 | 无 |
| origin 与 config.repo 不一致 | `init --force` 换仓库 URL | 无（无检测） | **无** | **死角（F1，P1）**：config 说新仓库、checkout 同步旧仓库，pull/push/doctor 全部静默作用在旧仓库上，"进去了出不来" |

### 3.5 Resolution（裁决结果）

| 状态 | 入口 | 出口 | 用户可见反馈 | 死角 |
|---|---|---|---|---|
| 正常 | resolve() | writes/deletes/keeps 落账 | `已投递 N…删除 N…保留 N` | 无 |
| haltedKinds（双 ns 冲突 / mcpFileError） | `plan.ts:94-100` + `delivery.ts:77-80` | 团队修好后恢复 | `冲突：…该类型本次停发（已装内容保留）` + 下一步；退出码 1 | 无（"停发 ≠ 清空"不变量由 `activeResourcesWithConflictHold` 保证，三条测试背书） |

---

## ④ 异常分支与反馈机制评估

### 4.1 错误信息"下一步"覆盖率：高

走查全部 `ctx.err` / fatal 路径：init（6 处）、pull（lock/manifest/网络/apply 四类）、push（采集/namespace/MCP/提交）、roles、remove、readme、status、list、doctor 每项 FAIL/WARN——**均带"下一步"**。唯一错值：uninstall hook 清理失败指向 `~/.ejdrone/<工具id>`（F3）。doctor 各项 hint 质量总体好（mcp:var 直接给 `export` 行；win:gitbash 给安装地址 + 为什么不用裸 bash）。

### 4.2 退出码语义：一致、可预期

| 命令 | 0 | 1 | 特殊 |
|---|---|---|---|
| pull | 正常（含"缺 ${VAR} 跳过"这类成员侧问题） | 有 keep / 冲突 / 停发 / fatal | `--silent` 恒 0（hook 不能挡工具启动） |
| doctor | 无 FAIL | 有 FAIL | WARN 不影响退出码 |
| init | 成功（含首次 pull 有 keep 的提示态） | 致命（仓库不可达/坏 manifest/无工具） | — |
| push / roles / remove / readme | 成功，**含"分支已推 + 手动开 MR"这类降级成功** | 采集/校验/提交失败 | generic provider 降级不算失败 |
| uninstall | 完成/取消 | 非交互无 `--force` | — |
| status / list / roles list | 正常 | 致命（无 config/仓库不可达/坏 manifest） | — |

`pull = 1` 混合了三类原因（keep / 冲突 / 停发），但 `doctor` 与 `status` 能分辨具体是哪类，语义可接受。

### 4.3 doctor 检查项 × 失效模式覆盖矩阵

doctor 现有检查（POSIX 9 项：config / repo / manifest / agent:<id>×N / hook:<id>×N / ledger / mcp×4 / probe；win32 加 win:×3）：

| 失效模式 | doctor 能看见？ | 说明 |
|---|---|---|
| config 无/坏 | ✅ FAIL | 指到文件与修法 |
| 仓库不可达 | ✅ WARN + 回落 | 基于旧快照的结论标"可能不是最新" |
| **origin 与 config.repo 不一致** | ❌ 盲区 | `repo` 项实际 fetch 的是旧 origin，报"可达"（F1） |
| manifest 坏 | ✅ FAIL | 指到文件与出错位置 |
| **skills/rules 双 ns 同名冲突** | ❌ 盲区 | pull 才报；doctor 不跑 resolve 冲突检测（F4） |
| **本地订阅角色不在 manifest** | ❌ 盲区 | `roles list`/`status`/pull 有，doctor 无（F4） |
| 未知工具 id / 工具根目录不存在 | ✅ FAIL / WARN | — |
| hook 文件不存在 / 缺条目 | ✅ FAIL | — |
| hook 命令指向已消失入口 | ✅ FAIL | nvm 升级场景（1.0 终审修过） |
| hook 指向另一份安装 | ✅ WARN | npm 全局升级场景 |
| **hook 装了但工具不执行** | ❌ 盲区 | PROBE 状态，PASS 只证明条目在文件里（已知限制，trials 登记） |
| ledger 坏 | ✅ FAIL | 提示语对"改过的文件"不完全准确（F7） |
| ledger 与磁盘不一致（改过/缺失） | ✅ WARN 列路径 | — |
| mcp 文件坏 | ✅ FAIL（mcp:parse） | — |
| 缺 `${VAR}` | ✅ WARN（mcp:var）+ export 指引 | — |
| 受管条目被改/被删 | ✅ WARN（mcp:managed）指到条目 | 但"配置文件解析失败"也被归进这一项的"你改过或已删掉"文案，误导（F2 附属） |
| **成员侧 MCP 配置文件损坏 + 新成员（无账本）** | ❌ 盲区 | 四项全 PASS（F2） |
| 选定工具无 MCP 落点 | ✅ WARN（mcp:target） | — |
| 落点未真机核对 | ✅ WARN（probe，只报选定工具） | — |
| **silent 期的锁竞争/apply 异常** | ❌ 盲区 | 只进 debug.log，doctor 不读；但网络/坏 manifest 类 doctor 可复现 | 
| win32 三条 | ✅ win:gitbash / win:git / win:hookbash | 仅 win32 出现，POSIX `--json` 逐字节不变（硬约束，有测试钉住） |

### 4.4 `--silent` 模式取舍评估

**取舍本身正确**：hook 的定位是"会话启动时顺带同步"，任何非零退出都可能挡住用户开工具；问题写 `~/.ejdrone/debug.log` + 恒 0 是与定位相匹配的设计，且正常时连日志都不写（failure.test.ts 钉住）。与 doctor 形成互补：silent 期出的问题，成员被教导"出问题先跑 doctor"，而 doctor 能复现其中绝大多数（网络、坏 manifest、坏 mcp.yaml、hook 失效、记账不一致）。

**残余风险**（均不构成本轮缺口，列 P3 观察）：① debug.log 只追加不轮换，无生长上限；② silent 期特有的失败（锁竞争跳过、apply 异常）不出现在 doctor 任何检查里；③ 没有"最近一次 silent pull 失败"的一等公民 surfacing——成员要自己想到 `cat ~/.ejdrone/debug.log`（团队仓库 README 的排查节已教，缓解充分）。

---

## ⑤ 缺口与阻塞点清单

性质分三类：**设计内取舍**（查设计文档 §14 / 2.0 计划 §7 对得上，不是缺陷）、**环境阻塞**（缺真机等资源）、**真缺陷/真缺口**。优先级：P0 阻塞 / P1 应修 / P2 可优 / P3 观察。

| # | 位置 | 问题 | 影响范围 | 性质 | 优先级 | 建议处理方式 |
|---|---|---|---|---|---|---|
| F1 | `src/git/repo.ts:100-106`（ensureClone） | 已是 git 仓库就只 `fetch origin`，从不比对/更新 origin URL。`init --force <新repo>`（团队改仓库地址/迁移）后，本地 checkout 静默继续同步**旧**仓库：pull 拉旧的、push 推旧的、doctor `repo` 项验的是旧的却报"可达"。无任何提示 | 换过仓库地址的全部成员；push 会把新内容推进旧仓库 | 真缺陷 | **P1** | ensureClone 增加 `git remote get-url origin` 与 config.repo 的归一化比对（凭据抹除后比），不一致时 `set-url` 或重建 checkout 并明说；doctor `repo` 项随之变诚实（同一处比对，不新增检查面） |
| F2 | `src/core/apply.ts:188-193`（applyMergeWrite `if (!outcome.ok) return;`） | MCP merge 失败（成员配置文件不是合法 JSON / TOML 异形 / pointer 层形状不对）时该工具本次 mcp **静默不投、不改文件、不点名**；pull 摘要照常、退出码 0。新成员（无账本）场景 doctor 四项全绿。2.0 计划 §3.3 规则 5 明确要求"FAIL 级点名" | 配置文件损坏/异形的成员：静默收不到团队 server，且与"pull 会点名"的产品承诺相悖 | 真缺陷（对照自家冻结计划） | **P1** | `!ok` 时向 `result.kept` push 一条（reason 用结构性原因，文案只含路径与条目 key——merge.ts 已保证 error 不含值），使 pull 点名且退出码 1；`doctor` 的 `mcp:managed` 对"解析失败"与"你改过"分文案；补一条 e2e（坏 `~/.claude.json` → pull 点名 + doctor WARN） |
| F3 | `src/cli/uninstall.ts:72` | hook 清理失败时的"下一步"指向 `join(stateDir, adapter.id)`（即 `~/.ejdrone/claude`）——hook 文件根本不在那里，而在工具自己的目录（`hookTarget().path`，该函数在同一文件已导入并使用） | 卸载遇阻时的指引价值 | 真缺陷（反馈质量） | P2 | 改用已算出的 `target.path`（该函数第 65 行已有 `target` 变量，一行修复） |
| F4 | `src/cli/doctor.ts`（缺检查） | doctor 不检测：① skills/rules 双 namespace 同名冲突；② 本地订阅角色不在 manifest。两类都是 pull 会报的问题，doctor 全绿——与 README"出问题先跑 ejdrone doctor"的产品指引相悖 | 依赖 doctor 做体检的成员/CI | 真缺口（体检覆盖面） | P2 | manifest 检查分支内复用现成的 `resolve()` 与 `activeNamespaces()` 各加一项 WARN（纯函数已在用，不新增机制） |
| F5 | `src/core/plan.ts:117,123`、`src/core/resources.ts:113,122,134,144,182,188`、`src/core/mcp.ts:131,186,192` | 用户可见的"提示："行混出英文（`has no SKILL.md; skipped`、`Role "x" is not defined in manifest/roles.yaml` 等），经 pull/status/list/doctor 直达终端；产品其余部分全中文 | 全体中文用户的一贯性体验 | 真缺陷（体验一致性） | P2 | 这批 warning 统一中文化（纯文案，不动语义与测试断言结构） |
| F6 | `src/core/merge.ts:37,218`（force 口子）vs 2.0 计划 §7 | 计划 §7 承诺 foreign-entry"（--force 才动）"，实现上 apply 层永不传 force、`pull --force` 显式跳过 merge（`pull.ts:37`），即 force 对受管条目完全无效；`pull --force` 的输出文案其实已声明"受管条目投递不受 --force 影响"，用户侧有告知，但计划/注释与代码三者不一致 | 文档可信度；想用 --force 抢回 foreign 条目的成员 | 计划与实现不一致（未登记的偏差） | P2 | 不建议为它开"force 覆盖成员条目"的行为（安全红线相邻）；把 2.0 计划 §7 该行改记为"force 暂不接，pull --force 文案已声明"，消歧义 |
| F7 | `src/cli/doctor.ts:344`（ledger hint） | "删除 ledger 后重新 ejdrone pull（账本丢失只会让下次 pull 重新记账）"对**被本地改过的文件**不成立：它们会被判 foreign-file 永久保留、每次 pull 点名，需用户手删才能重新接管（demo-trial §4.1 同源问题） | ledger 损坏后按指引操作的成员 | 真缺陷（反馈误导，轻度） | P2 | hint 补一句"被你改过的文件需先删除，下一次 pull 才会重新接管并记账" |
| F8 | `docs/trials/2026-10-11-m10-trial.md` §4 | Windows 真机全量测试（T10.4 后半）与 T10.7 真机流程未执行；win32 行为仅靠注入 platform 参数的单测。计划 §6 明示"不用 POSIX 测试冒充 Windows 验证"，本轮登记为遗留项符合流程 | M10 验收完整性；Windows 成员 | 环境阻塞（资源前置不具备） | P1（阻塞 M10 验收，非代码缺陷） | 维持现状登记；Windows 机器/VM 到位后按试验记录 §4 清单补跑；README 已如实标注前置条件，无隐瞒 |
| F9 | `src/cli/pull.ts:176-180` + `:84-93` | `--silent` 恒 0 + debug.log 的取舍评估见 ④.4：取舍正确，残余是 debug.log 无轮换、silent 期特有失败（锁竞争/apply 异常）不出现在 doctor | hook 场景的问题可发现性 | 设计内取舍 | P3 | 维持现状；若要改进属新功能面（doctor 读 debug.log），建议留给 2.1 统一评估，不塞进本轮 |
| F10 | `src/cli/lock.ts:13`（STALE_MS = 5min） | 超过 5 分钟的合法 pull 会被另一会话按 stale 抢锁，理论上重现"交错写 ledger"事故 | 超大团队仓库 + 慢网络的小概率场景 | 设计内取舍（保守阈值） | P3 | 观察；若出现超长 pull 实测，可改心跳或提高阈值，改前需评估"进程崩了锁不回收"的另一端 |
| F11 | `src/agents/common.ts:57`（detect 只看根目录）+ pull 仍给未安装工具写文件 | detect 误报（`~/.pi` 等因别的软件存在被判"已装"）；工具卸载后留在 config.agents 里，pull 会重建其 skills 目录 | 16 工具后的误报面（m5-trial §4 已登记） | 设计内取舍（init 由成员自己勾，不发明新判据） | P3 | 维持现状；doctor `agent:<id>` WARN 已能在工具消失时点名 |
| F12 | `src/cli/remove.ts:237-241` vs `:101-116` | `remove skills/rules <name>` 对根与多个 namespace 同名**一并删除**，而 `remove mcp` 对根/ns 同名**拒绝执行**要求表态——同名资源的删除语义不一致（MR 正文与命令输出都列出全部路径，评审兜底，故不伤人） | 管理员删除操作的心智模型 | 设计内取舍（未登记） | P3 | 在 README 命令表或计划 §7 补一句语义说明即可；不建议改行为（一并删"这个资源的所有副本"是自洽语义） |
| F13 | `src/agents/paths.ts` probe 字段 + `doctor.ts` hook 检查 | hook 装了但工具是否执行未知（13/16 工具未真机触发）；doctor PASS 只证明条目在文件里 | 自动 pull 主价值链的确定性 | 环境阻塞（真机）+ 设计内取舍（PROBE 机制兜底） | P3 | 已由 doctor probe WARN + trials 逐项销记机制覆盖；随各成员真机使用自然销记 |
| F14 | `src/cli/list.ts:62-71` | `list --source all` 离线时本地段已打印、随后仓库段报错整体退出 1——本地内容可见但命令整体判败 | 离线查本地的成员 | 真缺陷（轻度） | P3 | 要么离线时本地段照给、仓库段降级为提示，要么在文案上说清；影响小 |

**范围外说明（不是缺口）**：M7 子 Agent 下发、M8 docs + recall、M9 learnings 均未实现——它们是 2.0 后续里程碑，当前版本范围内本就没有，不计入上述清单。2.0 计划 §2"不做"表列项（hooks 资源下发、env/secrets、models、project scope、GitHub/HTTP provider 等）同理。

---

## 总结

当前版本（1.0 + M5 + M6 + M10 代码层）的七步主旅程全部闭合，无硬断点；安全红线（不覆盖本地修改、不动他人条目、token 不回显、停发 ≠ 清空）在代码与测试两层都站得住，MCP 条目级合并这条最复杂的新语义有真机逐字节还原背书。最需要动手的是三个"静默/误导"类问题：**F1（换仓库后静默同步旧仓库，doctor 误报可达）、F2（MCP merge 失败静默，计划自己要求 FAIL 点名）、F4（doctor 对冲突与未知角色盲区）**——它们共同点是"坏了用户不知道"，直接侵蚀"出问题先跑 doctor"这一产品承诺。其余为反馈质量与文档一致性的 P2/P3 打磨项。
