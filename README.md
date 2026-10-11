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

仓库里的结构就是全部真相：

```
manifest/roles.yaml        # 角色 → namespace 映射
skills/
  team-release/SKILL.md   # 根目录 = 全员
  fe/fe-code-review/SKILL.md
  devops/ops-deploy/SKILL.md
rules/
  code-style.md            # 全员
  fe/react-conventions.md
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
| `doctor [--json]` | 体检：config / 仓库 / manifest / hook / 投递记账 / 落点核对状态 |
| `uninstall [--force]` | 移除 hook 与投递的文件；撤掉未被你改过的团队区块（AGENTS.md 本体与标记外内容保留）；保留 config 和你改过的副本 |

出问题先跑 `ejdrone doctor`。`--silent` 模式下（hook 用的就是它）问题只写 `~/.ejdrone/debug.log` 且恒返回 0，不会挡住你开工具。

## 支持的工具

| 工具 | skills | rules |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `~/.claude/rules/*.md`（官方用户级载体，支持 `paths:` 按需加载） |
| Qoder CN | `~/.qoder-cn/skills/` | `~/.qoder-cn/rules/*.md`（落点待真机核对，见下） |
| Cursor | `~/.cursor/skills/` | `~/.cursor/rules/*.mdc` |
| Codex | `~/.codex/skills/` | `~/.codex/AGENTS.md` 团队区块（Codex 无 markdown rules 目录） |
| DeepSeek Harness | `$DSH_HOME/skills/`（默认 `~/.dsh`） | `$DSH_HOME/AGENTS.md` 团队区块 |

**尚未真机核实的落点**（`ejdrone doctor` 会以 WARN 逐条列出）：Qoder CN 的 rules 目录是否被读取、
Cursor / Codex / DeepSeek Harness 的 hook 落点与事件名。这些工具升级后可能变化，
所有路径集中在 `src/agents/paths.ts` 一张表里，改一处即可。

Windows 未支持（v1 仅 macOS / Linux）。

## 为什么 rules 有三种投递方式

各工具读取团队规范的位置完全不同：Claude / Qoder 是 rules 目录逐文件、Cursor 是 `.mdc`（要 frontmatter），
Codex 与 DeepSeek Harness 根本没有 markdown rules 目录，只能往它们的 `AGENTS.md` 里插一个
`<!-- [ejdrone:team-rules:start] -->` 标记区块。**标记外的你自己的内容永不被动。**

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
