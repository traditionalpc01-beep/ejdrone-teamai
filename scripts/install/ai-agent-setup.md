# ejdrone-teamai 安装委托书

> **成员用法**：把本文件**从下一行到文末**的全部内容复制给你在用的 AI 编程工具
> （ZCode / Claude Code / Qoder / Cursor / Codex 等能执行命令的那种），并先填好下面
> 两行。之后按它的提问回答即可，全程大约五分钟。
>
> - 我的角色职责：`（例：产品经理 / 前端开发 / 测试）`
> - 安装脚本位置：`（管理员给的二选一：https://…/ejdrone-setup.ps1，或本机下载路径）`

---

你是安装助手。目标：在这台电脑上安装 ejdrone-teamai 命令行，并把团队技能库投递到
成员在用的 AI 工具目录。**只做用户级安装**（当前用户目录与用户环境变量），不使用
管理员权限、不改系统配置。每完成一步向成员简报一句；失败时先把错误原文展示给成员，
再按「失败处置」行动，不做猜测性的连续重试。

## 仓库信息

- 团队资产仓（技能与规范从这里投递，init 用）：`https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai.git`
- CLI 源码仓（本机有 git 时的直装通道）：`https://codeup.aliyun.com/ejdrone/1C5P/ejdrone-teamai-cli.git`（tag 形如 `#v2.1.2`，以管理员最新发布为准）

## 第 1 步：环境盘点

依次运行并记录结果：`node -v`、`git --version`。
- Windows 且拿到了安装脚本位置 → 走 **A 线**（优先，脚本里有多轮真机打磨的护栏）。
- macOS / Linux / 没有脚本 → 走 **B 线**。

## A 线：驱动安装脚本（Windows）

运行（路径换成成员提供的那个）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File <安装脚本位置>
```

- 脚本幂等，已装好的部分自动复用；**不要传 -Role 参数**——角色由第 3 步用对话确认，
  比烤死在命令里更符合成员的真实职责。
- 脚本自己的输出已经是中文分步的：顺利就让成员等它跑完；失败把报错原文给成员看，
  按脚本提示处理后**最多重试一次**，仍失败就停止并汇报。
- 脚本成功后跳到第 3 步。

## B 线：手动安装（macOS / Linux / Windows 无脚本）

1. **Node ≥ 20 缺失时**先装 Node：macOS `brew install node@20`；Linux 用发行版包管理器
   或 nvm；Windows 无脚本时优先向管理员要脚本，实在没有再征得成员同意后
   `winget install OpenJS.NodeJS.LTS`（会弹管理员授权，成员点同意即可）。
2. **装 CLI**：
   - 本机有 git：`npm install -g "git+<CLI 源码仓>#<最新 tag>"`（复用成员的 git 凭据，不需要 npm 源凭据）；
   - 本机没有 git：向管理员要制品库安装命令（需要凭据，不要自行猜测源地址）。
3. `ejdrone --version` 打出版本号才算装上。
4. `ejdrone init <团队资产仓> --force`——工具清单会自动探测本机已装的 AI 工具；此刻
   **不设角色**（下一步对话确认）。如果报错说本机没有 git、需要免 git 模式：向成员要
   `EJDRONE_CODEUP_TOKEN`（管理员发的云效个人访问令牌），写入**用户级**环境变量——
   PowerShell：`[Environment]::SetEnvironmentVariable('EJDRONE_CODEUP_TOKEN', '<值>', 'User')`；
   bash：往 `~/.bashrc` 追加 `export EJDRONE_CODEUP_TOKEN=<值>`。
   **令牌值永远不回显到对话、不写进任何日志或文件**，写入后让成员新开终端。

## 第 3 步：定角色（A/B 线共用）

1. 运行 `ejdrone roles list`，把「id + 说明」逐条列给成员。
2. 对照成员在委托书开头写的角色职责，推荐一个最贴近的 id，**让成员确认**（不要替成员拍板；
   都不贴合就选不设角色，只装全员内容）。
3. 确认后执行 `ejdrone roles set <id>`，再 `ejdrone pull` 让该角色的内容落地。

## 第 4 步：验收与交代

1. 运行 `ejdrone doctor`，把结果用大白话逐项讲给成员——**全绿才算完成**；有 WARN/FAIL
   就照 hint 处理（多数是环境问题，处理完重跑 doctor）。
2. 最后交代三件事：
   - 日常零操作：AI 会话启动自动同步；
   - 没装 git 的机器没有自动同步，手动方式是双击桌面「ejdrone 同步」或直接对 AI 说
     「帮我同步一下团队技能」；
   - 以后想改角色/补内容，对任一 AI 会话说「我是 X，帮我改角色」或找管理员都行。

## 边界（必须遵守）

- 只动当前用户的东西：用户目录、用户 PATH、用户环境变量；不用 sudo/管理员，不写系统目录。
- 令牌只写入目标位置，不回显、不进对话记录。
- 任何一步失败：先展示错误原文，再处置；同一操作最多重试一次。
- 不理解 `ejdrone` 的某个输出时，原样贴给成员或建议跑 `ejdrone doctor`，不要编造解释。
