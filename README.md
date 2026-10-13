# ejdrone-skills

把团队的 AI 技能、规范、MCP server、子 Agent 和团队文档放进一个 Git 仓库，按**角色**裁剪后自动投递到每个成员的
AI 编程工具里。一人调好，走 MR 评审合入，其他人下次开会话就自动有了 —— 不用通知、不用手动复制。

## 它解决什么问题

团队里每个人都在用 AI 编程工具（Claude Code、Cursor、Codex……），调好的技能、团队规范、MCP server
都躺在各自的用户目录里：新人挨个要文件，规范改了没人知道，每个人的 AI 行为参差不齐。

ejdrone-skills 让**一个团队 Git 仓库成为唯一真相**。能分发的东西有六类：

| 类别 | 内容 | 到了成员机器上是什么 |
|---|---|---|
| skills | AI 技能 | 各工具的 skills 目录，AI 会话里直接可用 |
| rules | 团队规范 | 各工具的 rules 载体（目录 / `.mdc` / `AGENTS.md` 区块） |
| mcp | MCP server 声明 | 写进各工具自己的 MCP 配置文件，只动我们那几条 |
| agents | 子 Agent 定义 | 按各工具的格式转换后投到 agents 目录 |
| docs | 团队文档 | 镜像到 `~/.ejdrone/knowledge/`，`recall` 一条命令检索 |
| learnings | 踩坑经验 | 同上；`contribute` 一条命令回流入库 |

管理员按角色（全员 / 前端 / 运维……）组织上面的内容；成员 `ejdrone init` 一次之后**日常零操作** ——
会话启动时 hook 自动 `pull`，你的角色该拿到的就位，不该拿的拿不到。

边界同样重要：只有 user scope（不碰任何项目文件）、不建服务端、零遥测，网络只碰你们的团队仓库。

## 适合谁 / 不适合谁

- **适合**：15-25 人、Git 托管在内网或私有云（GitLab / GitHub）、愿意给全员仓库 write 权限、
  希望一切变更经 MR 评审的团队。单人就能维护：一个 npm 包 + 一个 Git 仓库，没有服务端要值守。
- **不适合**：需要 hooks / models / env 下发、teamwiki、dashboard、代码库知识图谱这类重能力的团队 ——
  那是 teamai-cli 的领地，见下面的选型参考。

设计取舍与理由见 `docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md`。

## 与 teamai-cli 的关系（选型参考）

ejdrone-skills **不是** teamai-cli 的分叉。2.0 以腾讯开源的 teamai-cli 为对标做减法：
17 个工具的落点表初稿从它的公开文档照抄并逐项标 PROBE，再逐个真机核实销记；
个别语义（`recall --check` 的退出码约定、`mcp.yaml` 写坏时 MCP 整体停发）有意保持一致，方便两个产品之间迁移。

下表差异按 2026-10-12 对 teamai-cli（commit `2cbf556`）的源码级复核记录，
细粒度出处见 `docs/superpowers/plans/2026-10-11-ejdrone-skills-2.0.md` §7.1：

| 维度 | ejdrone-skills 2.0 | teamai-cli |
|---|---|---|
| 支持工具 | 17 个（zcode 以无 hook 形态支持；omp、joycode 不收） | 19 个（多 omp、joycode） |
| 资源类型 | 6 类（见上表） | 11 类（另含 env、hooks、models、codebase、teamwiki） |
| 部署形态 | 纯 Git 仓库，无服务端、零遥测 | teamwiki / dashboard / votes / codebase 图谱等 beta 能力依赖本地服务与上报 |
| 变更治理 | 一切入库变更走 MR 评审，**包括经验沉淀**（`contribute` → MR） | 经验沉淀走孤儿分支直推（不经 MR、不碰默认分支） |
| 密钥管理 | MCP 的 `${VAR}` 只从环境变量解析，明文不进任何输出与日志 | env/secrets 子系统：仓库声明 key，成员 `teamai env set` 本地存值（0600） |
| 知识检索 | 无索引轻量打分（标题×3 / 标签×2 / 正文×1），无状态、可迁移 | 持久索引（IDF 加权 + 投票 + 置信度晋升），为更大规模准备 |
| 规模取向 | 15-25 人，单人维护得起 | 更大团队 |
| 源码体量 | `src/` 74 文件 / 约 1.2 万行，测试代码与之约 1:1 | 单文件最大 222KB，复杂度主要来自 project scope 与 HTTP 后端 |

一句话选型：要更全的资源类型、服务端周边能力和更大规模，选 teamai-cli；
要最小依赖（一个 npm 包 + 一个 Git 仓库）、一切变更可评审、单人维护得起，选 ejdrone-skills。

## 装

```bash
npm install -g ejdrone-skills@2.0.0   # 内网 npm 源
ejdrone --version
```

2.0.0 为 **GA**：六类资源（skills / rules / mcp / agents / docs / learnings）全部就位。验证口径：

- **macOS 真机**：skills / rules / MCP 走过投递与卸载还原。
- **Windows 10 真机**（2026-10-13）：全量测试真机全绿——试验时点 53 文件 / 881 例，zcode 适配器并入后
  54 文件 / 915 例；`init → pull → hook 自动 pull → doctor → uninstall` 全流程跑通，并对成员
  **真在用的 `~/.claude`** 做过一次完整投递与逐字节还原对账（同文件 `env` 自有键与 216 份自有 agent
  全部原样），见 `docs/trials/2026-10-13-windows-real-trial.md`。
- **子 Agent / 团队知识 / 经验沉淀**：夹具逐字节对拍 + 真机行为级（hook 六种启动方式真跑、`recall`
  中英文判读、`contribute` 全链路）；GA 前最后一项目视确认在真实 Claude Code 会话完成——
  `/agents` 面板列出团队投下来的 agent，SessionStart hook 触发并自动拉新（试验记录 §9）。

前置：Node.js ≥ 20、git。Windows 另需 Git for Windows（hook 走它的 bash.exe 绝对路径）。

## 管理员：建团队仓库

在 Git 托管上建一个空仓库（建议 `ejdrone-team`），给全员 write 权限，然后：

```bash
cd /path/to/your-project
ejdrone init https://gitlab.example.com/team/ejdrone-team.git
ejdrone doctor          # 逐项体检，全绿才算好
```

仓库里的结构就是全部真相（空仓库的第一笔提交会自带一份 `README.md`，说明这仓库是什么、成员怎么加入怎么退出；内容过期了用 `ejdrone readme` 重新生成）：

```
manifest/roles.yaml        # 角色 → namespace 映射
skills/
  team-release/SKILL.md   # 根目录 = 全员
  fe/fe-code-review/SKILL.md
  devops/ops-deploy/SKILL.md
rules/
  code-style.md            # 全员
  fe/react-conventions.md
mcp/
  mcp.yaml                 # 全员共享的 MCP server
  fe/mcp.yaml              # 只给 fe 角色
```

定义角色：

```bash
ejdrone roles add devops --namespaces devops -d "运维/流程"
ejdrone roles add fe --namespaces fe -d "前端"
```

> **放置规矩**：共享内容放根目录，差异化才放 `skills/<ns>/`。共享内容误放进某个激活的 namespace，
> 会出现同一规则被下发两份。

## 成员：加入（3 分钟）

```bash
ejdrone init https://gitlab.example.com/team/ejdrone-team.git
# 交互里勾选你在用的工具、选你的角色
ejdrone list           # 看拿到了什么
```

之后**日常零操作**：会话启动时 hook 自动 `pull`。

指定工具与角色可跳过交互（CI / 脚本用）：

```bash
ejdrone init <repo> --agent qoder-cn,claude --role devops --force
```

自建 GitLab 域名里不含 `gitlab` 时显式指定 provider，否则只能手动开 MR：

```bash
ejdrone init https://code.example.com/team/ejdrone-team.git --provider gitlab
```

## 日常：分享一条 skill 给团队

```bash
# 1) 写在自己的工具目录里
mkdir -p ~/.claude/skills/team-release
$EDITOR ~/.claude/skills/team-release/SKILL.md

# 2) 推给团队（自动建分支 + 开 MR；frontmatter 缺失会自动补）
ejdrone push --skill ~/.claude/skills/team-release
# 多 namespace 角色要指明推到哪个目录
ejdrone push --skill ~/.claude/skills/team-release --ns devops

# 3) 有人评审合入

# 4) 队友下次开 AI 会话自动拉到；想马上看就 ejdrone pull
```

同一资源重复 push 会就地更新那条未合并的 MR，不开重复分支。

## 下发 MCP server

在 `mcp/mcp.yaml` 里声明一次，`pull` 时按每个工具的原生格式写进它自己的 MCP 配置文件：

```yaml
servers:
  - name: gpu-analysis
    description: GPU 存量与价格查询
    transport: http            # stdio | http | sse
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}   # 从成员自己的环境变量取，绝不写明文

  - name: local-formatter
    transport: stdio
    command: npx
    args: ['-y', '@acme/formatter-mcp']
    requires: [npx]            # PATH 上没有 npx 的人跳过这条并点名
    tools: [claude, cursor]    # 可选：只发给这些工具
```

三条要紧的规矩：

- **只动我们那几条**。这些配置文件里通常已经有你自己的 server（Claude 那份还兼着工具的状态文件），
  我们按条目合并：你在 `mcpServers` / `[mcp_servers.*]` 里写的东西一字不改，卸载也只撤我们自己那几条。
- **你改过我们投的那条，就不覆盖**，`pull` 会点名到具体是哪一条 server。
- **`${VAR}` 取不到值就整条跳过**并告诉你缺哪个变量；解析出来的值不会出现在任何输出、日志或记账里。

`mcp/fe/mcp.yaml` 只发给激活了 `fe` 的角色；同名时 namespace 条目整体替换根条目（不做字段合并）。
`mcp.yaml` 写坏（比如把 `servers:` 拼成 `server:`）会让本次 MCP 整体停发并点名文件，
**不会**被当成"团队把 server 都删了"从而清空大家已装的内容。

哪些工具有用户级 MCP 落点，见下面的投递矩阵；没有落点的工具收不到 MCP，也不会被凭空造出配置文件。

自己在工具里调好一条 server 之后，可以直接把它采进仓库，不用手抄：

```bash
ejdrone list mcp --source local        # 先看各工具的用户级 MCP 配置里有哪几条（只列名字，不列值）
ejdrone push --mcp local-formatter     # 反向采集 → 自动分支 + MR
```

- 采集只读 JSON 形态的落点。Codex 的 `config.toml` 不做反向解析（投递时只做受控的表块拼接，
  故意没写完整解析器），想让那条入库就照上面的形状手写进 `mcp/mcp.yaml`。
- 采到的值里**看着像凭据的会自动改写成 `${VAR}` 再入库**（键名以 `TOKEN`/`KEY`/`SECRET`/`PASSWORD`
  结尾、`Authorization` 这类按定义就是凭据的 header、以及形状像 token 的取值）。命令会点名改了哪几条、
  用了什么变量名、怎么 `export`；**值本身不会出现在任何输出里**。没法安全改写的（凭据写在命令行参数或 URL
  查询串里 —— 换成 `${VAR}` 会连命令和地址一起吞掉）就拒绝入库，让你手写，绝不静默提交明文。
- `remove mcp <名字>` 同样只删仓库（走 MR），你本机那份由合入后的下一次 `pull` 撤掉；
  根与 namespace 两处同名时会拒绝并列出两个文件，要你带 `--ns`/`--role` 表态。

## 下发子 Agent

仓库里的 `agents/<名字>.md`（带 frontmatter）会投到各工具自己的 agents 目录，一个 agent 一个文件。
每个工具吃形态不一样，投递时按落点表转换，只有一处做转换（`src/agents/agentfmt.ts`）：

| 形态 | 哪些工具 | 落点文件 |
|---|---|---|
| markdown | Claude / Qoder / Qoder CN / Cursor / CodeBuddy / WorkBuddy / OpenCode | `agents/<名字>.md` |
| Copilot 形 | GitHub Copilot CLI | `agents/<名字>.agent.md` |
| TOML | Codex | `agents/<名字>.toml`（写 `name/description/developer_instructions/model`，**故意不写 tools**） |
| JSON | Kiro | `agents/<名字>.json`（`name/description/prompt/model/tools`） |

- `agents/<ns>/<名字>.md` 只发给激活了 `fe` 这类 namespace 的角色；同名时 namespace 条目整体替换根条目，
  两个激活角色撞同名则整类停发、已装的不动（与 skills/rules 同一套裁决）。
- **6 个工具没有用户级 agents 落点**：DeepSeek Harness、Pi、OpenClaw、Trae、Trae CN、Hermes。
  落点表里没有它们，投递就跳过 —— 不会凭空造一个工具不读的目录。
- 你自己写好的 agent 可以直接采进仓库：

```bash
ejdrone list agents                    # 仓库里现有哪几份
ejdrone push --agent code-reviewer     # 从你在用的工具目录反向采集 → 自动分支 + MR
ejdrone remove agents code-reviewer    # 只删仓库（走 MR），合入后大家的下一次 pull 自动移除
```

`push --agent` 在多个工具里撞同名且内容不同时**会拒绝并逐处点名**，要你加 `--tool claude` 说清采哪一份；
Codex 的 `.toml` 不做反向解析（与 MCP 侧同一个决定），那份想入库就手写 markdown。

## 团队知识与经验沉淀

`docs/` 与 `learnings/` 不进任何工具目录，而是镜像到 `~/.ejdrone/knowledge/`，用一条命令检索：

```bash
ejdrone recall "kafka 消费积压"        # 前 5 条：路径 + 命中片段，按标题×3 / tags×2 / 正文×1 排序
ejdrone recall --check "灰度发布"      # 只判相关性：RELEVANT / NOT_RELEVANT，退出码 0 / 1，不打印正文
ejdrone recall "mysql 加索引" --json   # 给脚本用
```

镜像内容 = 你订阅的角色该拿到的那部分，非激活 namespace 的文档既不在镜像里、也就检索不到。
成员改过镜像里的那一份，`pull` 会保留你的版本并点名，不覆盖。

踩过的坑往回流：

```bash
ejdrone contribute --file ./notes.md            # 补全 frontmatter → 命名 learnings/<日期>-<标题>.md → 分支 + MR
ejdrone contribute --file ./notes.md --dry-run  # 只看会写成什么样，一个 git 副作用都不发生
```

合入后大家 `pull` 到镜像，`recall` 就检索得到。两条内置技能（`ejdrone-recall`、`ejdrone-share`）随
`ejdrone readme` 一起提交进团队仓库，之后作为普通 skill 下发 —— 教 AI 在动手前先做一次检索、
在被反复纠正时提议沉淀。这两个名字在 `push` 侧是保留名，不能用你本地那份覆盖团队仓库里的版本；
要改就在仓库里改并走 MR。

## 命令

| 命令 | 作用 |
|---|---|
| `init <repo>` | 选定工具与角色、装 hook、首次 pull |
| `pull [--force] [--silent]` | 同步团队仓库并投递。`--force` 覆盖本地改过的整文件投递（团队区块只动区块） |
| `push [--skill p] [--rule p] [--mcp name] [--agent path] [--tool id] [--all] [--role id] [--ns ns]` | 推资源，自动分支 + MR。`--mcp` 从本机 MCP 配置反向采集；`--agent` 从工具 agents 落点反向采集（要单独跑，各自一个 MR）；`--tool` 把这两种采集缩到一个工具 id；`--all` 只含 skills/rules |
| `status` | 待推送 / 落后 / 本地改动（含 MCP） |
| `list [skills\|rules\|mcp\|agents\|docs\|learnings] [--source repo\|local\|all]` | 列资源及其 namespace 与根条目归属；`list mcp --source local` 只列 server 名与文件路径，不回显值 |
| `recall "<关键词>" [--check] [--json]` | 检索团队知识镜像（`docs` + `learnings`）。`--check` 只判相关性、不打印正文，命中返回 0、未命中返回 1 |
| `contribute --file <path> [--title t] [--ns ns] [--dry-run]` | 把一份踩坑记录沉淀成 learning 并走 MR 入库；`--dry-run` 不发生任何 git 副作用 |
| `roles list\|set <id> [--add ids]` | 本地订阅哪些角色 |
| `roles add\|remove <id>` | 管理员改团队 manifest（走 MR） |
| `remove <kind> <name...> [--role id] [--ns ns]` | 从**仓库**删除资源（走 MR）。不动你本地副本 —— 合入后 `pull` 会自动移除 |
| `readme` | 生成/更新团队仓库首页的 `README.md`，并把仓库里还没有的两份内置技能（`skills/ejdrone-recall`、`skills/ejdrone-share`）一起提交（走 MR；团队已改过的那份绝不覆盖）。空仓库初始化时会自动带一份，已有仓库补一份用这个 |
| `doctor [--json]` | 体检：config / 仓库 / manifest / hook / 投递记账 / 落点核对，外加 MCP 四项（文件可解析、缺哪个变量、受管条目是否被你改过、哪些工具没有 MCP 落点） |
| `uninstall [--force]` | 移除 hook 与投递的文件；撤掉未被你改过的团队区块（AGENTS.md 本体与标记外内容保留）；保留 config 和你改过的副本 |

出问题先跑 `ejdrone doctor`。`--silent` 模式下（hook 用的就是它）问题只写 `~/.ejdrone/debug.log` 且恒返回 0，不会挡住你开工具。

## 支持的工具

17 个工具（2.0 GA 为 16 个，zcode 为 GA 后新增），全部只有 user scope。「真机核实」列是本机（macOS）逐项盘出来的，zcode 在 Windows 10 真机核实；没核到的格子一律标出来，不猜。

| 工具 | skills | rules | MCP 落点 | agents 落点 | 真机核实 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/rules/*.md`（官方用户级载体，支持 `paths:` 按需加载） | `~/.claude.json` | `~/.claude/agents/*.md` | 已核 |
| Qoder CN | `~/.qoder-cn/skills/` | `~/.qoder-cn/rules/*.md` | `~/.qoder-cn/settings.json` | `~/.qoder-cn/agents/*.md` | 部分（rules 是否被读取未证） |
| Qoder | `~/.qoder/skills/` | `~/.qoder/rules/*.md` | `~/.qoder/mcp.json` | `~/.qoder/agents/*.md` | 部分（rules 与 hook 未证） |
| Cursor | `~/.cursor/skills/` | `~/.cursor/rules/*.mdc` | `~/.cursor/mcp.json` | `~/.cursor/agents/*.md` | 未核（本机未装） |
| Codex | `~/.codex/skills/` | `~/.codex/AGENTS.md` 团队区块（其原生 `rules/` 是命令策略目录，非 markdown） | `~/.codex/config.toml` | `~/.codex/agents/*.toml` | 部分（hook 未核） |
| GitHub Copilot CLI | `~/.copilot/skills/`（或 `$COPILOT_HOME`） | `~/.copilot/AGENTS.md` 团队区块 | `~/.copilot/mcp-config.json` | `~/.copilot/agents/*.agent.md` | 未核（本机未装） |
| CodeBuddy | `~/.codebuddy/skills/` | — | `~/.codebuddy/.mcp.json` | `~/.codebuddy/agents/*.md` | 部分（hook 未证） |
| WorkBuddy | `~/.workbuddy/skills/` | — | `~/.workbuddy/mcp.json` | `~/.workbuddy/agents/*.md` | 部分（hook 未证） |
| OpenCode | `~/.config/opencode/skills/` | `~/.config/opencode/AGENTS.md` 团队区块 | `~/.config/opencode/opencode.json` | `~/.config/opencode/agents/*.md` | 未核（本机未装） |
| Pi Coding Agent | `~/.pi/agent/skills/` | — | `~/.pi/agent/mcp.json` | — | skills 已核 |
| OpenClaw | `~/.openclaw/skills/` | — | — | — | skills 已核（hook 是 workspace 级，user scope 不做） |
| Hermes | `~/.hermes/skills/` | — | — | — | skills 已核（`~/.hermes/hooks` 是目录，非 JSON 载体） |
| Kiro | `~/.kiro/skills/` | — | `~/.kiro/settings/mcp.json` | `~/.kiro/agents/*.json` | skills 已核（SessionStart 由 agent 同步内嵌，无用户级落点） |
| Trae | `~/.trae/skills/` | `~/.trae/rules/*.md`（原生目录） | — | — | 已核（无 hook 落点） |
| Trae CN | `~/.trae-cn/skills/` | `~/.trae-cn/user_rules/*.md` | — | — | 部分（该目录存在但为空） |
| DeepSeek Harness | `~/.dsh/skills/`（或 `$DSH_HOME`） | `~/.dsh/AGENTS.md` 团队区块 | — | — | 未核（本机未装） |
| ZCode | `~/.zcode/skills/` | — | — | `~/.zcode/agents/*.md` | 已核（2026-10-13 Windows 真机：会话可用技能列表逐条列出 `~/.zcode/skills` 内容，自有 `codingagent.md` 的 name/description 出现在可用 agent 类型里；无公开的用户级 hook/MCP 载点，`~/.zcode/v2/*` 是内部应用状态不碰） |

`—` = 该工具没有对应的用户级载体：`rules` 列的 `—` 表示团队规范不下发给它，`MCP 落点` 列的 `—` 表示 `mcp/` 里的 server 不下发给它（宁可少投递，也不往它不读的位置硬写文件）。

**未核对的落点**由 `ejdrone doctor` 点名 —— 只报你在 `init` 里勾选的工具，没勾的折成一行提示，不刷屏。
所有路径与核实状态集中在 `src/agents/paths.ts` 一张表里，某工具升级改了目录只改那一行。

## Windows

**已在 Windows 10 真机上验证**（2026-10-13：全量测试真机全绿，试验时点 53 文件 / 881 例、
zcode 适配器并入后 54 文件 / 915 例；`init → pull → hook 自动 pull → doctor → uninstall`
全流程跑通，逐字节还原对账见 `docs/trials/2026-10-13-windows-real-trial.md`）。
前置是 **Git for Windows**（https://git-scm.com/download/win）：Node ≥ 20 与 Git for Windows 装上即可，
其余与 macOS/Linux 相同。

- 会话自动 pull 的 hook 命令走 Git Bash 的 `bash.exe` **绝对路径**，五路查找：`%ProgramFiles%\Git`、
  `%ProgramFiles(x86)%\Git`、`%LOCALAPPDATA%\Programs\Git`（非管理员装 Git for Windows 的默认位置，
  企业电脑极常见），再加注册表 `HKLM` 与 `HKCU` 的 `SOFTWARE\GitForWindows`。刻意不用 PATH 上的裸 `bash`——它会解析到
  WSL 启动器，跑起来的不是 MSYS2 环境，hook 会静默失效。
- 工具配置里那条命令是 `"<你的状态目录>/hooks/session-start.cmd EJDRONE_HOOK=1"`，真正的
  `bash -lc "…"` 在那份 wrapper 文件里。这么绕是因为实测下来**带引号的可执行路径打头**在
  PowerShell / pwsh 里是语法错误（它们要求 `&`），而 `&` 在 cmd 与 bash 里又是语法符号 ——
  把带引号的一层收进文件，cmd.exe、PowerShell、pwsh、Git Bash 六种启动方式才全部跑得起来。
  状态目录路径含空格时退到 `cmd.exe /c` 包装（PowerShell 与 cmd 正常，Git Bash 那一路不触发），
  `doctor` 会 WARN 点名，不会静默。
- 没装 Git for Windows 时 hook 不安装，`init` 会点名提示；这不影响手动 `ejdrone pull`，
  `doctor` 的 `win:gitbash` / `win:git` / `win:hookbash` 三项会逐条告诉你缺什么。
- MCP 条目里的 `requires:` 在 Windows 上按 `PATHEXT` 探测（`npx` 命中 `npx.cmd` 也算数）。
- **明文密钥的文件权限**：POSIX 上写 `${VAR}` 解析值会把文件收紧到 `0600`；Windows 上 NTFS 没有组/其他
  权限位，`chmod` 表达不出来（实测权限位停在 `666`）。那里的保护来自你用户目录的 NTFS ACL 继承
  —— 同机其他用户默认读不到，但**本机管理员仍读得到明文 token**。这是本轮登记的有意偏差，不是遗漏。
- **行尾**：团队仓库需要一份 `.gitattributes`（`* text=auto eol=lf`），`ejdrone readme` 与空仓库首笔提交
  会自动带上。缺它时 Windows 成员（Git for Windows 默认 `core.autocrlf=true`）检出的是 CRLF，
  换到 mac/Linux 后所有投递内容会被判成「本地已修改」而收不到更新。

## 为什么 rules 有四种投递方式

各工具读取团队规范的位置完全不同，17 个工具里分了四种：

- **rulesdir**（Claude / Qoder CN / Qoder / Trae / Trae CN）：工具的 rules 目录，逐文件、原文照抄
- **mdc**（Cursor）：`.mdc` 格式，需要重写 frontmatter（`description` / `globs` / `alwaysApply`）
- **block**（Codex / GitHub Copilot CLI / OpenCode / DeepSeek Harness）：没有 markdown rules 载体，
  只能往它们的 `AGENTS.md` 里插一个 `<!-- [ejdrone:team-rules:start] -->` 标记区块。**标记外的你自己的内容永不被动。**
- **none**（CodeBuddy / WorkBuddy / Pi / OpenClaw / Hermes / Kiro / ZCode）：既没有 rules 目录也没有可写的 `AGENTS.md`，
  团队规范**不下发给它** —— 往它不读的位置硬写文件，只会留下一份没人看的副本和一个可能被误删的用户目录。

模式由 `src/agents/paths.ts` 的表决定，`src/agents/common.ts` 一处按表分派；加新工具是填表，不是抄判断。

## 安全边界

- 你本地改过的投递文件**不会被覆盖**，只会在 `pull` / `status` 里点名（`modified-locally`）
- 不在记账里的文件视为你的文件，绝不删除
- token 只从环境变量读（`EJDRONE_GITLAB_TOKEN`，回落 `GL_TOKEN`），不落盘、不打印
- 零遥测；网络只碰团队仓库与 GitLab API
- 路径写入被限制在工具目录与仓库 checkout 内，namespace 名做白名单字符校验
- **不要在 SKILL.md / rule 里写密钥**。v1 没有 secrets 机制，靠 MR 评审兜底

## 开发

```bash
npm install
npm run typecheck
npm test              # vitest，含真实 git 的端到端用例
npm run build         # → dist/cli.js
```

`src/core/types.ts` 是跨模块契约，改动前先讨论。
