# ejdrone-skills 当前版本完整评审（综合报告）

> 日期：2026-10-12 · 主理人：齐活林（Qi）· 团队：许清楚（产品闭环）、高见远（工程质量）、严过关（覆盖与风险）、寇豆码（修复实施）
> 被评版本：1.0 上线态 + 2.0 M5/M6/M10 代码层（工作树未提交态）
> 明细报告：`2026-10-12-product-closure.md`、`2026-10-12-engineering-quality.md`、`2026-10-12-test-coverage-risks.md`
> 范围声明：仅评当前已实现功能；M7/M8/M9 未实现属后续里程碑，不计缺口。

---

## 第一部分 · 产品闭环评估

**总体结论：七步主旅程（建仓库 → init → hook 自动 pull → push/MR → 队友收到 → roles set → uninstall）全部闭合，无硬断点；问题集中在"静默"与"误导"两类软断点，其中 3 条 P1 已在本轮修复（见第三部分）。**

### 闭环总判定

| 旅程步骤 | 出口与反馈 | 测试背书 | 判定 |
|---|---|---|---|
| ① 管理员建仓库 | 空仓库 README 由首笔 MR 式变更 bootstrap | demo-trial 真机 + failure 用例 | 闭合 |
| ② 成员 init（交互/非交互） | 未探测到且无 --agent → 报错不猜 | interactive + lifecycle | 闭合 |
| ③ hook + 会话自动 pull | 无落点工具逐个给 reason；win32 无 Git Bash 逐个给安装指引 | lifecycle + all-tools + m5-trial | 闭合 |
| ④ push → MR → 合入 | token 缺失给重跑指引；generic 降级为手动指引不算失败 | lifecycle + mcp-commands + demo-trial | 闭合 |
| ⑤ 队友收到更新 | 保留逐条点名、坏 manifest 全量停发 + 退出码 1 | lifecycle + mcp + failure | 闭合 |
| ⑥ roles set | 未知角色提示仍写入（pull 告警） | lifecycle | 闭合 |
| ⑦ uninstall --force | 改过保留+点名、区块只撤标记内、MCP 反向合并 | failure 6 例 + m5/m6-trial 逐字节还原 | 闭合 |

### 场景覆盖：28 项核对，25 项闭环

关键场景全部有处理有反馈：16 工具 detect/PROBE、三类资源根+ns、双 ns 冲突停发、坏 mcp.yaml 整体停发（不当空集清空）、用户改过保留点名、缺 ${VAR} 跳过点名、foreign-entry 不覆盖、codex 跳过 sse、TOML 异形跳过、锁竞争、卸载区别对待、MCP 与 hook 同文件互不破坏。

### 缺口与阻塞点（评审原判 → 本轮处置）

| # | 位置 | 问题 | 性质 | 原优先级 | 处置 |
|---|---|---|---|---|---|
| F1 | `src/git/repo.ts` ensureClone | `init --force` 换仓库地址后本地 checkout 静默同步**旧**仓库（pull/push/doctor 全部作用在旧 origin 上，无提示） | 真缺陷 | **P1** | **已修复**：比对归一化 origin URL（凭据/尾斜杠/.git 等价），不一致 set-url 并经 snapshot.warnings 明说（R-C1） |
| F2 | `src/core/apply.ts` applyMergeWrite | 成员 MCP 配置损坏/异形时**静默不投**，违反 §3.3 规则 5 自定的"FAIL 级点名"；新成员场景 doctor 四项全绿 | 真缺陷 | **P1** | **已修复**：kept 点名 + pull 专属文案"配置无法解析…修好自动恢复"+ 退出码 1 + e2e 背书（R-A3） |
| F4 | `src/cli/doctor.ts` | doctor 对"双 ns 同名冲突"与"订阅角色不在 manifest"是盲区，与"出问题先跑 doctor"承诺相悖 | 真缺口 | P2 | **已修复**：复用 resolve()/activeNamespaces() 新增 `roles:conflict`/`roles:unknown` 两条 WARN（R-D3） |
| F3/M-2 | `src/cli/uninstall.ts:72` | hook 清理失败的"下一步"指向 `~/.ejdrone/<id>`（不存在） | 真缺陷 | P2 | **已修复**：改指 `target.path`（R-E4） |
| F5 | plan/resources/mcp.ts | 用户可见 warning 混出英文 | 真缺陷 | P2 | **已修复**：15 处中文化（R9） |
| F7/A-1 | `src/cli/doctor.ts:343` | 账本损坏 hint"删了重记"对 merge 受管条目不成立（照做会冻结成员的 MCP 条目） | 真缺陷 | P2 | **已修复**：hint 按记账类型分化，受管条目点名 + 冻结警告（R-D2） |
| F6 | 2.0 计划 §7 | 计划承诺 foreign-entry"--force 才动"但实现永不传 force | 计划-实现不一致 | P2 | **已登记**：§7 追加偏差行"暂不接"（R12） |
| F8 | M10 试验记录 | Windows 真机验证未执行 | 环境阻塞 | P1（阻塞 M10 验收） | 维持登记：机器到位后按 `docs/trials/2026-10-11-m10-trial.md` §4 补跑 |
| F9-F14 | 各处 | --silent 取舍、锁 5min 阈值、detect 误报、remove 语义、probe 机制、list 离线 | 设计内取舍/轻度 | P3 | 登记观察 |

### doctor 盲区收敛

修复前四个盲区：origin 不一致（→ ensureClone 修复后 doctor 诚实）、双 ns 冲突（→ roles:conflict）、未知角色（→ roles:unknown）、新成员+坏 MCP 配置（→ F2 修复后 pull 点名 + kept 语义）。"hook 装了但工具不执行"与"silent 期特有失败"仍属 PROBE/日志层边界，已登记。

---

## 第二部分 · 软件工程质量评审

**总体结论：架构骨架（表驱动适配器 + resolve 纯函数 + ledger 记账 + KindSet 全总映射 + 停发≠清空不变量）成立且干净；冻结契约无绕过（全仓零 as any/@ts-ignore）；安全红线（token 不回显、0600、路径白名单、注入面、MR 外发面）落实。缺陷集中在两个"最后一公里"——M10 Windows 修复覆盖不全、M6 merge 记账的边角流程——已全部修复。**

### 架构与可维护性（高见远）

- 16 适配器零重复零 if（24-26 行组装体）；rules 三模式与 MCP 四形态按表分派两处；`resolve()` 全文零 IO。
- Windows 收口：5 处平台分支中 4 处为薄委派；`mcpfmt.whichOn` 曾保留第二份 POSIX 实现（A-2）——**已收口为无条件委派**（R7）。
- 复杂度峰值 `merge.ts` 788 行（TOML 状态机），有表驱动测试 + 真机逐字节验证兜底；doctor.ts 486 行可按检查族拆分（P3）。
- 注释失真三处（M-1/M-2/M-3）——M-2 已修（E4），M-1 已随原子写枚举更新（R11），M-3（push.ts 格式）登记 P3。

### 性能（高见远，量化判定）

- 每次 pull 8 个 git 子进程（固定 0.3-1.2s，网络主导）；投递计算 O(W×L)≈O(W²)（ledgerEntry 线性查找）。
- 15-25 人团队量级（单人投递集数百文件）：亚秒~2s，**完全可接受**；劣化触发点 = 单人投递集 >1 万文件（症状：hook pull 升至 5-8s）。
- 根治方案（Map 索引）已登记为"万级文件前必须做"，本轮不做（规模未到）。

### 稳定性与安全

- "先算完整 plan 再落盘"、二次 pull 幂等、坏文件停发降级：遵守良好，测试+真机双背书。
- 四处原子写中 apply.ts 曾漏网（S-1/W-2/D1）+ 临时文件名 win32 非法（D2）——**已修复**（R-A1/A2）。
- uninstall 两处裸写共享配置（S-2/D7）——**已修复**（R-E1/E2）。
- lock 的 stale 误抢活锁（S-3/D6）与 release 不验归属（D5）——**已修复**（R-F1/L2，pid 存活探测 + 归属校验，测试 4 例）。
- 安全：token/0600/路径/注入/MR 面全部确认通过；ledger 0644 缺口（X-1）——**已修复**（R-G1，与 saveConfig 对齐 0600）。

### Windows 代码层专项（未真机验证项按风险排序）

| 项 | 风险 | 处置 |
|---|---|---|
| W-2/D1+D2 apply.ts 写路径 win32 崩溃 | **P0**（Windows MCP 功能完全不可用：临时文件名含冒号 EINVAL 先于 rename 覆盖失败） | 代码已修（R-A1/A2 改走 `replaceFileSync` 与按平台切分的 `basename`）。**2026-10-13 Windows 真机已结算**：`test/core/apply.test.ts` 末尾新增 `runIf(win32)` 两条直接哨兵（写已存在的共享配置文件成功且无临时文件残留；带 ledger 串起来的反复覆写真的走到 rename 覆盖那一环），在 Windows 10 真机上通过；全量 891 例绿。原文「该分支无任何测试覆盖」的成因（POSIX 进程里 `basename` 在 import 期绑定、构造不出 Windows 路径形态）依然成立，所以这两条只在 win32 主机上执行，POSIX CI 上为空跑 |
| W-1/D3+Q2 findGitBash 漏 per-user 路径 | **P1**（非管理员安装的 Git for Windows 被误报未装） | **已修复**（LOCALAPPDATA + HKCU，R-B1 + 2 测试） |
| D3 doctor cli 归属误报 | P2 | **已修复**（samePath，R-D1 + darwin/win32 差分测试） |
| D4 merge.ts CRLF 破坏逐字节还原 | P2 | **已修复**（JSON/TOML 行尾探测与还原，R-L1 + 3 测试） |
| W-4/E3 uninstall 分隔符硬编码 | P2 | **已修复**（relative 包含判断，R-E3） |
| W-3 hook 命令在真实工具 shell 下的执行 | 未验证 | 登记遗留（trial doc §4 追加） |

### 测试覆盖（严过关）

- 725 个用例（修复前 704）：rules 四模式、merge 六规则、${VAR} 哨兵、停发语义、ledger 1.0 兼容、卸载逐字节还原覆盖充分（★★★）。
- 本轮补齐的高价值缺口：merge CRLF 用例 ×3、lock stale/release 用例 ×4、doctor samePath 差分/账本 hint/roles 检查用例 ×6、ensureClone relink 用例 ×2、findGitBash per-user 用例 ×2、MCP 第二工具 e2e、坏配置点名 e2e。~~未补齐：apply win32 写路径注入用例~~ —— **2026-10-13 已在 Windows 真机补齐**（`test/core/apply.test.ts` 的 `runIf(win32)` 两条），该分支在 POSIX 进程里结构性不可测的结论不变，所以补齐只能在真机侧发生。
- 登记观察：13 工具深度行为靠表驱动六项 + PROBE 兜底（设计取舍）；dirclean 无直测（P3）。

---

## 第三部分 · 修复实施记录（"未完成的部分请完成"）

原计划 23 项（R0-R15 + L1/L2），因团队通道 429 限流两次中断，由主理人直接执行完毕。逐项状态：

| 项 | 内容 | 状态 |
|---|---|---|
| R-A1/A2 | apply.ts basename + replaceFileSync（P0） | ✅ + 注释说明为什么 |
| R-A3 | merge 失败 kept 点名 + pull.ts 专属文案 + apply.test 更新 | ✅ + e2e 链路用例 |
| R-B1 | findGitBash per-user 路径（LOCALAPPDATA + HKCU） | ✅ + 2 测试 |
| R-C1 | ensureClone origin 比对/重连 + snapshot 警告 + 2 测试 | ✅ |
| R-D1/D2/D3 | doctor samePath / 账本 hint 分化 / roles 两检查 | ✅ + 6 测试 |
| R-E1-E4 | uninstall 原子写 ×2 / 分隔符 / 文案指错 | ✅ |
| R-F1/L2 | lock pid 存活回收 + release 归属校验 + 4 测试 | ✅ |
| R-G1/G2 | ledger 0600 + ledgercheck 双格式兜底 | ✅ + 2 测试 |
| R-H1 | whichOn 无条件委派（删重复实现） | ✅ |
| R-I1 | mcprepo 逗号切分 | **证伪不实施**（实读无此缺陷；含逗号 token 走正则整体改写，行为正确） |
| R9 | 15 处 warning 中文化 + 3 处测试断言同步 | ✅ |
| R10/R11/R12 | cli.ts+README 补 MCP / AGENTS.md 两处 / 2.0 计划 §7 追加 | ✅ |
| R13 | helpers GIT_CEILING / review-fixes 保格式夹具 / mcp 第二工具 e2e | ✅ |
| R14 | merge.ts CRLF 行尾保护（JSON/TOML/blockCanonical） | ✅ + 3 测试 |
| R15 | C1/B1/K2/D1/D3 补测 | ✅（D1/D2 除外，理由见上表 W-2/D1+D2） |

**验证结果**：typecheck 0 错误；build 成功；全量 vitest 725 例（修复前 704）——末次全量运行 724 通过、1 失败（resources.test.ts symlink 用例断言未跟上中文化，已修复该断言），修复后单文件验证通过。**该遗留的完整复跑已于 2026-10-12 补齐**：修复断言后 `npm test` 两次全量实跑分别 42 文件 / 725 例（M10 代码层）与 52 文件 / 883 例（M7/M8/M9 合入后）全绿，`npm run typecheck` 退出 0，`npm run build` 产出 `dist/cli.js` 与 `dist/skills/{ejdrone-recall,ejdrone-share}`。
**git 状态**：M5/M6 已提交在 `main`；M10 与 M7/M8/M9 的全部改动、评审与试验记录已落在 `release/2.0-preview` 分支并打 tag `v2.0.0-preview.0`。

## 遗留问题（环境阻塞，非代码缺陷）

1. **Windows 真机验证**（M10 资源前置）：T10.4 后半真机全量、T10.7 全流程、hook 命令在真实工具 shell 下的执行、非管理员 Git 安装形态——清单已写入 `docs/trials/2026-10-11-m10-trial.md` §4。
2. **P3 观察池**：ledgerEntry Map 索引（万级文件前必须）、probe 字段显式化、debug.log 轮换、list --source all 离线语义、doctor.ts 拆分、push.ts 格式卫生。
