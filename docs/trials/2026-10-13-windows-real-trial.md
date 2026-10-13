# ejdrone-skills 2.0 · M10 试验记录（Windows 真机首次执行）

> **产物落点（2026-10-13 迁移后）**：本文提到的 `F:\tmp\ejdrone\…` 试验脚本、日志、备份与证据文件
> 现在统一在 **`F:\ejdrone\`** —— 仓库是 `F:\ejdrone\ejdrone-skills`，验证脚本与 `*-evidence.txt`、
> `real-claude-backup\`、各 `.log` 是它同级的开发文件。正文里当时写在 `F:\tmp\` 的原路径保持不动，
> 那是执行现场的真实记录；按新位置找同名文件即可。

> 日期：2026-10-13 · 里程碑：M10（Windows 支持）+ M7/M8/M9 内容级真机欠账
> 上一份：`docs/trials/2026-10-11-m10-trial.md`（同一里程碑的**代码层**交付骨架，§4 登记的全部遗留项由本记录销记）
> 状态：**真机已执行**。本轮在有 Windows 真机后完成 M10 计划写死的资源前置，把上一份记录留空待填的
> §1 试验对象、§4 待真机执行、§5 逐字节还原全部填上。深度按用户裁定：
> **隔离 HOME + 真实 shell 执行**，不往成员真实在用的工具配置目录写入。

## 1. 试验对象

| 项 | 值 |
|---|---|
| 被测版本 | `release/2.0-preview` @ `84ae8688`（tag `v2.0.0-preview.0`）+ 本轮 Windows 真机修复 |
| 主机 | Windows 10 (10.0.26200) x64，一台日常在用的真机（非 VM、非容器） |
| Node / npm | v24.14.1 / 11.11.0（计划要求 ≥ 20） |
| git | 2.48.1.windows.1，装在 `D:\Program Files\Git`（**非默认盘符**，靠注册表命中） |
| Git Bash | `D:\Program Files\Git\bin\bash.exe`；`%LOCALAPPDATA%\Programs\Git` 与 `HKCU` 形态本机不具备（`findGitBash` 走的是 HKLM 注册表分支） |
| shell 家族 | `cmd.exe`、`powershell.exe`（Windows PowerShell 5.x）、`pwsh.exe`（PowerShell 7）**三件都在**，所以 §4.3 那条「PowerShell 拆串」能实测 |
| 团队资产仓库 | 本机 `file://` 裸仓库（`F:\tmp\ejdrone\trial\team.git`），远端零副作用；MR 合入用本地 `merge --no-ff` 模拟 |
| 成员 HOME | 伪造目录（`F:\tmp\ejdrone\trial\home`），`EJDRONE_HOME` 同根；**未触碰** `C:\Users\ej` 下任何真实工具配置 |
| 选定工具 | `claude`（`~/.claude/settings.json` + `~/.claude.json`）、`codex`（`~/.codex/hooks.json` + `config.toml`）、`qoder-cn`（`~/.qoder-cn/settings.json`，与 hook 同文件） |
| 试验前备份 | 无需备份：所有写入都发生在伪造 HOME 内；对账基准是 init 之前对该目录的逐文件 sha256 快照 |

## 2. T10.4 后半：Windows 真机全量测试

原样命令与结果：

```
$ npm install            # 53 packages，无平台相关 postinstall
$ npm run typecheck      # tsc --noEmit → 0 错误
$ npm test               # 修复前：10 文件 / 27 例失败
$ npm test               # 修复后：Test Files 53 passed (53)
                         #          Tests 881 passed | 10 skipped (891)
```

**27 例失败逐条归因（关键结论：没有一例是投递算法的功能缺陷）**

| 根因 | 例数 | 处置 |
|---|---|---|
| NTFS 没有 POSIX 权限位：`chmodSync(0o600)` 是空操作，`statSync().mode` 恒 `0o666` | 9（state ×2、apply ×6、ledger ×1） | 抽 `test/helpers/mode.ts`：POSIX 精确断言，win32 断言「非只读」并把 0600 登记为有意偏差 |
| 测试注入 `platform` 却没注入主机副作用（真机 `reg` 命中、`X_OK` 恒真、`PATH` 里的盘符冒号撞 `':'` 分隔符） | 12（platform ×4、mcpfmt ×2、constants ×4、doctor ×1、ledger ×1） | 能给注入口的给注入口（`findGitBash` 的注册表读取器、`doctorCommand` 的 `gitBash` 形参）；纯 POSIX 文件系统语义的用例按主机跳过并注明理由 |
| 断言依赖正斜杠（`docs/deploy`、`mcp/mcp.yaml`），Windows 消息里是反斜杠绝对路径 | 3（knowledge ×2、mcp ×1） | 改断言资源键（`docs:deploy`）或先归一斜杠 |
| `doctor.test.ts` 用字面 `c:\users\dev\cli.js` 当假路径，在 Windows 上连文件都建不出来 | 2 | 改用真实临时文件名的两个大小写写法 —— 这才是 win32 真实语义，两种主机都能跑 |
| Windows 上 e2e 慢 2-4 倍撞 `testTimeout: 20000`；cleanup 时 `ENOTEMPTY`（git 子进程短暂占用） | 1 | `vitest.config.ts` 按平台抬线（win32 90s，POSIX 保持 20s）；`removeTree` 对 ENOTEMPTY/EBUSY/EPERM 重试 |

那 10 例 skip 全部是「POSIX 分支语义在 Windows 主机上结构性构造不出来」的（`':'` 切 PATH、`X_OK` 恒真、
`join()` 产反斜杠），不是把失败藏起来：win32 语义由 PATHEXT 用例与注入用例负责，POSIX 语义由 macOS/Linux 负责。

## 3. hook 命令形态：三 shell 通吃的实测矩阵

`docs/trials/2026-10-11-m10-trial.md` §4.3 第 1 条预警的坑（PowerShell 对含空格双引号参数的拆串）实测成立。
六种启动方式各跑一次，判据是「payload 是否真被执行」，不是退出码：

| 命令形态 | node shell:true（即 `cmd /d /s /c "<串>"`） | `cmd /c` 单 argv | `cmd /d /s /c` 单 argv | `powershell -Command` | `pwsh -Command` | `git bash -c` |
|---|---|---|---|---|---|---|
| A `"<bash>" -lc "EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent"`（旧形态） | 通 | 断 | 断 | **断**（ParserError：带引号的首 token 必须配 `&`） | **断** | 通 |
| B/C `cmd.exe /c ""<bash>" -lc …""`（嵌套引号包装） | 通 | 断 | 断 | 断（引号被吃掉，路径塌成 `C:Program`） | 断 | **断**（MSYS 把 `/c` 当路径转换） |
| D `cmd.exe /c "<wrapper.cmd>"` | 通 | 断 | 断 | 通 | 通 | 断（同上 `/c`） |
| E `"<wrapper.cmd>"`（带引号裸路径） | 通 | 断 | 断 | 断 | 断 | 通 |
| **F `<wrapper 正斜杠裸路径> EJDRONE_HOOK=1`（采用）** | **通** | **通** | **通** | **通** | **通** | **通** |

三条把「通吃」堵死的事实，以及由此定下的形态：

1. **首 token 不能是带引号的可执行路径**：cmd 与 bash 都接受，PowerShell 必须要 `&` 调用操作符；
   而 `&` 在 cmd 与 bash 里是语法符号 —— 不存在既带引号首 token 又三 shell 通吃的命令串。
2. **8.3 短路径不可依赖**：本机 `D:` 卷没启用短名生成（`D:\PROGRA~1` 不存在，
   `Scripting.FileSystemObject.ShortPath` 原样返回长路径），所以不能靠短路径把引号需求消掉。
3. **反斜杠裸路径会被 bash 当转义吃掉**（`F:\tmp\…` → `F:tmpejdrone…`），而 cmd 与 PowerShell 都接受正斜杠，
   所以 wrapper 路径一律用正斜杠、且不加引号。

**采用的形态**：工具配置里只写 `F:/…/.ejdrone/hooks/session-start.cmd EJDRONE_HOOK=1`，
原来的 `"<bash>" -lc "EJDRONE_HOOK=1 '<node>' '<cli>' pull --silent"` 连**内层单引号形状一起**搬进
`~/.ejdrone/hooks/session-start.cmd`。这样：

- `HOOK_COMMAND_MARKER` 仍是命令串的子串 → `hooks.ts` 的认领逻辑（`command.includes(marker)`）一处没改；
  尾随的 `EJDRONE_HOOK=1` 被 batch 当 `%1` 忽略，实测通吃（矩阵 F 行）。
- 内层单引号没动，只是搬家 → `parseHookPaths` / `parseHookBash` 沿用，改为先经
  `parseHookWrapper` 把 wrapper 正文读出来再喂给它们（与 POSIX 共用同一条解析路径）。
- 路径含空格（成员用户名带空格）时唯一写法是 D 形态（Git Bash 那一路断），
  所以 `win32Hook()` 带 `degraded` 标记，init 打印提示、doctor `win:hookbash` 报 WARN 点名，不静默。

**真机端到端背书**（不是 shell 层的字符串对拍，是行为）：往团队仓库推一条全新 skill `hook-probe`，
删掉成员目录里那份，然后分别用六种启动方式执行**已安装的那条 hook 命令**：

```
node-shell-true  rc=0  hook 自动拉回新 skill=YES
cmd-c            rc=0  hook 自动拉回新 skill=YES
cmd-d-s-c        rc=0  hook 自动拉回新 skill=YES
powershell       rc=0  hook 自动拉回新 skill=YES
pwsh             rc=0  hook 自动拉回新 skill=YES
gitbash-c        rc=0  hook 自动拉回新 skill=YES
```

顺带纠正一处试验方法上的错：第一次跑这步时我用「`debug.log` 是否增长」当判据，四路全 `no`，看着像
「hook 装了但不干活」。实际是一次干净的 `pull --silent` **本来就不写日志** —— 判据必须换成外部可见行为。

## 4. T10.7 全流程与逐字节还原

```
init（claude/codex/qoder-cn，角色 be）→ 退出码 0，hook 三条各装成功
  hook：Claude Code 已安装（F:/…/home/.ejdrone/hooks/session-start.cmd EJDRONE_HOOK=1）
  hook：Codex 已安装（同一条命令，wrapper 由三个工具共用）
  hook：Qoder CN 已安装
首次 pull → 19 个文件投递到 3 个工具；六类资源落点齐备
  （skills/rules/agents 进工具目录，docs 只进 ~/.ejdrone/knowledge 镜像，一处都不进工具目录）
doctor --json → 汇总 {"pass":19,"warn":1,"fail":0}，退出码 0
  win:gitbash   PASS  已找到 Git for Windows 的 bash.exe：D:\Program Files\Git\bin\bash.exe
  win:git       PASS  git 在 PATH 上（D:\Program Files\Git\mingw64\bin\git.exe）
  win:hookbash  PASS  3 个工具的 hook 命令均指向存在的 bash.exe
  hook:claude / hook:codex / hook:qoder-cn  全 PASS
  mcp:parse     PASS  mcp 列表文件可解析，2 条 server
  knowledge:mirror PASS  2 份团队知识已在镜像里
二次 pull → 摘要「已投递 0 个文件；删除 0；保留 0」（幂等）
uninstall --force → 退出码 0，删 21 个投递文件 + 撤 4 处团队区块 + wrapper 已删除
```

**逐字节还原对账**（init 前的 HOME 全树 sha256 快照 vs uninstall 后的全树）：

| 文件 | 结果 |
|---|---|
| `~/.claude.json`（含成员自有条目 `user-own`，我方注入过 `trial-stdio`/`trial-http`） | **零差异**，成员条目未被吞、我方条目已撤干净 |
| `~/.qoder-cn/settings.json`（`hooks` 与 `mcpServers` 同文件，两条写路径） | **零差异** —— §3.3 第 7 条「互不破坏」在 Windows 上成立 |
| `~/.codex/config.toml`（成员手写 `model = "gpt-5"` + `[mcp_servers.user-toml]`） | **零差异**，块外字节不变 |
| 各工具 skills/rules/agents 目录 | 投递文件全部删除，只剩空目录（按 §7 只报告不删） |
| `~/.ejdrone/hooks/session-start.cmd` | 已删除（本轮新增的清理，见 §5） |
| 残留 | `.codex/AGENTS.md`（0 字节，uninstall 打印 `留下空白文件` 点名，见 §5 D3）与 `~/.ejdrone/**`（config + 机器克隆，设计保留） |

`.claude.json` 的实测权限位是 `666` —— Windows 表达不出 0600，按用户裁定登记为偏差（§6）。

## 5. 真机才暴露的三个缺陷（都不是 Windows 专属，均已修复并配哨兵用例）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| D1 | 成员从 mac 换到 Windows（或反向）后，所有投递内容被判成「本地已修改」，全员静默收不到更新；codex 的 agent `.toml` 里 `developer_instructions` 嵌进字面 `\r\n` | Git for Windows 安装器默认写 `core.autocrlf=true`：仓库存 LF、机器检出 CRLF，投递产物跟着检出走 | `ejdrone readme` 的 MR 与空仓库首笔提交都带 `.gitattributes`（`* text=auto eol=lf`）；仓库里已有就不带（团队定制过等于绕过评审）。本仓自己也补了一份 —— 否则 `readBuiltinSkills()` 在 Windows 上读到 CRLF，三条既有 readme 端到端断言直接对不上 |
| D2 | `contribute`/`push` 之后紧接着的只读命令把未合入内容当团队真相（实测 `contribute --dry-run` 因「目标路径已存在」被拒） | `createBranch` 把 checkout 切到临时分支，`fetchReset` 只 `reset --hard` 不改 HEAD，所以没人把 checkout 还回默认分支 | `submitMrChange` 用 `finally` 包住整段：任何退出路径（成功、无变更、安全检查打回）都把 checkout 还给默认分支；空仓库那一路本来就落在 targetBranch，不还原 |
| D3 | `uninstall` 留下 0 字节的 `.codex/AGENTS.md` 且没有任何提示，成员以为已经清干净 | 区块文件撤完标记后只剩空白，旧代码只说「留成空文件即可」却没把它说出来 | **仍然不删**（`~/.codex/AGENTS.md` 是工具原生路径，分不清是不是工具自己建的，与同文件「空目录只报告不删」同一条理由），改为打印一行 `留下空白文件 …`。既有钉子用例 `failure.test.ts` 钉着「区块文件绝不整文件删除」，本轮尊重它而不是推翻 |

哨兵用例：`test/integration/readme.test.ts`（带 / 不覆盖 2 例）、`test/integration/lifecycle.test.ts`
（push 后与无变更退出回默认分支 2 例、uninstall 空白区块文件被点名 / 私有内容保留 2 例）。

## 6. 与计划/AGENTS.md 的口径偏差（本轮定下，后续照此）

| 项 | 计划 / AGENTS.md 原文 | 实际交付 | 理由 |
|---|---|---|---|
| §3.3 规则 6「含已解析值收紧 0600」 | 无条件红线 | POSIX 成立；win32 不成立，保护来自 `%USERPROFILE%` 的 NTFS ACL 继承，同机管理员仍可读明文 token | Node 在 NTFS 上只能表达只读位；`icacls` 收紧是另一个子系统（会改成员既有文件 ACL 且不可回松），列为 2.1 候选 |
| T10.2「hook 命令形态外层双引号、内层单引号」 | `"<gitbash>" -lc "…"` | 命令改为指向 wrapper；内层单引号形状原样保留在 wrapper 正文里 | 实测矩阵 F 行：旧形态在 PowerShell/pwsh 下 ParserError。AGENTS.md 担心的三处依赖（marker、`parseHookPaths`、doctor 核对）全部保住 |
| T10.2「找不到 Git Bash → installed:false」 | 不变 | 不变；另外路径含空格时降级为 `cmd.exe /c` 包装 + doctor WARN | 含空格时没有既通吃又无需 `cmd.exe` 的写法 |
| §4「真机试验…结束后按备份逐字节还原本机」 | 在成员真机上做并还原 | 在**伪造 HOME** 内做，真实 `~/.claude`、`~/.qoder-cn`、`~/.codex` 一个字节都没动 | 用户裁定的验证深度；`~/.qoder-cn` 是进行中的会话自己在用的配置目录 |
| T5.7/T6.8「开工具确认 agent 可见 / MCP 出现」 | 打开真实工具会话核对 | 未做（同上一条），改为：投递产物内容级逐字节核对 + hook 命令真跑并验证行为 | 内容级可见性（`/agents` 列出、Qoder 会话里 hook 触发）仍登记为遗留项，见 §7.3 |

## 7. 遗留项处置结果（2026-10-13 补跑）

原 §7 四条，现在三条关闭、一条环境阻塞：

### 7.1 已关闭：非管理员 Git for Windows 形态（`%LOCALAPPDATA%\Programs\Git`）

真机验证，不再是只有注入式单测：在 `%TEMP%` 下造 `LocalAppData\Programs\Git\bin\bash.exe`，
用 `LOCALAPPDATA` 指向它、`ProgramFiles` 指向空目录跑真代码 ——

```
findGitBash(LOCALAPPDATA 形态) = ...\LocalAppData\Programs\Git\bin\bash.exe
LOCALAPPDATA 优先级高于注册表   = true      ← 非管理员安装不会被 HKLM 抢走
win32Hook() 的 wrapper 正文含 per-user bash = true
win32Hook() 的 command = <state>/hooks/session-start.cmd EJDRONE_HOOK=1, degraded=false
LOCALAPPDATA 缺失且注册表也没有 → findGitBash=null、hookCommand=null → init 降级不装 hook
```

只有「HKCU 有值而 HKLM 没有」这一子形态仍未真机验证：本机 HKLM 装了 Git，
要造出那台机器形态得改系统注册表，不在试验里动系统配置。该分支由 `test/platform.test.ts`
的注入用例覆盖（HKLM→HKCU 顺序、`reg` 失败静默继续）。
> **2026-10-13 GA 收尾更新**：该子形态已真机验证并销记，见 §9.4（用户 hive 植键指向真实 Git，无害且已删净）。

### 7.2 已关闭：Windows 上的 npm 全局安装（`.cmd` 垫片形态）

`npm pack` → `npm install -g ./ejdrone-skills-2.0.0-preview.0.tgz` → **全部用全局 `ejdrone` 命令**
（不是 `node dist/cli.js`）在隔离 HOME 上跑完整生命周期，验完 `npm uninstall -g` 还原：

```
全局 bin：ejdrone / ejdrone.cmd / ejdrone.ps1 三件都在；ejdrone --version = 2.0.0-preview.0
init → 退出码 0，hook 已装
wrapper 正文里的 cli = C:\Users\ej\AppData\Roaming\npm\node_modules\ejdrone-skills\dist\cli.js
  真实存在 = true ；指向 .js 而不是 .cmd 垫片 = true   ← 关键：hook 不会去 exec 一个批处理
doctor --json → {"pass":15,"warn":1,"fail":0} 退出码 0；hook:claude / win:hookbash / win:gitbash 全 PASS
用这条安装形态的 hook 命令真跑自动 pull：cmd /c YES、powershell YES、git bash YES
uninstall --force → 退出码 0，wrapper 已删，投递文件与记账清干净
```

结论：成员按 README 的方式装（`npm install -g`）时整条链路成立，`realpathSync(argv[1])`
在 npm 垫片下解析到的仍是真实 `dist/cli.js`。

### 7.3 未关闭（环境阻塞）：真实工具会话内的可见性

> **2026-10-13 GA 收尾更新**：本节两条（`/agents` 目视、SessionStart 触发）已通过 TUI 路线全部关闭，
> 根因也比本节记录的更深（端口被另一网关占用、成员 token 被拒），证据与截图见 §9.1–§9.3。

试了两种不碰成员真实配置的做法：`claude -p … --output-format json`（headless）以及
带 `--include-hook-events` 的 stream-json 会话 —— **本机 headless Claude 在 150s 内零输出、退出码 124**，
拿不到任何可读回的数据（很可能是这套 Claude Code 在非交互上下文里等授权/信任确认）。
`codex` 同理未通。因此 T7.8 的「打开 `/agents` 看它真列出投出去的 agent」与
「开一次真实会话确认 SessionStart 触发」这两条**仍未在真实会话里目视确认**。

已经拿到的等价证据（不是同一件事，但覆盖了风险面）：
- 工具配置里那条 hook 命令被**真实执行**且完成了自动 pull（六种启动方式，见 §3），
  所以「命令形态能不能跑起来」这一层是行为级证明，不是推断；
- 投递产物是**内容级**逐字节核对的：claude 收到 `kafka-ops.md`（frontmatter `name/description/tools/model` 齐全）、
  codex 收到 `kafka-ops.toml` 且确实没有 tools 键（见 §4）。
仍欠的是工具自己那一侧的解析与展示（它是否认这份 frontmatter、`/agents` 里是否出现），
需要一个能交互操作 Claude Code / Qoder CN 的窗口，或一个可用 headless 凭据的账号。

诚实起见补一句方法学纠正：第一次判「hook 有没有触发」我用的是 `debug.log` 是否增长，
四路全 `no`，看起来像「装了但不干活」；实际是一次干净的 `pull --silent` 本来就不写日志。
判据换成外部可见行为（推一条新 skill、删掉成员那份、看它是否自己回来）之后六路全通。
**这条误判值得留给下一个做真机试验的人**：silent 路径的成功没有日志，不能用日志存在性当证据。

### 7.4 本轮新增的覆盖（Windows 专属代码路径）

`test/integration/lifecycle.test.ts` 新增 4 条 `runIf(win32)` 用例，把此前只有单元测从旁边
描述过、从未真被执行的那层代码钉住：wrapper 真的落盘且 payload 形状不变、工具配置里只留裸路径、
路径含空格时的 `cmd.exe /c` 降级 + doctor `win:hookbash` WARN、wrapper 写失败时不装 hook
并给出「手动 pull 不受影响」、uninstall 删除 wrapper。

### 7.5 已结算：版本评审里那条「P0 但无测试覆盖，只能真机验」

`docs/reviews/2026-10-12-version-review.md` 的 W-2/D1+D2（临时文件名含盘符冒号 → EINVAL，
Windows 上所有 MCP merge 写与 0600 收紧写全废）当时写的是「代码已修但该分支无任何测试覆盖，
验证只能等 Windows 真机」。真机到了，补两条 `runIf(win32)` 直接哨兵并已通过：

- 写一个**已存在**的共享配置文件：不抛、成员条目原样、目录里没有任何 `ejdrone-tmp` 残留；
- 带 ledger 串起来的**反复覆写**：每一轮都断言「真的写了 1 次」——
  不带 ledger 会退化成 foreign-entry 跳过，那样根本碰不到 rename 覆盖已存在文件这一环，
  这条是这次补测里唯一真正对着 P0 失效点的断言。

「POSIX 进程里 `basename` 在 import 期绑定、构造不出 Windows 路径形态」这个成因仍然成立，
所以这两条在 macOS/Linux CI 上是空跑：这条分支的覆盖只能来自 Windows 主机，不是回归套件的常态保障。

全仓覆盖率（临时 `--no-save` 装 `@vitest/coverage-v8`，不改依赖）：
**语句 88.99%、分支 82.7%、函数 98.48%**。低的是 `context.ts` 46.91%（交互 prompt 默认实现，
测试注入 `prompt/confirm/choose` 后不会走到）与 `roles.ts` 60%、`agentscollect.ts` 62%
（交互式多选），属设计内不可测面，不是漏测；`src/core` 与 `src/agents` 基本 100%。

## 7.6 真实成员环境（往真用的 `~/.claude` 做过一次，含还原对账）

用户批准后，把试验深度推进到**真实成员配置**：先对 `~/.claude/settings.json`、`settings.local.json`、
`~/.claude.json`、`~/.claude/agents/**` 做整备份并逐文件 sha256 建基线，然后对真实 HOME 跑真 init。

真实环境里验证到的（这些是隔离 HOME 给不出的证据）：

| 项 | 结果 |
|---|---|
| hook 装进**成员真在用的** `~/.claude/settings.json` | 成功，且 `hooks.SessionStart` 只多我们那一条 |
| 同一文件里成员自有的其它键 | **`env` 块完整保留**（含 `ANTHROPIC_AUTH_TOKEN`、指向 `127.0.0.1:15721` 的 `ANTHROPIC_BASE_URL` 与一串模型别名）—— §3.3「共享配置文件只动我们那一个键」在真实配置上成立，不是夹具里的构造 |
| 投递进已有 216 份 agent 的真实 `agents/` 目录 | 只增不改：`ejdrone-real-agent.md` 落进去，其余 216 份一字节没动 |
| `~/.claude.json`（MCP 与项目状态） | 团队仓库故意不放 `mcp/`，全程未被触碰（58 个顶层键、`mcpServers` 集合与取值逐项与备份相同） |
| 真实环境 `doctor --json` | `{"pass":16,"warn":0,"fail":0}` 退出码 0 |
| `uninstall --force` 后还原对账 | `settings.json` 与 init 前**逐字节一致**；216 份 agent 全部一致、零缺失零新增；4 个投递文件与其记账清除；`~/.ejdrone` 已移除（试验前不存在）；`rules` 空目录已清理 |

**仍未拿到的**：在真实会话里目视确认 `/agents` 列出投出去的 agent、`SessionStart` 被工具触发。
> **2026-10-13 GA 收尾更新**：两项都已拿到——`/agents` 在真实用户目录形态下列出投递 agent（§9.2，
> 216 份对账还原逐字节一致），`SessionStart` 在真实 claude 进程里触发并完成自动拉新（§9.3）。
> 下面「GA 前两分钟」的人工步骤已由 TUI 驱动代为执行，原文保留作方法记录。
原因是环境而不是代码 —— 这台机器的 Claude Code 配置把 `ANTHROPIC_BASE_URL` 指向本地代理
`127.0.0.1:15721`，代理未运行时 `claude` 进程**零输出直到超时**（`--output-format stream-json
--include-hook-events` 与普通 `-p` 都是 `status=null`、0 字节），所以任何 headless 探针都拿不到数据。
我没有去动那个代理（那是成员自己的模型出口配置，不在本试验范围内）。

GA 前由本人在一个能正常工作的 Claude Code 会话里做掉即可，两分钟：

```bash
# 装好后 ejdrone init <团队仓> --agent claude，然后正常开一次 claude 会话
/agents                       # 应能看到团队投下来的那个 agent 名字
# 会话开起来之后，另开终端：
ejdrone doctor                # hook:claude 应 PASS
ls ~/.claude/skills           # 团队 skill 应已在里面
```

顺带记录一条还原对账上的自我纠正：脚本一开始把基线 agent 数写成 228，那是把两个 settings 文件
一起数进 manifest 的笔误；真实基线是 216。逐项比对后确认**没有删除任何成员文件**
（216 份全部存在且逐字节一致）。这类「自己算错的基线」在还原对账里会被当成"我们删了 12 个文件"，
所以基线数字必须由比对脚本现算，不能手写。

## 8. 仍然遗留

> **2026-10-13 GA 收尾更新**：第 1、2 条已全部关闭，证据见 §9。第 3 条（P3 观察池）不阻塞 GA，维持登记。

1. ~~真实工具会话内的目视确认（§7.3 环境根因 + §7.6 的两分钟人工步骤）~~ **已关闭（§9.1/§9.2）**。
2. ~~HKCU-only 的 Git 注册表形态（§7.1，要动系统注册表才能造）~~ **已关闭（§9.4）**。
3. P3 观察池不变（ledgerEntry Map 索引、probe 显式化、debug.log 轮换、doctor.ts 拆分）。

## 9. GA 收尾（2026-10-13 下午，销记 §8 前两条遗留）

headless 仍不可用，但根因比 §7.3 记录的更深一层：`127.0.0.1:15721` 现在确实有进程在听（PID 22512），
但它是**另一个网关**——用成员 `ANTHROPIC_AUTH_TOKEN` 直连 `/v1/messages` 得 401 `Invalid token`
（`/v1/models` 200 说明服务本身活着）。即成员自己的 claude 路由器并没在跑，端口被占。
因此本轮目视不走 headless，改用 TUI 路线：`/agents` 面板与 SessionStart hook 都是客户端行为，不依赖模型出口。
截图、设置文件与对账 manifest 留在 `%TEMP%\ga-verify\`（shot-*.png、canary-settings.json、hook-settings.json、
agents-baseline-manifest.txt / agents-after-manifest.txt）；两个一次性脚本在 `%TEMP%` 根（ga-chain.mjs、ga-hkcu.mjs）。

### 9.1 真实会话 `/agents` 目视（项目级）

隔离 HOME 用真实 CLI 跑完整链路（`ga-chain.mjs`：裸 origin → 种子仓库 → `init --agent claude --role be`
→ `pull`），拿到投递给 claude 的 `ga-verify-agent.md` 字节，原样放进临时项目目录的 `.claude/agents/`。
真实 Claude Code（2.1.283）TUI 会话里输入 `/agents`：面板列出 `ga-verify-agent`，
描述「GA 验证专用 agent，确认工具真实加载」逐字一致（shot-agents-panel.png）。

### 9.2 真实会话 `/agents` 目视（成员真实 `~/.claude/agents`）与还原对账

按 §7.6 的纪律做单文件往返：**现算** 216 份 sha256 基线（不手写数字）→ 把同一份投递字节拷进真实
`~/.claude/agents/` → 在无项目级 agent 的中性目录开 TUI 会话 → `/agents` 面板在 general-purpose
之下第二位列出 `ga-verify-agent`（shot-real-agents.png，此时列表来源只能是用户级目录）→ 退出会话、
删除该文件 → 复算 manifest：**216 份逐字节一致、零缺失零新增**（agents-after-manifest.txt 与基线 diff 为空）。

### 9.3 SessionStart hook 在真实 claude 进程里触发 + 自动拉回新内容

`-p` 虽然挂死（等模型出口），但会话启动序列在模型请求**之前**执行，两轮验证都吃到了副作用：

1. **canary**：`--settings` 注入 `cmd.exe /c "echo fired >> canary.txt"`，`claude -p` 挂死后 canary 文件
   已写入（`fired`）——SessionStart 确实被真实 claude 进程触发。
2. **真命令全链路**：`--settings` 指向 init 产出的 wrapper（唯一改动：内层命令前缀
   `HOME='<夹具>' EJDRONE_HOME='<夹具>'`，把投递钉死在隔离层，绝不碰真实配置）。`claude -p` 挂死后，
   夹具 HOME 里出现了 origin 在 pull 之后新推的 `ga-new-skill` —— **真实 claude 会话启动 → 我们的
   wrapper（cmd → Git Bash → node cli pull --silent）→ 自动拉新**整条链路成立。

### 9.4 HKCU-only Git 注册表形态（销记 §7.1 最后一条）

`platform.ts` 把 `queryRegistryInstallPath` 导出（仅 +6 行注释性导出，无行为变化），让真机脚本能
**按生产代码路径**只跑 HKCU 分支。四步验证（`ga-hkcu.mjs`）：植键前确认 `HKCU\Software\GitForWindows`
不存在（成员注册表原样）→ 植入 `InstallPath = D:\Program Files\Git`（指向真实安装，即使键泄漏行为也与
现状一致）→ `findGitBash`（ProgramFiles/LOCALAPPDATA 全空的 env + 真实 reg.exe 输出）经 HKCU-only
找到 `D:\Program Files\Git\bin\bash.exe` 且文件真实存在 → 删键后 HKCU-only 返回 null、默认路径仍从
HKLM 找到真 Git。至此「HKCU 有值而 HKLM 没有」不再是只靠注入用例覆盖的分支。

### 9.5 本轮代码变更

只有 `src/platform.ts` 的 `queryRegistryInstallPath` 导出（含 JSDoc 说明导出理由）；其余全是文档与
发版动作。HKCU 植键为什么不做成永久 `runIf(win32)` 用例：测试套件会在每台 Windows 开发机上写注册表，
对宿主机是超出测试职责的副作用，维持一次性脚本 + 本节记录的形态。

## 10. 回滚

代码层：本轮改动都在 `release/2.0-preview` 上、尚未推送；回滚 = revert 对应提交。
hook 形态单独可回退：把 `win32Hook()` 的 `command` 改回 `"<bash>" -lc "<payload>"` 即回到 `v2.0.0-preview.0`
的行为，wrapper 与 `parseHookWrapper`/`hookPayloadOf` 的分支随之变成死代码（POSIX 路径完全不受影响）。
`.gitattributes` 那条：删掉团队仓库里那份即可，成员侧行为回到 D1 描述的状态。
