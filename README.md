# ejdrone-skills

把团队的 AI 技能、规范、MCP server、子 Agent、文档与踩坑经验放进一个 Git 仓库，按**角色**裁剪后
自动投递到每个成员的 AI 编程工具。一人调好、MR 评审合入，其他人下次开会话自动就有 —— 不通知、不复制。
只有 user scope，不建服务端，零遥测。

## 它是什么

| 资源 | 仓库里 | 到成员机器上 |
|---|---|---|
| skills | `skills/` | 各工具的 skills 目录，AI 会话里直接可用 |
| rules | `rules/` | 各工具的规范载体（rules 目录 / `.mdc` / `AGENTS.md` 区块） |
| mcp | `mcp/mcp.yaml` | 写进各工具自己的 MCP 配置文件，只动我们那几条 |
| agents | `agents/*.md` | 按各工具的格式转换后放进 agents 目录 |
| docs | `docs/` | 镜像到 `~/.ejdrone/knowledge/`，`recall` 一条命令检索 |
| learnings | `learnings/` | 同上；`contribute` 一条命令把踩坑经验回流进仓库 |

角色（全员 / 前端 / 运维…）由 `manifest/roles.yaml` 决定谁拿到哪部分：共享内容放根目录，
差异化内容放 `skills/<ns>/` 这类 namespace 子目录。同一内容误放进激活的 namespace 会被下发两份。

## 安装

前置：Node.js ≥ 20 与 git；Windows 另需 [Git for Windows](https://git-scm.com/download/win)。

```bash
# 从 Codeup 源码仓直装：复用你克隆团队仓库的同一份 git 凭据，无需配置 npm 源
npm install -g "git+https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-skills.git#v2.0.3"
ejdrone --version                # 打印版本号即安装成功
```

升级 = 换新 tag 重装同一条命令（`#v2.0.3` …）。
备用通道（CI / 无法走 git 时）：云效制品库 npm 源
`npm config set registry https://packages.aliyun.com/64084f5656067d3aad3e0d11/npm/npm-registry/`
后 `npm install -g ejdrone-skills`；首次使用需在制品库页面取个人 npm 凭据写进 `~/.npmrc`。

Windows 的会话自动 pull 依赖 Git for Windows 的 bash；没装时 hook 不安装（`init` 会提示），
手动 `ejdrone pull` 不受影响。

## 快速上手

### 1. 管理员：建团队仓库

在 Git 托管上建一个空仓库（如 `ejdrone-team`），给全员 write 权限：

```bash
ejdrone init https://gitlab.example.com/team/ejdrone-team.git
ejdrone doctor          # 逐项体检，全绿才算就绪
```

空仓库的首笔提交自带 `README.md`，说明这仓库是什么、成员怎么加入；内容过期了用 `ejdrone readme` 重新生成。
定义角色：

```bash
ejdrone roles add fe --namespaces fe -d "前端"
ejdrone roles add devops --namespaces devops -d "运维/流程"
```

### 2. 成员：加入（3 分钟）

```bash
ejdrone init https://gitlab.example.com/team/ejdrone-team.git
# 交互里勾选在用的工具、选自己的角色
ejdrone list            # 看拿到了什么
```

之后日常零操作：会话启动时 hook 自动 `pull`。脚本 / CI 可跳过交互：
`ejdrone init <repo> --agent qoder-cn,claude --role devops --force`。

### 3. 日常：分享与沉淀

```bash
# 分享一条 skill：写在自己的工具目录里，推上去自动开分支 + MR
ejdrone push --skill ~/.claude/skills/team-release

# 检索团队文档与经验
ejdrone recall "kafka 消费积压"

# 把踩坑记录沉淀进团队知识（补全 frontmatter → 自动分支 + MR）
ejdrone contribute --file ./notes.md
```

合入后队友下次开会话自动拉到，想立刻拿到就 `ejdrone pull`。两条内置技能（`ejdrone-recall`、
`ejdrone-share`）随 `ejdrone readme` 入库后作为普通 skill 下发，教 AI 动手前先检索、
被反复纠正时提议沉淀；这两个名字是保留名，不能用本地同名文件覆盖。

## 下发 MCP server

`mcp/mcp.yaml` 声明一次，`pull` 时按每个工具的原生格式写进它自己的 MCP 配置：

```yaml
servers:
  - name: gpu-analysis
    transport: http            # stdio | http | sse
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}   # 从成员环境变量取，不写明文

  - name: local-formatter
    transport: stdio
    command: npx
    args: ['-y', '@acme/formatter-mcp']
    requires: [npx]            # PATH 上没有 npx 的成员自动跳过并点名
    tools: [claude, cursor]    # 可选：只发给这些工具
```

- 按条目合并：配置里你自己的 server 一字不改，卸载只撤我们的条目
- 你改过我们投的条目就不覆盖，`pull` 会点名是哪一条
- `${VAR}` 取不到值就整条跳过并提示缺哪个变量，值不进任何输出与日志
- `mcp/<ns>/mcp.yaml` 只发给对应角色；同名时整体替换根条目
- `mcp.yaml` 写坏时本次 MCP 整体停发并点名文件，不会清空已装内容

调好的 server 可以直接采进仓库，不用手抄：

```bash
ejdrone list mcp --source local      # 看本机各工具配置里有哪几条（只列名字，不列值）
ejdrone push --mcp local-formatter   # 反向采集 → 自动分支 + MR
```

采集时看着像凭据的值会自动改写成 `${VAR}` 再入库；改写不了的（凭据嵌在命令行参数或 URL 里）拒绝入库。
`remove mcp <名字>` 只删仓库（走 MR），合入后各成员的下一次 `pull` 自动移除。

## 下发子 Agent

`agents/<名字>.md`（带 frontmatter）投到各工具自己的 agents 目录，投递时按工具转换格式：

| 形态 | 工具 | 落点文件 |
|---|---|---|
| markdown | Claude / Qoder / Qoder CN / Cursor / CodeBuddy / WorkBuddy / OpenCode / ZCode | `agents/<名字>.md` |
| Copilot 形 | GitHub Copilot CLI | `agents/<名字>.agent.md` |
| TOML | Codex | `agents/<名字>.toml` |
| JSON | Kiro | `agents/<名字>.json` |

`agents/<ns>/<名字>.md` 只发给对应角色，同名时整体替换根条目。
DeepSeek Harness、Pi、OpenClaw、Trae、Trae CN、Hermes 没有用户级 agents 落点，不投递。
自己写好的 agent 同样可以反向采集：`ejdrone push --agent code-reviewer`（多工具同名且内容不同时会
要求 `--tool <id>` 说清采哪份）。

## 命令

| 命令 | 作用 |
|---|---|
| `init <repo>` | 选定工具与角色、装 hook、首次 pull |
| `pull [--force] [--silent]` | 同步团队仓库并投递。`--force` 覆盖本地改过的整文件投递（团队区块只动区块） |
| `push [--skill p] [--rule p] [--mcp name] [--agent path] [--tool id] [--all] [--role id] [--ns ns]` | 推资源，自动分支 + MR。`--mcp` / `--agent` 从本机反向采集，各自单独一个 MR；`--tool` 缩小采集范围；`--all` 只含 skills/rules |
| `status` | 待推送 / 落后 / 本地改动（含 MCP） |
| `list [kind] [--source repo\|local\|all]` | 列资源及其 namespace 归属；`list mcp --source local` 只列名字与文件路径，不回显值 |
| `recall "<关键词>" [--check] [--json]` | 检索团队知识（docs + learnings）。`--check` 只判相关性，退出码 0 / 1 |
| `contribute --file <path> [--title t] [--ns ns] [--dry-run]` | 把踩坑记录沉淀成 learning 并走 MR 入库 |
| `roles list\|set <id> [--add ids]` | 本地订阅哪些角色 |
| `roles add\|remove <id>` | 管理员改团队 manifest（走 MR） |
| `remove <kind> <name...>` | 从**仓库**删除资源（走 MR）。本地副本不动，合入后 `pull` 自动移除 |
| `readme` | 生成/更新团队仓库首页 README，并带上两份内置技能 |
| `doctor [--json]` | 体检：config / 仓库 / manifest / hook / 投递记账 / MCP 四项 |
| `uninstall [--force]` | 移除 hook 与投递的文件，保留 config 和你改过的副本 |

出问题先跑 `ejdrone doctor`。`--silent` 模式（hook 用的就是它）下问题只写 `~/.ejdrone/debug.log`
且不阻断开工具。

## 支持的工具

17 个工具，全部只有 user scope。`—` 表示该工具没有对应的用户级载体，对应资源不下发 —— 不往
工具不读的位置硬写文件。rules 走 `AGENTS.md` 区块的工具，标记区外的内容永不改动。

| 工具 | skills | rules | MCP 落点 | agents 落点 | 核实 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/rules/*.md` | `~/.claude.json` | `~/.claude/agents/*.md` | 已核 |
| Qoder CN | `~/.qoder-cn/skills/` | `~/.qoder-cn/rules/*.md` | `~/.qoder-cn/settings.json` | `~/.qoder-cn/agents/*.md` | 部分（rules 未证） |
| Qoder | `~/.qoder/skills/` | `~/.qoder/rules/*.md` | `~/.qoder/mcp.json` | `~/.qoder/agents/*.md` | 部分（rules、hook 未证） |
| Cursor | `~/.cursor/skills/` | `~/.cursor/rules/*.mdc` | `~/.cursor/mcp.json` | `~/.cursor/agents/*.md` | 未核 |
| Codex | `~/.codex/skills/` | `~/.codex/AGENTS.md` 区块 | `~/.codex/config.toml` | `~/.codex/agents/*.toml` | 部分（hook 未核） |
| GitHub Copilot CLI | `~/.copilot/skills/` | `~/.copilot/AGENTS.md` 区块 | `~/.copilot/mcp-config.json` | `~/.copilot/agents/*.agent.md` | 未核 |
| CodeBuddy | `~/.codebuddy/skills/` | — | `~/.codebuddy/.mcp.json` | `~/.codebuddy/agents/*.md` | 部分（hook 未证） |
| WorkBuddy | `~/.workbuddy/skills/` | — | `~/.workbuddy/mcp.json` | `~/.workbuddy/agents/*.md` | 部分（hook 未证） |
| OpenCode | `~/.config/opencode/skills/` | `~/.config/opencode/AGENTS.md` 区块 | `~/.config/opencode/opencode.json` | `~/.config/opencode/agents/*.md` | 未核 |
| Pi Coding Agent | `~/.pi/agent/skills/` | — | `~/.pi/agent/mcp.json` | — | skills 已核 |
| OpenClaw | `~/.openclaw/skills/` | — | — | — | skills 已核 |
| Hermes | `~/.hermes/skills/` | — | — | — | skills 已核 |
| Kiro | `~/.kiro/skills/` | — | `~/.kiro/settings/mcp.json` | `~/.kiro/agents/*.json` | skills 已核 |
| Trae | `~/.trae/skills/` | `~/.trae/rules/*.md` | — | — | 已核 |
| Trae CN | `~/.trae-cn/skills/` | `~/.trae-cn/user_rules/*.md` | — | — | 部分 |
| DeepSeek Harness | `~/.dsh/skills/` | `~/.dsh/AGENTS.md` 区块 | — | — | 已核（Windows）；hook 未核 |
| ZCode | `~/.zcode/skills/` | — | — | `~/.zcode/agents/*.md` | 已核（Windows）；无 hook/MCP 载点 |

未核对的落点由 `ejdrone doctor` 在 init 时逐项点名。全部路径集中在 `src/agents/paths.ts` 一张表里，
核实过程与证据见 `docs/trials/`。

## 与 teamai-cli 怎么选

ejdrone-skills 以腾讯开源的 [teamai-cli](https://github.com/Tencent/teamai-cli) 为对标做减法：
落点表初稿取自其公开文档，再逐项真机核实；`recall --check` 退出码、坏 `mcp.yaml` 整体停发等语义
与其保持一致，两个产品之间可低成本迁移。差异：

| 维度 | ejdrone-skills | teamai-cli |
|---|---|---|
| 资源类型 | 6 类 | 11 类（另含 env、hooks、models、teamwiki 等） |
| 支持工具 | 17 个 | 19 个（多 omp、joycode） |
| 部署 | 纯 Git 仓库，无服务端 | teamwiki / dashboard 等依赖本地服务与上报 |
| 变更治理 | 一切入库变更走 MR（含经验沉淀） | 经验沉淀走孤儿分支直推，不经评审 |
| 密钥 | `${VAR}` 从环境变量解析，不落盘 | env/secrets 子系统，成员本地存值 |
| 知识检索 | 轻量打分，无索引无状态 | 持久索引 + 投票 + 晋升机制 |
| 适用规模 | 15-25 人，单人可维护 | 更大团队 |

要更全的资源类型与服务端周边能力、团队规模更大，选 teamai-cli；要最小依赖、一切变更可评审、
单人维护得起，选 ejdrone-skills。

## 安全边界

- 本地改过的投递文件不会被覆盖，`pull` / `status` 只点名
- 不在记账里的文件视为用户文件，绝不删除
- token 只从 `EJDRONE_GITLAB_TOKEN`（回落 `GL_TOKEN`）读，不落盘、不打印
- 零遥测；网络只访问团队仓库与 GitLab API
- 不要把密钥写进 SKILL.md / rule，入库内容靠 MR 评审兜底

## 文档

- 设计取舍与理由：`docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md`
- 真机试验与验证记录：`docs/trials/`
- 改代码前的开发指引：`AGENTS.md`

## 开发

```bash
npm install
npm run typecheck
npm test              # vitest，含真实 git 的端到端用例
npm run build         # → dist/cli.js
```

`src/core/types.ts` 是跨模块契约，改动前先讨论。
