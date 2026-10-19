# 非开发角色安装指引（管理员操作手册）

适用对象：产品经理、运营、设计等不装开发环境的成员，目标是把成员侧安装压到一条命令，
中间最多按提示选一次工具和角色。开发者成员继续走仓库 README 的手动安装通道，不适用本文。

实现方式：`scripts/install/ejdrone-setup.ps1` 把便携 Node 解压到 `~/.ejdrone/runtime`、
把 CLI 装进 `~/.ejdrone/npm-global`（走独立 npmrc，不碰系统 Node 与 `~/.npmrc`），按需写入
用户级 `EJDRONE_CODEUP_TOKEN`，最后执行 `ejdrone init` 并在桌面放一个「ejdrone 同步.cmd」。
所有内容都落在当前用户目录，回滚见文末三步。

## 管理员一次性准备

以下每项做一次，之后新成员加入零成本。

### 1. 决定 Codeup 仓库可见性

- **企业内成员可读**：成员侧不需要任何令牌，脚本 `-CodeupToken` 留空。团队资产仓按红线
  不含密钥（见仓库 README「安全边界」），企业内网环境下通常可接受。
- **保持私有**：成员每人需要一枚代码只读权限的云效个人访问令牌。生成入口在云效
  「个人设置 → 个人访问令牌」；页面上给出哪些权限选项就勾哪些，取能完成拉取 / 推送的最小
  集合，具体选项名以页面为准。令牌走一对一渠道分发（飞书私聊等），不进群公告、不进共享
  文档。理想形态是成员用自己的云效账号各生成一枚；确需管理员代持集中分发时，按第 2 条的
  风险面管理。

### 2. 制品库只读凭据（npm 源）

- 制品库 npm 仓里必须已有 `ejdrone-teamai` 包：发版时 `npm publish` 到该仓，或由 CI 发布。
- 在制品库页面取个人 npm 凭据，作为 `-NpmToken` 烤进脚本默认值。风险面：持凭据者可拉取该
  制品源下的全部包（只读），分发给全员意味着泄露面等于全员。按季度轮换；成员离职或凭据
  疑似泄露时在制品库页面吊销重发，轮换后重新分发脚本。烤进默认值等于把凭据发给每一位拿到
  脚本的人，能接受再这么做。
- npm 仓允许匿名读取时 `-NpmToken` 可留空。

### 3. 烤脚本默认值

分发前改 `scripts/install/ejdrone-setup.ps1` 顶部 `param()` 里的默认值：

| 参数 | 烤什么 |
|---|---|
| `-RepoUrl` | 团队资产仓地址，必改 |
| `-Role` | 目标角色 id。建议烤进（成员少答一题）；留空则 init 交互问一次 |
| `-Agents` | 该批成员常用工具 id（如 `qoder-cn,claude`）；留空则 init 自动探测已装工具 |
| `-NodeVersion` | 便携 Node 版本，随 LTS 轮换；不同版本落不同目录，互不干扰 |
| `-Proxy` | 下载 Node 用的代理（内网成员才需要），一般留空 |

`-NpmToken` / `-CodeupToken` 是否烤进默认值，按第 1、2 条的决策来。

### 4. 托管位置（三选一）

| 方式 | 成员侧取用 |
|---|---|
| 云效制品库 generic 仓 | 管理员上传 `ejdrone-setup.ps1`（连同 `.cmd`），成员浏览器登录云效后下载；下载直链也可写进话术 |
| 内网静态服务 | 话术里给 `http://<内网地址>/ejdrone-setup.ps1` |
| 飞书群附件 | 成员把 `.ps1` 与同名 `.cmd` 下载到同一目录后双击 `.cmd` |

前两种支撑下一节的一条命令形态；第三种不依赖任何服务，代价是成员多点两次鼠标。

### 5. 成员话术模板

> 装一下团队的 AI 规范库，五分钟：打开「开始菜单 → Windows PowerShell」，粘贴下面这行
> 回车；中间让你选在用的 AI 工具、角色时按提示选，其他不用管。装完以后开会话自动同步，
> 你不用再操作。
>
> `powershell -c "irm <托管地址>/ejdrone-setup.ps1 | iex"`

（截图位：一张跑完的 PowerShell 窗口，标注「看到“安装完成”即可关闭」。）

## 成员侧安装

在线形态（托管地址以管理员发布为准）：

```powershell
powershell -c "irm <托管地址>/ejdrone-setup.ps1 | iex"
```

离线等价：下载 `ejdrone-setup.ps1` 与 `ejdrone-setup.cmd` 放同一目录，双击 `.cmd`，或右键
`.ps1` 选「使用 PowerShell 运行」。组策略锁死执行策略时走 `.cmd` 壳（内含
`-ExecutionPolicy Bypass`，只作用于本次进程）。

脚本幂等：中途失败或断网后直接重跑；已满足要求的 Node 不会被重复下载，也不会被改动。

## 没有 git 的机器

- 安装脚本本身不需要 git，也不负责安装 git。
- 新版 ejdrone 在「Codeup 仓 + 环境变量 `EJDRONE_CODEUP_TOKEN`」条件下可以不装 git 完成
  拉取与推送；脚本的 `-CodeupToken` 参数就是做这件事的（写入用户环境变量，写入后当场
  读回校验，注册表键被组策略删除时会明确报错而不是假成功）。
- 会话启动自动同步（hook）仍依赖 Git for Windows 提供的 bash。没装 git 的机器上 init
  不会装 hook（会提示），成员的同步方式是双击桌面「ejdrone 同步」。要自动同步就补装
  Git for Windows。向成员交代时如实说明，不承诺「全自动」。

## 角色怎么定、装完怎么改

- **推荐形态**：管理员按角色分发不同的安装入口（产品群发烤了 `-Role pm` 的版本、
  前端群发 `-Role fe` 的版本）——群本身就是按角色组织的，发对群等于选对角色，成员
  零问答。`-Role` 与 `-Agents` 都烤好时脚本自动加 `--force`，首跑全程无提示。
- 只烤一部分参数时，init 会交互补齐：工具清单自动探测已安装的；**角色选项带管理员
  写的中文说明**（来自 `manifest/roles.yaml` 的 description），不确定就选「先跳过」。
- **装完之后随时能改**，成员对 AI 工具说一句「我是产品经理，帮我设置角色」即可，
  对应命令是 `ejdrone roles set pm`（可加 `--add` 订阅多个）；改完 `ejdrone pull` 生效。
- 升级重跑脚本不会碰这些选择（检测到 config.yaml 已存在就跳过 init）；要整体重选才
  用 `ejdrone init <仓库地址> --force`。

## 安装顺序

先装成员在用的 AI 工具（Claude / Qoder 等，装好并打开一次），再跑本脚本——init 依赖
探测已安装的工具；一个都没探测到时会明确报错提示先装工具。脚本 Step 5 的失败提示
也写了这一条。

## 升级

二选一：

```powershell
# 方式一：重跑安装脚本（幂等，Node 已满足要求时不会重复下载）
powershell -c "irm <托管地址>/ejdrone-setup.ps1 | iex"
```

```bat
:: 方式二：只升级 CLI 本体
npm install -g ejdrone-teamai@latest --userconfig %USERPROFILE%\.ejdrone\npmrc
```

## 卸载 / 回滚

与脚本头部说明一致，三步：

1. 卸载 CLI（如需同时撤掉已投递到各 AI 工具目录的内容，先执行 `ejdrone uninstall`）：

   ```bat
   npm uninstall -g ejdrone-teamai --userconfig %USERPROFILE%\.ejdrone\npmrc
   ```

2. 删除安装器建的四个位置。`~/.ejdrone` 下的 `config.yaml`、`repo`、`knowledge` 等是成员侧
   业务数据，不在删除范围，别一起删：

   - `%USERPROFILE%\.ejdrone\runtime`
   - `%USERPROFILE%\.ejdrone\npm-global`
   - `%USERPROFILE%\.ejdrone\npmrc`
   - 桌面 `ejdrone 同步.cmd`

3. 用户环境清理：从用户 PATH 移除 `.ejdrone\runtime\node-v<版本>` 与 `.ejdrone\npm-global`
   两个目录；设置过的话删除用户环境变量 `EJDRONE_CODEUP_TOKEN`。

## 已知边界

- 仅覆盖 Windows x64（便携 Node 按 x64 下载）。macOS / Linux 成员走仓库 README 的手动安装
  通道。
- `EJDRONE_CODEUP_TOKEN` 落在用户环境变量，同机同用户的其他进程可读：只给只读权限并定期
  轮换；高敏场景改用「企业内成员可读」，令牌就不必下发。
- `~/.ejdrone/npm-global` 与便携 Node 只服务于 ejdrone。成员日后要装别的 npm 全局包，建议
  另配目录，保持这里可按上文三步干净回滚。
