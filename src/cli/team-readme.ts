/**
 * 团队仓库首页的说明书 —— 无依赖的纯模板，空仓库引导提交与 ejdrone readme 共用。
 * 放在叶子模块是因为 cli/mr.ts 也要用它，而 readme.ts 反过来要用 mr.ts，不能让它们互相引用。
 */

export function teamReadme(repo: string, branch: string): string {
  return `# 团队 AI 资产仓库

这个仓库是团队 AI 编程工具的**唯一真相源**。写在这里的技能与规范，会由 \`ejdrone\` 命令行工具
同步到每位成员机器上各个 AI 工具的原生目录；变更走合并请求评审，合入后大家下次打开 AI 会话自动拿到。

- 本仓库地址：\`${repo}\`
- 默认分支：\`${branch}\`（一切变更通过 MR 合进这里，不要直接推 \`main\`）

## 谁负责什么

| 角色 | 谁 | 职责 |
|---|---|---|
| 管理员 | 建这个仓库的人 | 首次初始化、定义角色（\`ejdrone roles add\`）、评审合入、维护本文件 |
| 成员 | 其他所有人 | 一行命令加入，之后日常零操作 |

## 成员：怎么加入

\`\`\`bash
npm install -g ejdrone-skills        # 或从团队内网 npm 源安装
ejdrone init ${repo}
ejdrone doctor                       # 逐项体检，全绿即完成
\`\`\`

\`init\` 会让你勾选自己在用的 AI 工具、选择自己的角色。完成后每次开 AI 会话都会自动同步，
不需要手动 \`pull\`，也不需要任何人通知你"有新东西了"。

## 成员：怎么退出

\`\`\`bash
ejdrone uninstall --force
\`\`\`

移除工具装的 hook、删掉由它投递的文件、撤掉它写的团队区块。**你自己改过的内容一律保留**，
config 也留着（重装时无需重新配置）。

## 仓库里放什么

\`\`\`text
manifest/roles.yaml                角色 → namespace 的映射
skills/<name>/SKILL.md             全员共享的技能
skills/<ns>/<name>/SKILL.md        只给某角色（namespace = <ns>）的技能
rules/<name>.md                    全员共享的规范
rules/<ns>/<name>.md               只给某角色的规范
\`\`\`

**这条规矩最重要**：全员共享的放根目录，只给某个角色的才放 namespace。
同名条目里 namespace 会**整体替换**根目录版本、不做字段合并 —— 把共享内容误写进某个 namespace，
激活该 namespace 的成员会同时收到两份，其他人一份都收不到。

## 怎么提交新内容

\`\`\`bash
# 1) 先写在自己工具的技能目录里，试到满意为止
#    例如 ~/.claude/skills/my-skill/SKILL.md
# 2) 推给团队：自动建分支并开合并请求
ejdrone push --skill ~/.claude/skills/my-skill
# 3) 请另一位成员评审合入
# 4) 合入后所有人下次会话自动拿到
\`\`\`

同一条资源重复 push 会就地更新那条未合并的分支，不会开重复的 MR。
删除走 \`ejdrone remove <skills|rules> <名字>\`，同样是先评审合入、再由 \`pull\` 从各人机器上移除。

## 内容会落到我机器的哪里

只投递**你选定的工具** × **你订阅的角色**两份交集，前端不会收到运维的技能：

| 工具 | 技能 | 规范 |
|---|---|---|
| Claude Code | \`~/.claude/skills/\` | \`~/.claude/rules/*.md\` |
| Qoder CN | \`~/.qoder-cn/skills/\` | \`~/.qoder-cn/rules/*.md\` |
| Cursor | \`~/.cursor/skills/\` | \`~/.cursor/rules/*.mdc\` |
| Codex | \`~/.codex/skills/\` | \`~/.codex/AGENTS.md\` 里的团队区块 |
| DeepSeek Harness | \`~/.dsh/skills/\` | \`~/.dsh/AGENTS.md\` 里的团队区块 |

区块形式的工具里，标记外的内容是你自己的，工具从不改动；卸载时也只撤掉我们那一段。

## 遇到问题

\`\`\`bash
ejdrone doctor      # 配置、仓库连通、manifest、hook、投递记账逐项体检
ejdrone status      # 待推送 / 落后 / 本地已改动的内容
ejdrone list        # 团队有什么、我这次会拿到什么
cat ~/.ejdrone/debug.log   # 会话自动同步的失败记录
\`\`\`

## 不要提交到这个仓库

密钥、token、内部账号口令、客户数据。技能与规范里出现凭据会被评审打回。
这个工具不做密钥托管（v1 未实现 \`env/secrets\`），请用环境变量或各工具自己的凭据存储。
`;
}
