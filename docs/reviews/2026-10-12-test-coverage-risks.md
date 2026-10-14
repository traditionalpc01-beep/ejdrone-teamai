# ejdrone-teamai 测试覆盖与风险排查（2026-10-12）

> 评审人：严过关（QA）· 立场：只读评审，未改动仓库任何文件
> 对象：当前工作树（17 修改 + 5 新增，即 M10 代码层落地后的"当前版本"）
> 基线：typecheck 0 错误；vitest 我亲自复跑——沙箱内 4 个集成用例假失败（mkdir 被拦 / 20s 超时），
> `dangerouslyDisableSandbox=true` 重跑该 4 个文件 **169/169 全绿**，与协调者口径 704/704 一致。
> 验证手段：读码；既有测试定位；/tmp 探针（tsx 直跑 TS 源码，未写仓库）。

---

## ① 覆盖矩阵（关键路径 × 测试 × 级别 × 强度）

图例：强度 ★=仅存在性/形状，★★=主要行为，★★★=边界与失败路径全覆盖。

| 关键路径 | 有无测试 | 测试级别 | 强度 | 说明 |
|---|---|---|---|---|
| 16 工具投递落点 + 幂等 | 有 | e2e（all-tools.test.ts 132 行）+ 单测（suite.ts 表驱动六项 ×16） | ★★ | 全 16 工具走一遍全链路：落点、二次 pull 零写入、账本不越界。**深度行为只深测 claude/codex/qoder-cn 三个代表**（lifecycle/mcp e2e）；其余 13 个的深度保证 = suite.ts 公共六项（注册信息/detect/planSkills 多文件/planRules 按表/planMcp 恒发一条/ownsPath/hook 装卸）+ 各自特例文件（dsh 的 DSH_HOME、pi 的多级 skills、trae-cn 的 user_rules 等）。表驱动能抓住"表填错"，抓不住"表对但工具真不读这个目录"——那正是 PROBE 机制与 doctor WARN 的职责 |
| rulesdir 模式（5 工具） | 有 | 单测（adapters.test.ts 逐字节 verbatim）+ e2e 浅层 | ★★★ | 原文照抄含 frontmatter，逐字节断言 |
| mdc 模式（cursor） | 有 | 单测（frontmatter 重写、paths→globs、正文逐字节、缺 frontmatter 回落）+ e2e 浅层（alwaysApply+内容含） | ★★★ | 单测深；e2e 只验落点存在与内容含关键串 |
| block 模式（codex/copilot/opencode/dsh） | 有 | 单测（合并顺序、空规则清空、区域替换不外溢）+ e2e（lifecycle 的 codex 区块更新、review-fixes 的停发不清空、孤儿标记） | ★★★ | 停发语义有专项 e2e，是三个模式里 e2e 最深的 |
| rules=none（6 工具） | 有 | suite.ts 断言 planRules 返回 [] + all-tools 断言不造 rules/AGENTS.md | ★★ | "不硬写"是被测的 |
| MCP json-mcpServers 形态 | 有 | e2e 深（mcp.test.ts：成员条目共存、幂等、停 ns 撤条目、改过不覆盖、缺变量、qoder-cn 同文件双写路径）+ 单测（apply/merge/mcpfmt 逐字节） | ★★★ | 真机试验（M6 trial） additionally 逐字节还原过 22KB 真实 ~/.claude.json |
| MCP toml-codex 形态 | 有 | e2e 深（同上，codex config.toml：成员手写表/注释/.env 子表不动）+ 单测（异形 12 例、块自校验、插入点空行） | ★★★ | 异形跳过（宁可不投）有 12 个形状用例 |
| MCP json-opencode 形态 | 有 | **仅单测**（mcpfmt 逐字节 + merge 对接） | ★★ | 无 e2e；opencode 落点本身是 PROBE（本机未装） |
| MCP json-copilot 形态 | 有 | **仅单测**（mcpfmt 逐字节 + merge 对接） | ★★ | 无 e2e；copilot 落点是 PROBE |
| merge 六条规则 | 有 | 单测（merge.test.ts 484 行，JSON/TOML 各六条 + force 口子 + 账本忘账 + 同名不覆盖） | ★★★ | 逐条有用例；**但所有夹具都是 LF 文件，零 CRLF 用例**（见缺陷 D4） |
| ${VAR} 解析 | 有 | 单测（mcp.test.ts）+ e2e（SENTINEL 不出现在 pull 输出） | ★★★ | 含"连续调用三次一致"钉住 VAR_RE lastIndex 陷阱 |
| 缺值跳过 | 有 | e2e（mcp.test.ts：点名变量名与 server 名、不写空值、退出码 0）+ doctor mcp:var WARN | ★★★ | |
| 已解析值不进任何输出 | 有 | e2e（SENTINEL 断言）+ 单测（错误文案不含值）+ 真机（M6 trial §2-6：五路输出 + ~/.ejdrone 全目录 grep 0 命中） | ★★★ | M10 未改这些输出路径，哨兵纪律仍成立（我读码复核 list/status/pull/debug.log/ledger 六处出口，均只有名字/变量名/路径/哈希） |
| 双 ns 同名停发 ≠ 清空 | 有 | 单测（plan.test.ts haltedKinds）+ e2e（review-fixes：codex 区块一字不动；mcp.test.ts：mcp 整体停发已装条目逐字节不动） | ★★★ | "停了当删除"这个历史事故有专项回归 |
| 坏 mcp.yaml 整体停发 | 有 | e2e（mcp.test.ts：退出码、已装不掉）+ doctor mcp:parse FAIL | ★★★ | |
| manifest 坏全量停发 | 有 | e2e（failure.test.ts：停发/doctor FAIL/--silent 恒 0/修复后恢复） | ★★★ | |
| ledger 1.0 旧格式（无 managedKeys） | 有 | 单测（ledger.test.ts 独立用例，钉住"缺=空集、不回落空账本"） | ★★★ | 注释写清了回归严重性 |
| 锁竞争 | 部分 | e2e（review-fixes：持锁时静默跳过/交互报错；push 期间 pull 插不进来） | ★ | **只覆盖"锁被正常持有"**；stale 回收竞争、时钟跳变、release 误删全无测试（见缺陷 D5） |
| 卸载逐字节还原 | 部分 | e2e（failure/mcp：内容级断言）+ 单测（hooks 格式回环：4 空格无结尾换行 / 2 空格有结尾换行 两种 canonical 形状） | ★★ | 测试是内容级/ canonical 形状级；**逐字节只在真机试验做过**（且真机文件恰为 canonical LF 形状）。CRLF / 行内紧凑 JSON / Tab 缩进会变形（见缺陷 D4/D8） |
| doctor 各检查项 | 有 | 单测（doctor.test.ts：win: 三条 × 平台注入 + POSIX --json 零变化）+ e2e（hook FAIL/WARN、mcp 四项、manifest FAIL） | ★★★ | 退出码判据（fails>0）有覆盖 |
| Windows 注入分支 | 部分 | 单测（platform.test.ts 四函数纯函数注入；constants.test.ts 命令串逐字符；doctor.test.ts 平台注入） | ★★ | **算有效覆盖，但只覆盖 platform 层自身**：它证明"收口层函数在注入 win32 时行为对"，证明不了"调用方在 win32 上行为对"——apply.ts 的原子写没有 platform 参数也不经收口层，注入技巧根本够不着它（见缺陷 D1/D2）；merge.ts 的 \r\n、uninstall.ts 的 '/' 硬编码、doctor 的 `!==` 同理（D3/D4/D6） |
| apply 渲染抛错零落盘 | 有 | 单测（apply.test.ts：未知 format 抛出时同计划普通 write 一次都不落盘、无临时文件残留） | ★★★ | "先算完整 plan"原则有专项 |
| push/mcpscan/mcpcollect 凭据自动改写 | 有 | 单测（mcp-commands.test.ts：键名后缀/Authorization/已是占位符/command-args-url 拒绝/普通 env 不动/同名变量沿用）+ e2e（值不出现在输出与仓库） | ★★★ | 判据边界（URL 内联口令等）属设计取舍，见缺口 G9 |
| 原子写（config/ledger/hook settings） | 有 | 单测（ledger.test.ts replaceFileSync win32 注入覆盖已存在 target；state 0600 覆盖回归；hooks atomicWrite 连续两次） | ★★★ | 注入能跑到 win32 分支（unlink 再 rename），但 macOS 上复现不了"rename 覆盖失败"本体——那是 AGENTS.md 记录的真机经验 |

### "改了没人管"的高风险路径（无测试或弱测试的关键路径）

1. **apply.ts 的 win32 写路径（D1/D2）**——MCP 投递在 Windows 上必然抛错，而注入式单测够不着它，真机验证又没做。这是当前版本最高风险的无人管路径。
2. **merge.ts 的 CRLF 路径（D4）**——484 行 merge 测试零 CRLF 夹具；Windows 成员文件（尤其 codex config.toml、某些编辑器写的 settings.json）天然可能 CRLF。
3. **lock.ts 的 stale 回收与 release（D5）**——只有"锁被正常持有"一条 e2e；休眠唤醒/时钟跳变 + release 误删这条链零覆盖。
4. **doctor 的 hook cli 同一性判定（D3）**——`!==` 比较无大小写/斜杠变体用例；M10 给 ledger 换了 samePath，这处漏了，也没人测。
5. **uninstall.ts 的空目录报告（D6）与 merge 撤条目的非原子写（D7）**——前者 win32 下静默失效，后者进程中断留半写文件，均无用例。
6. **13 个非深测工具的"工具真不真读这个目录"**——靠 PROBE + doctor WARN 兜底，是设计取舍而非缺陷，但意味着"表填错了方向"只有真机能发现。
7. **dirclean.ts 空目录回收**——无直接单测，只被 lifecycle 的"团队删除"间接覆盖。

---

## ② 疑似/已复现 bug 清单

> 性质标注：【设计内有意】= 查得到文档依据；【真缺陷】= 与文档/自身硬规则矛盾；【存疑】= 未完全复现或依赖外部条件。
> 每条四要素：位置 / 复现方式或已验证证据 / 影响范围 / 优先级与建议。

### D1 【真缺陷 · P0】apply.ts 的原子写没用 replaceFileSync——M10 漏网的第四处

- **位置**：`src/core/apply.ts:236-254`（`atomicWriteWithMode`，第 243 行 `renameSync(tmp, path)`）。
- **证据**：全仓 `renameSync` 调用点只有 4 处（grep 实证）：`ledger.ts:108`（replaceFileSync 内部）、`state.ts:117`、`hooks.ts:99`、`apply.ts:243`。前三处都走 `replaceFileSync`（win32 先 unlink 再 rename），唯独 apply.ts 自己写了一份。AGENTS.md 硬规则原文："三处原子写（state.ts saveConfig / hooks.ts atomicWrite / ledger.ts saveLedger）统一走 ledger.ts 导出的 replaceFileSync：win32 先删已存在目标再 rename（规避 rename 覆盖不可靠）"——apply.ts 这份原子写不在名单里，而 M10 试验记录 §3 第 5 行登记"三处原子写…已修复"，同样漏了它。`replaceFileSync` 的注释写明了 win32 rename 覆盖已存在文件会 EPERM/EACCES（目标被占用/权限姿态/杀毒扫描窗口）。merge 投递的 target（~/.claude.json、~/.codex/config.toml）**必然已存在**（那是成员在用的共享文件），所以这条路径在 win32 上每次都踩着不可靠分支。
- **影响范围**：Windows 上所有 MCP 条目级合并投递（首投/更新/撤条目）。skills/rules 走普通 writeFileSync 不受影响。macOS/Linux 零影响（POSIX rename 原子覆盖）。
- **优先级**：P0（对"Windows 全功能可用"这一当前版本宣称的能力是阻塞级；M10 真机未跑所以没暴露）。
- **建议**：`atomicWriteWithMode` 改用 `replaceFileSync(tmp, path)`（ledger.ts 已导出，POSIX 行为逐字节不变）；按 `test/core/ledger.test.ts` 的注入方式补一条 win32 覆盖已存在 target 的用例（apply 层现在没有 platform 注入点，收口后自然获得）。

### D2 【真缺陷 · P0】apply.ts 的 tmp 命名只按 '/' 切分——win32 上拼出含 ':' 的非法文件名，先于 D1 抛错

- **位置**：`src/core/apply.ts:240`（`join(dirname(path), \`.${basenameOf(path)}.ejdrone-tmp-${process.pid}\`)`）+ `apply.ts:256-259`（`basenameOf` 只 `path.split('/')`）。
- **证据**（探针 1b，path.win32 语义实算）：目标 `C:\Users\dev\.claude.json` 没有 '/'，`basenameOf` 原样返回整串，tmp 拼成 `C:\Users\dev\.C:\Users\dev\.claude.json.ejdrone-tmp-1234`——':' 出现在位置 15（盘符 colon 之外），是 Windows 非法文件名字符，`writeFileSync(tmp)` 直接 EINVAL。对照：`hooks.ts`/`ledger.ts`/`state.ts` 的 tmp 命名是 `${path}.tmp-${pid}`（整串做文件名，':' 留在目录段，合法）——apply.ts 是唯一把 basename 拼进文件名前缀的。探针 4 进一步证实：POSIX 上反斜杠是合法名字字符，所以这条代码在本机 silently 通过（tmp 名丑陋但合法），任何 CI/单测都抓不到。
- **影响范围**：同 D1 且更靠前——win32 上只要本次 merge 有字节要写（首投/更新/撤条目），pull 在第一个 MCP 能力工具上抛错 → pull 报"投递过程中出错"、退出码 1、**ledger 不保存**（saveLedger 在 applyPlan 之后），下次 pull 重演；该适配器之前的 skills/rules 已落盘但没记账。等于 Windows 上 MCP 功能完全不可用。
- **优先级**：P0。
- **建议**：`basenameOf` 换 `basename()`（node:path，平台感知），或干脆学 ledger.ts 用 `${path}.ejdrone-tmp-${pid}` 整串命名；与 D1 一并修后补一条"路径含反斜杠/盘符时 tmp 名合法"的单测（POSIX 上可用字面反斜杠文件名构造，见探针 4 手法）。

### D3 【真缺陷 · P2】doctor 的 hook 入口同一性判定还在用 `!==`——M10 给 ledger 换了 samePath，漏了这处

- **位置**：`src/cli/doctor.ts:303`（`paths.cli !== currentCliEntry(ctx.env)` → WARN"hook 指向另一份安装"）。
- **证据**（探针 2，真实调用 doctorCommand）：同一份文件、两种大小写路径（大小写不敏感文件系统上都存在且可读）→ doctor 输出 `hook:claude: WARN …指向另一份安装…与当前运行的 ejdrone 不是同一份`；而 `samePath(a, b, 'win32')` 判 true。`src/platform.ts` 的 samePath 注释原文："doctor 判「同一路径」必须走这里"——M10 把 ledger 比较改了（ledger.ts:113 `ledgerEntry` 走 samePath，还有专用回归用例），doctor 这条漏改。
- **影响范围**：Windows 上 hook 路径大小写/斜杠形态不一致时（npm 全局目录大小写差异、EJDRONE_CLI 与 realpath 形态差异、`C:\...` vs `C:/...`），doctor 误报"另一份安装"，引导成员去重跑 `init --force`（重装 hook）——修一个没坏的东西，且真实的"确实指向旧安装"被这类噪音稀释。仅 WARN，不阻塞。
- **优先级**：P2。
- **建议**：`!==` 改 `!samePath(paths.cli, currentCliEntry(ctx.env))`；补一条平台注入的大小写/斜杠变体用例（macOS 大小写不敏感 FS 上就能构造，探针 2 即是手法）。

### D4 【真缺陷 · P2】merge.ts 对 \r\n：JSON 整文件被改成 LF，卸载逐字节还原在 Windows 不成立；TOML 出现混合行尾

- **位置**：`src/core/merge.ts`——JSON 侧 `renderJson`（110-113 行，`JSON.stringify` 只产 `\n`；`detectJsonFormat` 只探测缩进与结尾换行，不保留 CRLF）；TOML 侧插入块用 mcpfmt 产出的 LF 文本（`emitInserts` 646-660 行）。
- **证据**（探针 3，直接调 mergeEntries）：
  - 3a：CRLF 的 `~/.claude.json` 投递一条 server → 整文件变 LF；再撤条目 → 文件是 LF，**与原 CRLF 文件逐字节不相同**。即"卸载逐字节还原"（M6 trial §2-8 的真机结论、AGENTS.md 的安全承诺）对 CRLF 成员文件不成立。成员内容不丢，但每次投递都会把成员的 CRLF 文件整体翻成 LF——对"只动我们那几条"的承诺是可见的越界（设计文档 §3.3 规则 4 的"连注释与表序都逐字节不变"在 JSON 侧本就只到"键序/格式化抖动不算改过"为止，见 2.0 计划 §7 偏差登记"整文件重排不可避免"——但那条登记没提行尾，CRLF→LF 是比"重排"更刺眼的变形）。
  - 3b：CRLF 的 config.toml 投递 → 成员原有行保持 `\r\n`，我方块是 `\n`，**混合行尾**；撤条目后原文件结尾的空行被吃一个、残留悬空 `\r`（`...own"\r\n\r`）。TOML 块匹配本身对 CRLF 鲁棒（`classifyTomlLine` 先 trim），幂等不破。
- **影响范围**：Windows 成员（或任何用 CRLF 编辑器的成员）的 MCP 落点文件。卸载/停投后文件回不到原样；JSON 文件每次 pull 都重写全文件行尾。
- **优先级**：P2（Windows 相关；内容不丢；但直接打击"逐字节还原"这一信任卖点）。
- **建议**：短期在 README/试验记录登记"JSON 落点会被规范成 LF"；根治则 `detectJsonFormat` 增加 `crlf` 探测、render 后按原行尾渲染（JSON.stringify 产物 `\n`→`\r\n` 替换即可，TOML 侧我方块按文件行尾渲染）。补 CRLF 夹具的 merge 单测（现在 484 行零 CRLF）。

### D5 【真缺陷 · P2】lock.ts：stale 回收后，原持锁人的 release() 会删掉新持锁人的锁——互斥失效

- **位置**：`src/cli/lock.ts`——`isStale`（63-70 行，`Date.now() - mtimeMs > STALE_MS`）与 `acquireLock` 返回的 `release()`（36-43 行，闭包 `unlinkSync(path)`，**不校验锁文件是否还是自己当年创建的那份**）。
- **证据**（探针 6，单进程按真实时序复现）：造一个 10 分钟前的锁（模拟进程 A 持锁期间机器休眠/时钟跳变）→ B `acquireLock` 判 stale、回收、新建（B 合法持锁）→ A 的 `release()` 闭包执行 `unlinkSync(path)` → **B 的锁文件被删** → C `acquireLock` 畅通拿到锁。B、C 双持锁，正是这把锁要防的"交错 load/saveLedger 丢账本"场景。代码注释自己也承认了这个语义（"已被 stale 清理或别的进程拿走，不该再把别人的锁删掉"）——但 unlink by path 无法区分，注释描述的是意图不是行为。
- **影响范围**：需要 >5 分钟的 pull/MR 卡顿或时钟跳变（休眠唤醒会让 `Date.now()` 前跳而 mtime 不变 → 活锁被判 stale；夏令时不直接影响 epoch，但 NTP 校时/休眠会）+ 后续两个并发进程。概率低，后果是设计文档记载过的"记账丢失、文件再也更新不进去"。
- **优先级**：P2（边缘条件，但失效模式是该模块存在的原因；且时钟跳变在笔记本休眠场景下并不罕见）。
- **建议**：`release()` 前读锁文件确认 holder 仍是自己的 pid（`readHolder(path) === String(process.pid)` 才删）；或锁文件内容改存 `pid+创建时间戳`、release 只删匹配的那把。补一条"stale 回收后旧 holder release 不动新锁"的单测（探针 6 即是手法，纯 fs 操作可在单测里跑）。mtime stale 的时钟跳变属设计取舍（5 分钟回收），可配合 release 校验把后果从"互斥失效"降级为"可见竞争失败"。

### D6 【真缺陷 · P3】uninstall.ts 空目录报告用 `root + '/'` 硬编码分隔符——Windows 上永不触发

- **位置**：`src/cli/uninstall.ts:194`（`removed.some((entry) => entry.path.startsWith(root + '/'))`）。
- **证据**：读码 + 对照。win32 上 `entry.path` 与 `root` 都是反斜杠形态（test/integration/all-tools.test.ts:112 特意用 `sep` 拼前缀并注释"win32 下硬拼 '/' 会让 startsWith 假阴性"），`root + '/'` 永远匹配不上 → `touchedRoots` 恒空 → "留下空目录（可能是我们建的）"提示在 Windows 上消失。同类问题 M10 的 T10.3 任务清单里点名过要替换 `/` 硬编码，这处漏了。
- **影响范围**：仅提示文案缺失，不伤数据。POSIX 零影响。
- **优先级**：P3。
- **建议**：改 `root + sep`（或复用 delivery 的 under() 思路）。

### D7 【真缺陷 · P3】uninstall 撤 MCP 条目用非原子 writeFileSync——进程中断留半写共享配置文件

- **位置**：`src/cli/uninstall.ts:119`（`writeFileSync(entry.path, outcome.text, 'utf8')`）。
- **证据**：读码。pull 侧同类写走 `atomicWriteWithMode`（tmp+rename），uninstall 侧直接覆写成员的 `~/.claude.json` / `config.toml`；进程在写中途被杀（断电/用户 Ctrl-C/崩）会把成员的共享配置截断成半份——那是成员每天在用的文件。AGENTS.md"半写文件不允许存在"的原则在 apply.ts 有实现，在 uninstall 这条路径上没贯彻。
- **影响范围**：卸载过程中被中断的成员；概率低，后果是成员配置文件损坏（可从工具侧恢复或团队成员文件备份，但体验极差）。
- **优先级**：P3。
- **建议**：改用 `atomicWriteWithMode`/`replaceFileSync` 同款原子写（权限按原文件保持，uninstall 不涉及 0600 收紧）。

### D8 【设计边界 · P3】字节级还原只对 canonical JSON 形状成立；hooks 侧未登记该偏差

- **位置**：`src/hooks.ts` 的 `load/render`（52-106 行）与 `src/core/merge.ts` 的 `detectJsonFormat/renderJson`。
- **证据**（探针 5）：成员 settings.json 只要含**行内紧凑子对象**（`{ "matcher": "*", "hooks": [...] }` 写在一行）、Tab 缩进、或 CRLF，upsert→remove 回环后文件被规范化成 2 空格 LF 多行——内容一字不丢，字节全变。既有 hooks.test.ts 的"格式回环"用例之所以通过，是因为夹具本身就是 canonical 展开形状。这与 M6 偏差表登记的"JSON 整文件重排不可避免"同类，但那条登记挂在 MCP 名下，hook settings 的回环承诺（"卸载后逐字节回到原样"）没登记这个边界。
- **影响范围**：成员文件格式非 canonical 时，卸载后字节有差（内容无损）。macOS 真机试验过的文件恰为 canonical，所以没暴露。
- **优先级**：P3。
- **建议**：在 AGENTS.md 或试验记录里登记"字节级还原以 canonical JSON 形状为前提"；或 render 前对紧凑子对象做保形（成本高，不值得）。

### D9 【设计边界 · P3】TOML 删块吃掉一个结尾换行 / 留悬空 `\r`

- **位置**：`src/core/merge.ts:662-684`（emitInserts/删除块的空行折叠逻辑，672 行"被删块前后的空行会叠成两个：尾随空行吃掉一个"）。
- **证据**（探针 3b）：成员文件以空行结尾时，撤掉我方块后文件少一个结尾换行（LF 文件 `...own"\n\n`→`...own"\n`；CRLF 文件残留悬空 `\r`）。既有测试不断言这个（只断言不出现 `\n\n\n`）。
- **影响范围**： cosmetic；编辑器无感。但"逐字节还原"差一个字节。
- **优先级**：P3。
- **建议**：随 D4 的 CRLF 整改一起看；或登记为已知边界。

### 非缺陷清单（查过文档，对得上，不建议改）

| 现象 | 依据 |
|---|---|
| doctor hook 检查分 FAIL（入口不存在）/WARN（另一份安装）两层 | 1.0 §14 终审修掉的缺陷登记 |
| `--force` 不覆盖 region/merge 投递 | pull.ts:29 FORCE_IGNORED + AGENTS.md |
| opencode `environment` 只列变量名不列值 | mcpfmt.ts:113 注释（opencode 自己的形状） |
| 权限只收紧不回松，卸载后 ~/.claude.json 留 0600 | 2.0 §7 偏差登记行 |
| 坏 mcp.yaml 停发 ≠ 当空集清空 | §3.3 + AGENTS.md 硬规则 |
| `status` 把本机私有 server 列"待推送" | §7"措辞可再议"登记 |
| TOML 落点不做反向采集 | M6 trial §4 + §7 |
| 成员文件畸形键（mcpServers 套 mcpServers）被当条目列出 | M6 trial §4（只读不解释） |
| codex `[mcp_servers.*.http_headers]` 是否被 Codex 读取未证 | PROBE 机制（paths.ts:115） |
| 双进程同时发现 stale 并清理 → 一方可见失败、不丢数据 | 我读码推演 + e2e 持锁用例：EEXIST 重试后新锁 mtime 新，竞争方拿到 ok:false，结局安全 |
| mtime stale 在时钟跳变下的误判/漏判 | 5 分钟 stale 是设计取舍；真正可修的是它的后果（见 D5） |

---

## ③ 测试缺口清单（按优先级）

| # | 缺口 | 优先级 | 建议补法 |
|---|---|---|---|
| G1 | **apply.ts win32 写路径零有效覆盖**（无 platform 注入点，注入技巧够不着） | P1 | 修 D1/D2 时把 `atomicWriteWithMode` 收口到 `replaceFileSync`，按 ledger.test.ts 手法补"覆盖已存在 target + 路径含反斜杠形态"用例；POSIX 上可用字面反斜杠文件名构造（探针 4） |
| G2 | **merge.ts 零 CRLF 用例**（484 行全 LF 夹具） | P1 | JSON/TOML 各补：CRLF 成员文件投递→幂等→撤条目回环；断言成员行 `\r\n` 不动、我方块行尾策略显式化 |
| G3 | **13 个非深测工具的深度行为只靠 suite 六项** | P2 | 维持现状可接受（表驱动 + PROBE + doctor），但建议把"每个工具的 rulesMode 分派 + mcpTarget 形态"在 all-tools e2e 里从"落点存在"升级为"内容形状断言"（mdc 的 frontmatter、block 的标记对、json-opencode/copilot 的 type/tools 键）——现在这四项只有单测 |
| G4 | **lock.ts stale 回收 / 时钟跳变 / release ownership 无用例** | P2 | 修 D5 后补：utimesSync 造旧锁→回收→旧 holder release 不动新锁→第三方拿不到 |
| G5 | **doctor hook cli 同一性判定无大小写/斜杠变体用例** | P2 | 修 D3 后补平台注入用例（探针 2 手法，macOS 大小写不敏感 FS 可直接构造） |
| G6 | **e2e 卸载断言是内容级，非逐字节级** | P2 | 在 canonical LF 夹具上补逐字节断言（hooks.test.ts 的回环手法可搬到集成层）；CRLF 逐字节归入 G2 |
| G7 | **uninstall merge 撤条目路径无测试**（含非原子写 D7） | P3 | 补"卸载撤条目后成员条目与格式不动"用例（现有 failure.test.ts 只覆盖整文件与区块） |
| G8 | **dirclean.ts 无直接单测**（空目录回收只被间接覆盖） | P3 | 补"多文件 skill 删除后空目录被收、非空目录不动、越界目录不动"三例 |
| G9 | **push --mcp 凭据启发式边界无用例**（URL 内嵌口令、description 带 token、非 token 形状的 API key） | P3 | 属设计边界（§7 登记"靠 MR 评审兜底"），建议补 2-3 个"不漏改写但也不误报"的钉服用例，并在 README 明说启发式判据 |
| G10 | **json-opencode / json-copilot 形态无 e2e** | P3 | 两个落点都是 PROBE，等真机销记后补 e2e；当前单测强度可接受 |

---

## 结论

- **当前版本质量基线属实**：704/704（我复跑确认，沙箱假失败已排除）、typecheck/build 通过的前置声明与事实一致。
- **已复现/读码确证的缺陷 5 个**：D1、D2（P0，Windows MCP 投递必然失败，且注入式单测结构性够不着、真机验证缺失，三者叠加导致漏到当前版本）、D3（P2，doctor 误报）、D4（P2，CRLF 卸载还原破产）、D5（P2，锁互斥边缘失效）；另 4 个 P3（D6-D9）。
- **M7/M8/M9 未实现是计划内的后续里程碑，不计入缺口。**
- 修复顺序建议：D1+D2 一并修（同一函数，收口 replaceFileSync + basename）→ D5 → D3 → D4 → 其余 P3 登记或随修。
