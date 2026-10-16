# ejdrone-teamai 工程质量评审 · 架构与系统质量（第二部分 A）

> 日期：2026-10-12 · 评审人：高见远（Gao，软件架构师）· 评审立场：只读评审，未改动任何仓库文件
> 被评审版本：当前工作树（`0515a0f` + 17 个未提交修改 + 5 个未提交新增，即 M10 代码层完成态）
> 能力边界基准：1.0 五工具 + 2.0 已完成里程碑（M5 工具 5→16、M6 MCP 条目级合并、M10 Windows 代码层）；M7/M8/M9 未实现，不作为缺口
> 必读依据：README.md、AGENTS.md、设计文档 §7/§10/§14、2.0 计划 §2/§3/§7、docs/trials/ 四份试验记录

## 0. 评审方法与基线复验

- 通读：README、AGENTS.md、设计文档、2.0 计划、四份试验记录；src/ 全部 65 个 .ts（9,598 行）逐文件审读；按代码地图定向核查 test/ 覆盖声明。
- 只读验证（本机复跑）：
  - `npm run typecheck` → **0 错误**（复跑确认）；
  - `npx vitest run test/platform.test.ts test/cli/constants.test.ts test/cli/doctor.test.ts` → **44/44 通过**（M10 三个新测试文件复跑确认）；
  - 全量 704/704 采信协调者已验结论（本机会话 Bash 通道不稳定，未重跑全量，避免 OOM 误报）。
- 静态核查：全仓 src/ 搜 `as any` / `@ts-ignore` / `win32` / `process.platform` / `'\\'` 硬编码 / `TODO` / 路径 `===` 比较，结果分列各节。
- 性质判定约定：**[设计内]** = 查 §14/§7 对得上的有意取舍，不计缺陷；**[环境]** = 资源前置不具备；**[真缺陷]** = 与代码自身规则/文档承诺不符或逻辑确证会出问题。

---

## 一、架构

### 1.1 表驱动适配器边界：干净，无越界（确认通过）

16 个适配器全部为 24-26 行、零 `if`、零重复的「声明 id + 组装」：11 个实现 `planMcp` 与 `paths.ts` 中 11 项 `mcpTarget` 一一对应，5 个（dsh / openclaw / trae / trae-cn / hermes）无 `planMcp` 也与表中缺席一致（`src/agents/dsh.ts` 全文无一个条件判断）。全部规则分派收敛在两处：`src/agents/common.ts:78 planRulesFor`（rulesdir/mdc/block/none 按表分派）与 `common.ts:116 planMcpFor`（mcpTarget 缺席 → 空数组；恒发一条 merge write），条目形态分派在 `src/agents/mcpfmt.ts:146 renderMcpEntry`（四种 style 按表字段，无工具 id 判断）。适配器层没有越界的判断逻辑。**无缺陷。**

### 1.2 resolve() 纯函数与 plan/apply 分离：遵守（确认通过）

`src/core/plan.ts` 全文零 IO，`resolve()` 只做候选集/替换/冲突/停发裁决；IO 集中在 `apply.ts` 与 CLI 层。`KindSet` 全总映射贯彻到位：`RESOURCE_KINDS`（types.ts:126）驱动 `KIND_ROOT`（plan.ts:19）、`emptyKinds`、`cli/kinds.ts` 的 `SPELLINGS` Record——新增 kind 漏一处即编译失败，AGENTS.md 警告的"kind 白名单把停发变删除"没有复发。`haltedKinds` 停发语义在 `cli/delivery.ts:82-92`（停发 kind 整个跳过计划）与 `cli/delivery.ts:117 activeResourcesWithConflictHold`（把该 kind 已记账资源标 active）两处合流，构成"停发 ≠ 清空"不变量；mcpFileError 也正确汇入同一个 halted 集合（delivery.ts:77-80）。**无缺陷。**

### 1.3 MCP 受管条目合并的信任模型：主模型成立，账本丢失后的恢复路径有缺口

**发现 A-1［真缺陷 · P2］**
- **位置**：`src/cli/doctor.ts:343-344`（ledger 检查 FAIL 时的 hint：`删除 ${ledgerFile} 后重新 ejdrone pull（账本丢失只会让下次 pull 重新记账）`）；相关语义在 `src/core/merge.ts:218-221`（JSON）与 `merge.ts:601-604`（TOML）的规则 6。
- **影响范围**：账本损坏/被删后的所有 MCP 成员。推演：账本缺失 → `previous = {}` → 规则 6 判"文件里有、两次投递都没有"→ 全部我方条目记 `foreign-entry` 保留、不进 `delivered` → 这些条目**此后既不随团队更新、也不再被记账**，且每次 pull 点名成"非本工具投递的文件"。即 doctor 指引的"删账本恢复"对整文件记账成立、对 merge 记账**恰恰不成立**，会把成员留在一个"以为恢复了、其实团队 server 已永久冻结"的状态。注意这是安全方向（不猜领别人的条目，§7 有意登记），缺陷在**指引文案与行为不符**而非合并规则本身。
- **建议处理方式**：hint 按记账类型分化——账本里存在 `managedKeys` 条目时，先 WARN 逐条点名受管文件再让成员决定；或在 hint 中明说"删除后 MCP 受管条目会被当作他人条目冻结，需手动清理后重新投递"。属把已实现功能做扎实，不动合并规则。

### 1.4 Windows 差异收口：主干在 platform.ts，但有 4 处薄分支与 1 处重复实现

**发现 A-2［真缺陷（文档与代码不符）· P3］**
- **位置**：AGENTS.md:36-37 硬规则"Windows 差异只走 `src/platform.ts` 一层……适配器与渲染层不许出现 win32 if"。实际平台分支共 5 处：`src/platform.ts`（四函数，合规）、`src/core/ledger.ts:101`（replaceFileSync 的 win32 分支）、`src/agents/mcpfmt.ts:36`（whichOn 的 win32 分支——位于渲染层，字面上违反该规则）、`src/cli/constants.ts:29`（hookCommand 平台形态）、`src/cli/doctor.ts:368`（win: 三条检查出现条件）。
- **影响范围**：后续维护者。5 处中 4 处是薄委派（调用 platform.ts），没有散落的平台*逻辑*，规则的**精神**被遵守；但字面规则与现实不符，且 `mcpfmt.ts:37-53` 的 POSIX 分支与 `platform.ts:153-171 whichOnPosix` 是两份逐字重复的实现——改一处漏一处正是该规则想防的事。
- **建议处理方式**：`whichOn` 无条件委派 `whichWithPathext`（它内部已分平台），删掉 mcpfmt 里的 POSIX 副本；AGENTS.md 表述改为"平台判断一律调 platform.ts 的四个函数，各处不得自己实现平台逻辑"。

### 1.5 冻结契约 types.ts：未被绕过（确认通过）

全仓 src/ 零 `as any`、零 `@ts-ignore`、零 `eslint-disable`（已全量搜索）。`ResourceKind = 'skills' | 'rules' | 'mcp'` 与"M7/M8/M9 后续各自再加"的注释一致，当前无越界扩展。types.ts 头部"要改签名先讨论"的冻结契约在 git 历史与 §7 偏差登记中均无违反记录。**无缺陷。**

---

## 二、可维护性

### 2.1 大文件与复杂度峰值（如实清单）

| 文件 | 行数 | 复杂度评估 |
|---|---|---|
| `src/core/merge.ts` | 788 | **全仓复杂度峰值**：`classifyTomlLine`（逐行状态机：引号/转义/括号深度）+ `tomlScan`（表归属状态机）+ `mergeToml`（插入点/删除区间推算），主路径圈复杂度直觉 15-20；JSON 侧 `mergeJson` 约 10。由 table-driven 测试与 M6 真机逐字节验证兜底，可接受，但**再往 TOML 加形态的成本很高**，是后续最该防膨胀的点。 |
| `src/cli/doctor.ts` | 486 | 检查项装配函数线性排列（mcp 四项 + win 三项 + 逐工具 hook 核对），单函数都不深，但文件已到需要拆的规模（可按"检查族"拆文件）。 |
| `src/cli/push.ts` | 467 | `collectPending` 分支较多（skill/rule/mcp/all/交互/非交互六态），是命令面自然复杂度。 |
| `src/core/apply.ts` | 374 | 三条写路径 + merge 分组，分函数后每函数可读性良好。 |

### 2.2 注释与代码一致性：M10 刚改过一轮，发现 3 处过期/失真

**发现 M-1［真缺陷 · P3］（过期规则文档）**
- **位置**：AGENTS.md:43-44 "三处原子写（state.ts saveConfig / hooks.ts atomicWrite / ledger.ts saveLedger）统一走 `replaceFileSync`"。
- **影响范围**：维护者对"原子写有哪几处"的认知。M6 引入了**第四处**原子写 `src/core/apply.ts:236 atomicWriteWithMode`（merge 投递与 0600 收紧走它），它**没有**走 replaceFileSync（详见稳定性 S-1）——文档枚举漏了它，而它恰是唯一没修 Windows 的那处。
- **建议处理方式**：随 S-1 一起修，并把文档枚举改为"所有原子写统一走 replaceFileSync（含 apply.ts）"。

**发现 M-2［真缺陷 · P3］（说谎文案）**
- **位置**：`src/cli/uninstall.ts:72`：hook 清理失败的下一步指向 `join(stateDir(ctx.env), adapter.id)`（`~/.ejdrone/<id>/`）。
- **影响范围**：排障中的成员。hook 文件实际在**工具根目录**（`~/.claude/settings.json` 等，见 paths.ts hookTarget），按此文案去找目录必然找不到。
- **建议处理方式**：文案改为指向 `hookTarget(adapter.id, …).path`（即失败时正在处理的那个文件路径）。

**发现 M-3［真缺陷 · P3］（格式卫生）**
- **位置**：`src/cli/push.ts:2`（两条 import 挤同一行）与 `src/cli/push.ts:143`（`absPath` 函数体与签名挤同一行）。
- **影响范围**：观感与 diff 可读性；疑似手工编辑残留。
- **建议处理方式**：格式化，无行为变化。

### 2.3 16 适配器重复度：零重复（确认通过）

见 1.1。差异只在"有无 planMcp"，由 `paths.ts` 表项决定，符合"加新工具是填表不是抄判断"的约定。

### 2.4 错误处理模式：总体一致（确认通过）

三类标准清晰可辨：① 抛错 = 内部不变量被破坏（`mcpPayload`、`specOf`、`mergeEntries` 未知 format）；② 降级 `installed:false` + reason = hook 安装失败（`common.ts:184-189`，绝不抛错中断 pull）；③ 跳过 + note 点名 = 条目级问题（缺变量/缺可执行/不支持 transport）；④ CLI 层 fatal 必带"下一步"。未发现同一类故障两种处理标准。命名与目录约定全程一致（kebab 文件、test/ 镜像 src/）。

### 2.5 probe 文案被当作逻辑输入（观察）

**发现 M-4［观察 · P3］**：`src/cli/doctor.ts:34-38 probeUnverified` 用正则匹配 probe **文案**（`/未核对|待真机|PROBE/`）决定 WARN。文案即数据：将来有人把某个已核实项的 probe 文案改写时带上这三个词，行为会悄悄改变。可接受（有注释说明），但建议将来改为显式布尔字段（如 `probe: { unverified: true, note: '...' }`），与"表是唯一真相源"的原则一致。

---

## 三、性能

### 3.1 pull 全链路成本曲线（量化）

**git 操作次数**（稳态，非首次）：每次 pull 共 **8 个 git 子进程**——`ensureClone`（rev-parse --show-toplevel + fetch origin）+ `defaultBranch`（symbolic-ref）+ `fetchReset`（fetch origin + ls-remote --heads origin + ls-remote --heads origin <branch> + reset --hard + rev-parse HEAD）。首次 clone 为 7 个。每次子进程 20-50ms（POSIX）/ 50-150ms（Windows），加网络 fetch，固定开销约 0.3-1.2s，**由网络与进程 spawning 主导，与仓库大小弱相关**。微优化点（P3）：`ensureClone` 的 fetch 与 `fetchReset` 的 fetch 背靠背重复了一次，可合并。

**投递计算成本**：设 W = 本次 writes 数（≈ 各工具 skills 文件数 + rules 数 + merge 1 条/工具），L = 账本条目数（稳态 L ≈ W）。每个 write 都要 `existsSync + readFileSync + sha256 + ledgerEntry`，而 `ledgerEntry`（ledger.ts:111-114）是**线性查找** → 单次 pull 的哈希与查找总量为 O(W×L) ≈ **O(W²)**；另加删除循环对非 active 条目逐条 `isManaged`（适配器数 × relative()）。

| 单人投递集 W | 查找+哈希量级 | 预估 pull 墙钟 | 判定 |
|---|---|---|---|
| ~300（典型：3 工具 × 几十资源） | 9 万次比较 | 亚秒级 | 15-25 人团队**完全可接受** |
| ~3,000（3 工具 × 50+ 个多文件 skill） | 900 万次 | 0.1-0.3s | 可接受 |
| ~10,000（16 工具全勾 / 数百 skills） | 1 亿次 + 1 万次文件读 | 3-8s（含快照收集 2-5s） | **开始劣化**，hook 每次会话启动都付这笔钱 |
| ~30,000（巨型 skill 树） | 9 亿次 | 10-30s | **不可接受** |

**关键判定（团队规模维度）**：单人成本 = 选定工具数 × 仓库资源数 × 每资源文件数，**与团队人数无关**（每人独立账本、user scope）。15-25 人团队仓库通常几十到一二百条资源，pull 亚秒到 2 秒，hook 自动 pull 无感。**劣化触发点：单人投递集超过约 1 万个文件**——症状是会话启动 hook pull 从亚秒变成数秒。根因两条：① `ledgerEntry` 线性查找造成的 O(W²)；② `openSnapshot` 每次全量 `collectResources`（读仓库每个文件，与本次投递范围无关）。

**doctor / status 全账本核对成本**：`auditLedger`（ledgercheck.ts:71-87）对 L 个条目各做一次读文件 + 哈希，是 **O(L) 无平方项**；merge 条目走 `currentEntryHashes`（同解析器复判）。W=10,000 时 2-5s，可接受。每次 pull 的写盘次数：稳态 0（幂等，有测试 + M6 真机"已投递 0 个文件"证据）；有变更时 = 变更文件数，每个 merge 文件 1 次同目录临时文件 + rename，临时文件开销可忽略。大 skill/大仓库场景见上表；坏文件降级不投递也不重算（停发即跳过）。

**建议（P2，非缺陷，规模未到不必须做）**：`ledgerEntry` 改 Map 索引（apply/ledgercheck 内部实现，不动 types.ts 冻结契约），O(W²) → O(W)；这是进入万级文件量前唯一必须做的一项。**文件哈希不能省**——它是"本地改过"判定的信任根基，省了就等于放弃决策 5。快照全量收集可容忍（git checkout 本就全量在本地）。

---

## 四、稳定性

### 4.1 "先算完整 plan 再落盘"：遵守良好（确认通过）

`buildDelivery` 全量算完 writes 才进 apply；`applyPlan`（apply.ts:70-74）先把**所有** merge 结果算完（`runMerge` 全部跑过）才进入写循环——`mergeEntries` 抛错时 `writeFileSync` 一次都没被调用（apply.ts:69 注释与代码一致）；TOML 侧 desired 块也先全部验完再动一个字节（merge.ts:543-551）。半写失败自愈：applyPlan 抛错 → `saveLedger` 不发生 → 账本保持 pull 前状态 → 已写文件下次被判 modified-locally 保留并点名（方向安全，文案"已写入的部分保持原样"准确）；`--force` 的 `forceOverwrite`（pull.ts:32-53）先 unlink 再由 apply 重建，窗口内崩溃 = 文件缺失至下次 pull 自愈。二次 pull 幂等有单测 + 真机双重证据。坏文件降级路径完整：坏 YAML/TOML/JSON → 停发/跳过并点名，绝不按空集清空（mcp.ts 文件级/条目级分层 + merge.ts 规则 5）。

### 4.2 四处写路径的原子性与一致性：两条真缺陷

**发现 S-1［真缺陷 · P1］（M10 修复漏了第四条原子写）**
- **位置**：`src/core/apply.ts:236-254 atomicWriteWithMode`，其中 `:243 renameSync(tmp, path)` 是裸 rename，**没有**走 `src/core/ledger.ts:100 replaceFileSync`（M10 专为"win32 rename 覆盖已存在文件不可靠"导出的先删再 rename）。
- **影响范围**：Windows 上所有 MCP 投递。这条写路径的服务对象恰是 `~/.claude.json`、`~/.codex/config.toml`、`~/.qoder-cn/settings.json` 这类**在真实成员机器上必然已存在**的共享配置文件——正是 rename-over-existing 失败（EPERM/EACCES，与杀毒软件扫描窗口竞争）的高发场景。失败时 pull 走 fatal（已装内容不动，安全方向正确），但 MCP 功能在 Windows 上等于不可用。POSIX 无感，所以现有 704 个用例全绿也抓不到它——典型的"平台分支只在真机暴露"类缺陷（M10 试验已登记真机未执行）。
- **建议处理方式**：`renameSync(tmp, path)` → `replaceFileSync(tmp, path)`（POSIX 行为逐字节不变）；补一条注入 `platform='win32'` 的单测（对已存在目标 + rename 抛错的场景）。同步更新 AGENTS.md 的原子写枚举（见 M-1）。

**发现 S-2［真缺陷 · P2］（uninstall 对成员共享文件用裸 writeFileSync）**
- **位置**：`src/cli/uninstall.ts:119`（merge 条目反向撤销，写 `~/.claude.json` 一类）与 `:157`（撤团队区块，写 `AGENTS.md`）——两处都是裸 `writeFileSync`，非原子。
- **影响范围**：执行 `ejdrone uninstall` 的成员。崩溃/断电/文件被占用会把成员**自己在用**的真实配置（M6 真机试验里 `~/.claude.json` 是 22KB、含 4 条成员 server 的状态文件）截断损坏；且同样不受 replaceFileSync 的 win32 修复保护。pull 侧 apply.ts 的 merge 写已原子化，uninstall 侧被漏掉，两条路径不一致。
- **建议处理方式**：两处改走原子写（复用 apply.ts 的 atomicWriteWithMode 或 ledger 的 replaceFileSync）；注意保持现有性质——`writeFileSync` 写已存在文件不会放宽权限，原子写实现必须保留"权限不回松"（uninstall 不该把成员 0600 的文件变成 0644，也不该把 0644 的擅自改掉）。

### 4.3 sync.lock 竞争与 stale 自愈：自愈条件偏宽

**发现 S-3［真缺陷 · P2］**
- **位置**：`src/cli/lock.ts:63-70 isStale`：只比较 `Date.now() - mtimeMs > 5 分钟`，**不验证持锁 pid 是否存活**。
- **影响范围**：大仓库/慢网络成员。一次超过 5 分钟的合法 pull（万级文件场景，见性能节）会被并发启动的会话 hook 误判为死锁、删锁抢入——两个 pull 同时写 checkout 与 ledger，正是 1.0 §14 记载的事故形态（"交错 load/saveLedger，后写者丢掉先写的记账，那些文件此后再也更新不进去"）。锁的存在意义被削弱。当前团队规模（pull 亚秒~2s）触发概率低，属随规模增长会显形的隐患。
- **建议处理方式**：回收前加 pid 存活探测（`process.kill(holderPid, 0)`，ESRCH = 已死才回收；注意 Windows 上对不存在 pid 同样抛 ESRCH、无权限抛 EPERDRM→EPERM，需单测覆盖注入）；或 stale 判定改为"pid 不存在 OR 超时"。属把已实现的锁做稳，不新增机制。

### 4.4 只读命令在锁外 reset 共享 checkout（观察，部分登记在案）

**发现 S-4［观察 · P3］**：`status` / `list` / `roles` / `doctor` / `readme` / `remove` 的 `openSnapshot` 都会对 `~/.ejdrone/repo` 做 `fetchReset --hard`（git/repo.ts:152-175），而它们不持 sync.lock（`remove` 的锁在 `submitMrChange` 里才拿，snapshot 已在锁外）。与 1.0 §14 登记的"push 最前面的 snapshot fetch 仍在锁外"同类，但面更宽。实际风险被 git 自身 index.lock 兜底为"一次可见的 git 报错，不丢数据"（登记偏差的原论证仍成立）；理论上存在与持锁 pull 交错读到重置中工作树的窄窗口（双方 reset 目标相同，内容一致，后果是一次瞬时 git 错误）。**建议**：在 §14/§7 登记里补一句"只读命令同样在锁外 reset"，或将来给这些命令加共享读锁。不阻塞。

---

## 五、安全

### 5.1 token 读取与回显：红线落实（确认通过）

`src/git/gitlab.ts:64-70 readToken` 只从 `EJDRONE_GITLAB_TOKEN`（回落 `GL_TOKEN`）读；token 不落盘（config.yaml 仅存 repo URL，state.ts:116 显式 0600）；不回显——所有对外文本过 `maskToken`（:72-74），GitLab 错误响应过 `maskToken + errorSummary + truncate`（:192-200），repo URL 解析失败先 `scrubCredentials`（:91，git/repo.ts:57-59 同函数覆盖 git 错误串）。M6 真机哨兵试验（`SENTINEL-m6-live-token` 在全部输出与 `~/.ejdrone/` 全目录 0 命中）佐证。**无缺陷。**

### 5.2 0600 收紧与"只收紧不回松"：三处主路径落实，ledger 是缺口

**发现 X-1［真缺陷 · P3］**
- **位置**：`src/core/ledger.ts:84-89 saveLedger`：临时文件 `writeFileSync(tmp, …)` 未带 `mode`，按 umask 默认（典型 0644）落盘，rename 后 `ledger.json` 为 0644；而 `state.ts:116/128 saveConfig` 显式 `mode: 0o600` + `chmodSync` 钉死，hooks.ts:95-98 保持原权限，apply.ts:219 对新建/含已解析值文件给 0600。
- **影响范围**：同机其他本地用户可读 `ledger.json`。内容只有路径 + sha256 + resource key（无密钥），敏感度低；且 rename 保留 tmp 权限，**不会放宽已有文件**（不回松原则未破坏）。判 P3 而非更高的理由：不涉明文凭据。但"0600 收紧"清单含 ledger 时它是唯一缺口，且状态目录里 config 0600、ledger 0644 并存易让维护者误判。
- **建议处理方式**：saveLedger 写 tmp 时带 `mode: 0o600`（与 saveConfig 对齐），一行改动 + 一条权限断言用例。

**确认通过的部分**：含已解析 `${VAR}` 的文件收紧由 `planMcp` 显式标注（`merge.hasResolvedValue`，common.ts:138/155）、apply 不猜内容（types.ts:167-172 注释与实现一致）；M6 真机复现过"0644 → 0600"修复效果；卸载后不回松（M6 试验 §4 登记为预期行为）。

### 5.3 路径越界与注入面：防护完整（确认通过）

- 写入限制：`git/repo.ts:196-210 resolveInside`（ checkout 内相对路径、拒绝对空/NUL/绝对/`..` 逃逸）；投递侧路径全部由 `join(落点表根, name)` 生成，name 过 `NAME_RE`（constants.ts:79，禁 `/`）、manifest ID_RE、`SERVER_NAME_RE` 三道白名单；skill 文件 rel 路径来自 `collectFiles` 的相对路径（不跟随 symlink、目录名不可能含 `..`），无法穿越。
- hook 命令注入：`shellQuote`（constants.ts:50-52）单引号转义覆盖 `'`；`EJDRONE_NODE`/`EJDRONE_CLI` 若含引号同样被转义；`${VAR}` 解析值只进文件、不进命令行；Windows 形态外层双引号不影响内层单引号提取（`parseHookPaths` 依赖，constants.ts:55-59）。
- `managedKeys` 信任模型：账本在成员自己机器上，成员改自己的账本 = 自担风险，与"本地改过不覆盖"的威胁模型一致；账本无跨成员共享面（每人独立）。规则 6"账本没有、文件里有 → foreign-entry 不覆盖"是防误领的正确默认（代价见 A-1）。
- `push --mcp` 凭据防线：`mcprepo.ts:283-317 externalizeSecrets`——env/headers 按键名后缀（TOKEN/KEY/SECRET/PASSWORD）+ 凭据 header（Authorization 类）+ token 形状正则改写 `${VAR}`；command/args/url 里带凭据的一律拒绝入库并给手写形状示例；拒绝时把可疑字段整个摘掉防调试输出泄漏。**局限（设计内取舍）**：不像 token 的高熵值（无后缀键名 + 不匹配正则，如 40 位 hex）会放行入库——缓解是 MR 正文强制复审文案（push.ts:439-441："请评审时再确认一遍：仓库里不该有明文 token"）与团队 README 禁令。建议维持现状（熵启发式误报会把正常配置也改掉），最多在 MR 模板补一句"高熵字符串也请人工过目"，零成本。
- MR 外发内容的面：外发的仅团队仓库文件 + 标题/正文（资源名、来源路径、namespace），无任何已解析值；generic provider 只打印手动指引；token 不进 MR 字段。**无越界。**

---

## 六、Windows 代码层专项（未真机验证，按"真机上最可能出问题"排序）

总判定：platform.ts 四函数 + constants.ts + doctor 三条 + ledger 两处 + mcpfmt 委派的**代码层质量高、注入式单测覆盖到位**；但 Windows 真机全流程（T10.4 后半 / T10.7）未执行（[环境]：资源前置不具备，m10-trial.md §4 已登记）。以下按未验证风险排序：

**W-1［真缺陷 · P1］findGitBash 候选集缺 per-user 安装路径（逻辑确证，无需真机即可判定会漏）**
- **位置**：`src/platform.ts:33-46`。候选只有 `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`、注册表 `HKLM\SOFTWARE\GitForWindows`。
- **风险**：非管理员运行的 Git for Windows 安装器默认装到 **`%LOCALAPPDATA%\Programs\Git`**，注册表写在 **`HKCU\SOFTWARE\GitForWindows`**——两条都没查。企业电脑（员工无管理员权限）极常见此形态 → findGitBash 返回 null → hookCommand 返回 null → init 对全部工具不装 hook 并提示"需要安装 Git for Windows"——**误报**（其实装了）。手动 pull 不受影响，但"会话自动 pull"这条主价值链在该成员机器上静默缺失。未真机验证，但路径逻辑是确定的。
- **建议**：候选加 `join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')`；`reg query` 在 HKLM 失败后补一次 HKCU。各加一条注入单测。

**W-2［真缺陷 · P1］apply.ts merge 写路径的 rename 覆盖**——即稳定性 S-1，Windows 风险排序第 2：落点文件必然存在，失败即 MCP 全线不可用。修法同 S-1（一行替换 + 单测）。

**W-3［未验证 · P2］hook 命令形态在真实工具 shell 下的执行**
- **位置**：`src/cli/constants.ts:32`：`"<gitbash>" -lc "EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent"`。
- **风险**：外层双引号对 cmd.exe 友好（已论证），但**各工具用什么 shell 执行 hook 命令未核**：若某工具经 PowerShell 起原生 exe，PowerShell 5.1 对含空格双引号参数的拆串是经典坑；若经 `sh -c`，则内层单引号形态要重新验证。doctor 的 `win:hookbash` 只验 bash 文件存在，验不了"命令能否跑通"。未验证。
- **建议**：遗留项清单（m10-trial §4）加一条"真机上每种选定工具开一次会话，确认 hook 真的触发了一次 pull（debug.log 有新条目）"；在拿到真机前不给这条打保票。

**W-4［真缺陷 · P2］uninstall 的 `startsWith(root + '/')` 在 Windows 永不命中 + 非原子写**
- **位置**：`src/cli/uninstall.ts:194`：`entry.path.startsWith(root + '/')`——Windows 上 ledger 路径与 root 都由 `join()` 生成（`\` 分隔），`root + '/'` 永远匹配不上 → `touchedRoots` 恒空 → "留下空目录"提示在 Windows 上静默消失（功能损失小，但是确证的平台硬编码散落点，正是 AGENTS.md 收口规则想防的）。同文件两处裸 `writeFileSync` 的原子性/一致性问题见 S-2。
- **建议**：`startsWith(root + '/')` 改为基于 `relative()`/`samePath` 的目录包含判断（dirclean.ts:4-8 与 common.ts:52-55 已有现成写法）；原子写随 S-2 一起修。

**W-5［未验证 · P3］其余 win32 分支逐个评估**：
- `whichWithPathext`（platform.ts:101-123）：逻辑审读通过（PATHEXT 大小写三变体、`\`/`/` 直探分支、目录同名不算命中）。未验证点：真实 Windows 上 `process.env` 的键大小写由 Node 代理归一，注入测试是普通对象——`envGet` 双路径已覆盖两者，风险低。
- `samePath`（platform.ts:179-183）：小写化 + 斜杠归一，不做 realpath/8.3 短名归一；账本路径全部同源生成（同一次 join），实际一致，风险低。
- `replaceFileSync`（ledger.ts:100-109）：unlink 失败不吞错、交给 rename 自己报错，正确。
- doctor `win:*` 三条（doctor.ts:368-423）：win:gitbash / win:git / win:hookbash 的出现条件与状态机审读通过；未验证点是 `reg query` 输出的本地化（正则依赖 `InstallPath\s+REG_SZ` 字面列头，非英文 Windows 的 reg.exe 输出列头行为未证）。
- e2e 夹具 win32 适配（test/integration/helpers.ts）与 T10.4/T10.7 全流程：已登记遗留，本评审不计入缺陷。

---

## 七、最值得修的 TOP 5（按优先级排序，各附预估工作量）

| # | 优先级 | 事项 | 位置 | 预估工作量 |
|---|---|---|---|---|
| 1 | **P1** | merge 原子写改走 replaceFileSync：`renameSync(tmp, path)` → `replaceFileSync(tmp, path)`，补注入 `platform='win32'` 单测；同步更新 AGENTS.md 原子写枚举 | `src/core/apply.ts:243`（+ AGENTS.md:43-44） | 15 分钟 + 1 条用例 |
| 2 | **P1** | findGitBash 补 per-user 安装候选：`%LOCALAPPDATA%\Programs\Git\bin\bash.exe` + HKCU 注册表查询，各加注入单测 | `src/platform.ts:33-46` | 半小时 + 2 条用例 |
| 3 | **P2** | uninstall 两处裸 writeFileSync 改原子写（保持权限不回松）+ `:194` 的 `root + '/'` 硬编码改目录包含判断 | `src/cli/uninstall.ts:119/157/194` | 1-2 小时（含回归断言） |
| 4 | **P2** | sync.lock stale 回收前加 pid 存活探测（`process.kill(holder, 0)`，覆盖 Windows 语义），防"合法长 pull 被误判死锁"回到 1.0 交错写账本事故 | `src/cli/lock.ts:63-70` | 1 小时（含注入单测） |
| 5 | **P2** | doctor 账本 FAIL hint 对 merge 记账不成立：删账本前点名受管条目文件、按记账类型给指引，避免成员被引到"MCP 条目永久冻结"状态 | `src/cli/doctor.ts:343-344` | 半小时 |

**其余已登记的 P3 池**（随时可做，不阻塞）：saveLedger 补 0600（X-1）、AGENTS.md Windows 收口表述与 mcpfmt whichOn 去重（A-2）、uninstall 错误文案指错目录（M-2）、push.ts 格式卫生（M-3）、probe 字段显式化（M-4）、只读命令锁外 reset 补登记（S-4）、ledgerEntry  Map 索引（性能节，规模到万级文件前必须）。

## 八、总体结论

架构骨架（表驱动适配器 + resolve 纯函数 + ledger 记账 + KindSet 全总映射 + 停发≠清空不变量）在当前版本**成立且干净**，冻结契约无绕过，安全红线（token/0600/路径/注入/MR 面）整体落实，稳定性原则（先算后写、幂等、坏文件停发）遵守良好。缺陷集中在**两个"最后一公里"**：① M10 的 Windows 修复覆盖不全（第四条原子写、per-user Git 路径、uninstall 分隔符）；② M6 引入的 merge 记账在边角流程（uninstall 原子性、账本丢失恢复指引）里没有被同等对待。均为把已实现功能做完整的修复，无一项需要新能力或触及 M7/M8/M9。按 TOP 5 顺序修完，Windows 代码层与 MCP 信任模型的残留风险即可从"未验证的未知"收敛为"已修复的已知"。

---

*评审方法附注：本报告所有行号引自当前工作树；性能数字为基于代码路径的推演量级（O(W²) 查找、每 pull 8 个 git 子进程、稳态 0 写盘），已在 15-25 人团队量级给出明确判定；Windows 各项凡未真机验证者均已显式标注，未以 POSIX 测试冒充 Windows 结论。*
