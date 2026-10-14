/**
 * 团队仓库首页的说明书 —— 空仓库引导提交与 ejdrone readme 共用。
 * 放在叶子模块是因为 cli/mr.ts 也要用它，而 readme.ts 反过来要用 mr.ts，不能让它们互相引用。
 *
 * 投递矩阵从 `agents/paths.ts` 生成：手写一张 16 行的表一定会过期，
 * 而这张表是成员判断"我的东西落在哪"的唯一依据（1.0 试验记录的缺陷 5「团队仓库是黑箱」就是这类漂移）。
 */

import type { ToolPathSpec } from '../agents/paths.js';
import { TOOL_PATHS } from '../agents/paths.js';

function skillsCell(spec: ToolPathSpec): string {
  return `~/${spec.rootRel}/${spec.skillsSubdir}/`;
}

function rulesCell(spec: ToolPathSpec): string {
  switch (spec.rulesMode) {
    case 'rulesdir':
      return `~/${spec.rootRel}/${spec.rulesSubdir ?? 'rules'}/*.${spec.rulesExt ?? 'md'}`;
    case 'mdc':
      return `~/${spec.rootRel}/${spec.rulesSubdir ?? 'rules'}/*.mdc`;
    case 'block':
      return `~/${spec.rootRel}/${spec.rulesBlockFile ?? 'AGENTS.md'} 里的团队区块`;
    case 'none':
      return '不下发（该工具没有 markdown rules 载体）';
  }
}

function mcpCell(spec: ToolPathSpec): string {
  const target = spec.mcpTarget;
  if (!target) return '不下发（该工具没有用户级 MCP 落点）';
  // Claude 的 `~/.claude.json` 不在 `~/.claude/` 下，用 homeFile 表达（表里唯一的例外）
  if (target.homeFile) return `~/${target.homeFile} 里的 ${target.pointer.join('.')}`;
  return `~/${spec.rootRel}/${target.file} 里的 ${target.pointer.join('.')}`;
}

function rootCell(spec: ToolPathSpec): string {
  return spec.rootEnvVar ? `${spec.label}<br>（或 \$${spec.rootEnvVar}）` : spec.label;
}

function deliveryMatrix(): string {
  const rows = Object.values(TOOL_PATHS)
    .map(
      (spec) =>
        `| ${rootCell(spec)} | \`${skillsCell(spec)}\` | \`${rulesCell(spec)}\` | \`${mcpCell(spec)}\` |`,
    )
    .join('\n');
  return `| 工具 | 技能 | 规范 | MCP |\n|---|---|---|---|\n${rows}`;
}

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
npm install -g ejdrone-teamai        # 或从团队内网 npm 源安装
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
mcp/mcp.yaml                       全员共享的 MCP server 清单
mcp/<ns>/mcp.yaml                  只给某角色的 MCP server 清单
\`\`\`

**这条规矩最重要**：全员共享的放根目录，只给某个角色的才放 namespace。
同名条目里 namespace 会**整体替换**根目录版本、不做字段合并 —— 把共享内容误写进某个 namespace，
激活该 namespace 的成员会同时收到两份，其他人一份都收不到。
多角色共用的内容（比如开发和运维都要用的工具）也放根目录；只有「放在某角色 namespace 里、
但另一个角色也要用」的个别条目才用标签（见下一节）。

\`skills/ejdrone-recall/\` 与 \`skills/ejdrone-share/\` 是**内置引导技能**：由 \`ejdrone readme\` 随本说明书一起补进仓库
（前者教 agent 动手前先 \`ejdrone recall\` 检索团队既有做法，后者教它把踩坑沉淀成 learning 交给 \`ejdrone contribute\`）。
它们进仓库后就是普通根技能，与你们自己写的没有任何区别：成员可删可改，想定制就直接改这两个文件并走 MR。
\`ejdrone push\` 拒绝用同名条目覆盖仓库里的那份（保留名），就是为了不让某个人本地的改动绕过评审变成全员的教材。

## 标签订阅（跨角色用个别条目）

条目留在某个角色的 namespace 里、但另一个角色也需要时，给**条目**打标签，别挪目录也别建新 namespace：

\`\`\`yaml
# SKILL.md / rule / agent / doc / learning 的 frontmatter，或 mcp 条目的字段
tags: [ops-tools]
\`\`\`

成员按需订阅：\`ejdrone tags list\` 看仓库现有标签 → \`ejdrone tags subscribe ops-tools\` →
下次 \`pull\` 带这个标签的条目会跨 namespace 额外下发；退订后自动撤走。
打标/改标走 \`ejdrone tags add <kind> <名字> <标签>\`（开 MR 评审），或直接在仓库里改 frontmatter。
标签不影响替换与冲突规则，根条目对全员照常下发（标签写了也无效）。

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
删除走 \`ejdrone remove <skills|rules|mcp> <名字>\`，同样是先评审合入、再由 \`pull\` 从各人机器上移除。

## MCP 服务：怎么写、怎么提交

\`mcp/mcp.yaml\`（全员）与 \`mcp/<ns>/mcp.yaml\`（只给某角色）各是一份 server 清单：

\`\`\`yaml
servers:
  - name: shared-formatter        # 小写字母、数字、-、_
    description: 统一格式化
    transport: stdio              # stdio | http | sse
    command: npx                  # stdio 用
    args: ['-y', '@acme/formatter-mcp']
  - name: be-metrics
    transport: http               # http / sse 用 url
    url: https://metrics.example.com/mcp
    headers:
      Authorization: Bearer \${BE_METRICS_TOKEN}   # 凭据写成 \${VAR}
\`\`\`

- **密钥不要写进仓库**。凭据一律写成 \`\${VAR}\`，\`pull\` 时从每个人自己的环境变量里取值；
  谁缺这个变量，谁的这条 server 就跳过并在 \`ejdrone doctor\` / \`pull\` 里点名（值不会被打印）。
- 在自己工具里调好一条 server 后，可以直接采进来：\`ejdrone push --mcp <名字>\`。
  它只读你选定工具的用户级 MCP 配置，并把看着像凭据的值自动改写成 \`\${VAR}\` 再入库。
  \`ejdrone list mcp --source local\` 能先看到各工具里都有哪几条（只列名字）。
- 投递是**条目级合并**：只动清单里那几条，你自己配的 server 一条都不会被碰；
  我们投的那条如果你改过，\`pull\` 保留你的版本并点名。
- 只在个别工具好用的 server 可以用 \`tools: [claude, qoder-cn]\` 限定下发范围。

## 内容会落到我机器的哪里

只投递**你选定的工具** × **你订阅的角色**两份交集，前端不会收到运维的技能：

${deliveryMatrix()}

区块形式的工具里，标记外的内容是你自己的，工具从不改动；卸载时也只撤掉我们那一段。
未核对的落点由 \`ejdrone doctor\` 点名（它只报你真的勾选了的工具），工具升级改了目录时先看它。

## 遇到问题

\`\`\`bash
ejdrone doctor      # 配置、仓库连通、manifest、hook、投递记账逐项体检
ejdrone status      # 待推送 / 落后 / 本地已改动的内容
ejdrone list        # 团队有什么、我这次会拿到什么
ejdrone tags list   # 仓库标签与我的标签订阅
cat ~/.ejdrone/debug.log   # 会话自动同步的失败记录
\`\`\`

## 不要提交到这个仓库

密钥、token、内部账号口令、客户数据。技能与规范里出现凭据会被评审打回。
这个工具不做密钥托管（v1 未实现 \`env/secrets\`），请用环境变量或各工具自己的凭据存储。
`;
}

/**
 * 团队仓库的 `.gitattributes`（2026-10-13 Windows 真机试验引出）。
 *
 * 为什么必须由工具带进仓库、不能靠成员自觉：Git for Windows 安装器默认把
 * `core.autocrlf=true` 写进用户级配置，于是同一份团队仓库在 mac/Linux 成员机器上检出是 LF、
 * 在 Windows 成员机器上检出是 CRLF。投递产物跟着检出走，结果是：
 *  - 成员从 mac 换到 Windows（或反过来）后，账本里每个文件的哈希都对不上，
 *    pull 把**全部内容**判成「本地已修改」→ 全员静默收不到更新，只有一屏点名；
 *  - codex 的 agent `.toml` 会把正文里的 CRLF 转义成字面 `\r\n` 嵌进 developer_instructions。
 * 一条 `eol=lf` 就把跨 OS 团队的字节一致性钉死，成本是仓库里多一个文件。
 */
export function teamGitattributes(): string {
  return [
    '# 由 ejdrone 写入：团队资产的文件尾统一 LF，不随成员的 core.autocrlf 变化。',
    '# 删掉这个文件会让 Windows 成员检出 CRLF，换机后所有投递内容被判成「本地已修改」。',
    '* text=auto eol=lf',
    '# 二进制资产（图标、字体、压缩包）不做行尾转换',
    '*.png binary',
    '*.jpg binary',
    '*.jpeg binary',
    '*.gif binary',
    '*.ico binary',
    '*.zip binary',
    '*.gz binary',
    '',
  ].join('\n');
}
