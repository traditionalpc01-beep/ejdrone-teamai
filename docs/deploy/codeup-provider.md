# Codeup 托管的团队仓：自动开 MR 与免 git 使用

适用对象：团队仓库托管在云效 Codeup（`codeup.aliyun.com`）的成员与管理员。讲清三件事：
什么时候这些能力自动生效、令牌怎么配、没装 git 的机器能做到什么程度。安装层面的
一键分发见 `member-zero-install.md`，本文只讲运行期行为。

## 什么时候自动生效

`ejdrone init` 按 `--provider` 显式值或仓库地址判定 provider：地址在 `codeup.aliyun.com`
域下（https 与 scp 式 `git@codeup.aliyun.com:…` 都认）自动选 `codeup`。此后的变化：

| 场景 | 旧行为（generic） | 新行为（codeup provider） |
|---|---|---|
| 本机有 git，push / contribute / remove | 只推分支，给网页链接手动开 MR | 推分支后**自动开 MR**，输出直达链接 |
| 本机没有 git，pull / status / doctor | 直接失败（clone 需要 git） | 走 Codeup OpenAPI 逐文件拉取，功能完整 |
| 本机没有 git，push / contribute | 直接失败 | 走 OpenAPI：（复用或新建）分支 → 写文件 → 删文件 → 开 MR |

有 git 的机器一切照旧走 git；免 git 链路只在 PATH 上探测不到 git 时启用。

## 令牌：EJDRONE_CODEUP_TOKEN

免 git 链路与自动开 MR 都需要云效个人访问令牌（OpenAPI 鉴权用）：

- 生成入口：云效「个人设置 → 个人访问令牌」。权限按页面实际可选项勾能完成
  代码读写与合并请求创建的最小集合。
- 配置：环境变量 `EJDRONE_CODEUP_TOKEN`（兼容回落读取 `YUNXIAO_ACCESS_TOKEN`，
  已在用云效 MCP 等工具的成员可以不重复配）。Windows 用安装脚本时由
  `-CodeupToken` 参数写入用户环境变量。
- 红线：令牌只从环境变量读，CLI 不落盘、不在任何输出里回显（错误信息也做脱敏）。
  令牌本身的分发与轮换策略见 `member-zero-install.md` 管理员准备一节。
- 未配令牌时：拉取会明确提示缺哪个变量；推送仍走 git（有 git 的机器不配令牌也能
  推分支，只是 MR 要手动开，输出会给出网页指引）。
- `organizationId` 每次调用时自动解析（不落 config）：换 token / 换组织后不会出现
  「拉取正常、推送打到旧组织」的陈旧缓存问题。

## 免 git 机器的行为细节

- **拉取**按远端默认分支全量重建本地镜像目录（`~/.ejdrone/repo`），语义与 git 路径的
  同步一致；文件内容保持仓库原始字节，不做换行转换。远端 head 没动时会命中本地缓存
  直接跳过下载——常态下每次同步只有 3 个元数据请求，全量重下只在远端真的前进时发生。
- **推送**按前缀复用远端既有未合并分支（与有 git 机器的行为一致），没有才新开带
  时间戳的分支；同一资源重复推送更新同一条分支与合并请求，不会开出重复 MR。
- **删除**：remove 命令交给 API 的可能是目录路径（如 `skills/fe/某技能`），推送前会
  按目标分支文件树展开成具体文件逐个删除。
- **空仓库首笔**（新团队仓刚建好）：README 说明书与 `.gitattributes` 直接写入默认
  分支、不开 MR——与有 git 机器的引导行为一致。
- **安全扫描不降级**：免 git 推送与 git 路径走同一条提交前检查链。
- **部分失败保护**：任一文件写失败时**不会**创建合并请求——半份资源一旦合入主干会被
  全员拉取，宁可停在分支上按输出指引处理。
- **提交粒度**：Codeup OpenAPI 没有批量提交端点，免 git 推送每个文件是一个独立
  commit（合并请求的提交列表会出现同标题的一串）；重度提交场景建议装 git 走单提交路径。
- **会话自动同步（hook）仍需要 Git for Windows**：hook 靠它提供的 bash 运行。免 git
  机器上 init 不装 hook（有提示），同步方式是手动 `ejdrone pull` 或桌面「ejdrone 同步」。

## 验证状态（如实）

- 读路径（仓库信息 / 分支列表 / 文件树 / 文件内容）与鉴权方式已于 2026-10-19 对真实
  仓库 `ejdrone/1C5P/ejdrone-teamai` 冒烟核实。
- 写路径（建分支 / 写文件 / 创建合并请求）按云效 OpenAPI 的公开契约实现，单元测试
  全程 mock 网络（与 GitLab provider 同一测试策略），**尚未做真机回环验证**。首次在
  真实仓库使用时，建议先推一条无关紧要的内容走完全流程确认；各失败路径都有
  「如何手动继续」的兜底指引。
