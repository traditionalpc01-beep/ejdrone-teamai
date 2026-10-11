# ejdrone-skills

把团队的 AI skills / rules 放进一个 Git 仓库，按**角色**裁剪后自动投递到每个成员的各种 AI 编程工具原生目录。
一人调好的经验走 MR 评审合入，其他人下次开会话就自动有了 —— 不用通知、不用手动复制。

15-25 人规模、只有 user scope、不建服务端。设计取舍见 `docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md`。

## 装

```bash
npm install -g ejdrone-skills   # 内网 npm 源
ejdrone --version
```

前置：Node.js ≥ 20、git。

## 管理员：建团队仓库

在 Git 托管上建一个空仓库（建议 `ejdrone-teamai`），给全员 write 权限，然后：

```bash
cd /path/to/your-project
ejdrone init https://gitlab.example.com/team/ejdrone-teamai.git
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
ejdrone init https://gitlab.example.com/team/ejdrone-teamai.git
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
ejdrone init https://code.example.com/team/ejdrone-teamai.git --provider gitlab
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

## 命令

| 命令 | 作用 |
|---|---|
| `init <repo>` | 选定工具与角色、装 hook、首次 pull |
| `pull [--force] [--silent]` | 同步团队仓库并投递。`--force` 覆盖本地改过的整文件投递（团队区块只动区块） |
| `push [--skill p] [--rule p] [--all] [--role id] [--ns ns]` | 推资源，自动分支 + MR |
| `status` | 待推送 / 落后 / 本地改动 |
| `list [skills\|rules] [--source repo\|local\|all]` | 列资源及其 namespace 与根条目归属 |
| `roles list\|set <id> [--add ids]` | 本地订阅哪些角色 |
| `roles add\|remove <id>` | 管理员改团队 manifest（走 MR） |
| `remove <kind> <name...>` | 从**仓库**删除资源（走 MR）。不动你本地副本 —— 合入后 `pull` 会自动移除 |
| `readme` | 生成/更新团队仓库首页的 `README.md`（走 MR）。空仓库初始化时会自动带一份，已有仓库补一份用这个 |
| `doctor [--json]` | 体检：config / 仓库 / manifest / hook / 投递记账 / 落点核对状态 |
| `uninstall [--force]` | 移除 hook 与投递的文件；撤掉未被你改过的团队区块（AGENTS.md 本体与标记外内容保留）；保留 config 和你改过的副本 |

出问题先跑 `ejdrone doctor`。`--silent` 模式下（hook 用的就是它）问题只写 `~/.ejdrone/debug.log` 且恒返回 0，不会挡住你开工具。

## 支持的工具

16 个工具，全部只有 user scope。「真机核实」列是本机（macOS）逐项盘出来的，没核到的格子一律标出来，不猜。

| 工具 | skills | rules | MCP 落点 | 真机核实 |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/rules/*.md`（官方用户级载体，支持 `paths:` 按需加载） | `~/.claude.json` | 已核 |
| Qoder CN | `~/.qoder-cn/skills/` | `~/.qoder-cn/rules/*.md` | `~/.qoder-cn/settings.json` | 部分（rules 是否被读取未证） |
| Qoder | `~/.qoder/skills/` | `~/.qoder/rules/*.md` | `~/.qoder/mcp.json` | 部分（rules 与 hook 未证） |
| Cursor | `~/.cursor/skills/` | `~/.cursor/rules/*.mdc` | `~/.cursor/mcp.json` | 未核（本机未装） |
| Codex | `~/.codex/skills/` | `~/.codex/AGENTS.md` 团队区块（其原生 `rules/` 是命令策略目录，非 markdown） | `~/.codex/config.toml` | 部分（hook 未核） |
| GitHub Copilot CLI | `~/.copilot/skills/`（或 `$COPILOT_HOME`） | `~/.copilot/AGENTS.md` 团队区块 | `~/.copilot/mcp-config.json` | 未核（本机未装） |
| CodeBuddy | `~/.codebuddy/skills/` | — | `~/.codebuddy/.mcp.json` | 部分（hook 未证） |
| WorkBuddy | `~/.workbuddy/skills/` | — | `~/.workbuddy/mcp.json` | 部分（hook 未证） |
| OpenCode | `~/.config/opencode/skills/` | `~/.config/opencode/AGENTS.md` 团队区块 | `~/.config/opencode/opencode.json` | 未核（本机未装） |
| Pi Coding Agent | `~/.pi/agent/skills/` | — | `~/.pi/agent/mcp.json` | skills 已核 |
| OpenClaw | `~/.openclaw/skills/` | — | — | skills 已核（hook 是 workspace 级，user scope 不做） |
| Hermes | `~/.hermes/skills/` | — | — | skills 已核（`~/.hermes/hooks` 是目录，非 JSON 载体） |
| Kiro | `~/.kiro/skills/` | — | `~/.kiro/settings/mcp.json` | skills 已核（SessionStart 由 agent 同步内嵌，无用户级落点） |
| Trae | `~/.trae/skills/` | `~/.trae/rules/*.md`（原生目录） | — | 已核（无 hook 落点） |
| Trae CN | `~/.trae-cn/skills/` | `~/.trae-cn/user_rules/*.md` | — | 部分（该目录存在但为空） |
| DeepSeek Harness | `~/.dsh/skills/`（或 `$DSH_HOME`） | `~/.dsh/AGENTS.md` 团队区块 | — | 未核（本机未装） |

`—` = 该工具没有可写的 markdown rules 载体，团队规范不下发给它（宁可少投递，也不往它不读的位置硬写）。

`—` = 该工具没有对应的用户级载体：`rules` 列的 `—` 表示团队规范不下发给它，`MCP 落点` 列的 `—` 表示 `mcp/` 里的 server 不下发给它（宁可少投递，也不往它不读的位置硬写文件）。

**未核对的落点**由 `ejdrone doctor` 点名 —— 只报你在 `init` 里勾选的工具，没勾的折成一行提示，不刷屏。
所有路径与核实状态集中在 `src/agents/paths.ts` 一张表里，某工具升级改了目录只改那一行。

Windows 未支持（v1 仅 macOS / Linux；2.0 的 M10 处理）。

## 为什么 rules 有四种投递方式

各工具读取团队规范的位置完全不同，16 个工具里分了四种：

- **rulesdir**（Claude / Qoder CN / Qoder / Trae / Trae CN）：工具的 rules 目录，逐文件、原文照抄
- **mdc**（Cursor）：`.mdc` 格式，需要重写 frontmatter（`description` / `globs` / `alwaysApply`）
- **block**（Codex / GitHub Copilot CLI / OpenCode / DeepSeek Harness）：没有 markdown rules 载体，
  只能往它们的 `AGENTS.md` 里插一个 `<!-- [ejdrone:team-rules:start] -->` 标记区块。**标记外的你自己的内容永不被动。**
- **none**（CodeBuddy / WorkBuddy / Pi / OpenClaw / Hermes / Kiro）：既没有 rules 目录也没有可写的 `AGENTS.md`，
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
