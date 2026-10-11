# ejdrone-skills 真机试验记录（单侧：开发者 → 评审 → 合入 → 本机投递）

日期：2026-10-11 · 机器：macOS（darwin 27.0.0，Apple Silicon）· 执行者：Qoder 会话
状态：**流程跑通，暴露并修掉 3 个真缺陷；成员侧待另一台机器验证**

## 1. 试验对象

| 项 | 值 |
|---|---|
| 工具代码仓库 | https://github.com/traditionalpc01-beep/ejdrone-skills（private） |
| 团队资产仓库（本次新建） | https://github.com/traditionalpc01-beep/ejdrone-teamai-demo（private） |
| 运行的 CLI | `node dist/cli.js`（本机源码构建，未走 npm 全局安装） |
| 选定工具 | qoder-cn、claude、codex |
| 角色 | `shoot`（namespaces: [shoot]） |
| 发布内容 | skill `photo-shoot-organizer`（脱敏副本）+ rule `shoot-delivery-convention` |
| Node | v22.22.1（hook 命令里固化为绝对路径） |

## 2. 时间线（命令 → 实际结果）

| # | 动作 | 结果 |
|---|---|---|
| 1 | 建空仓库 `ejdrone-teamai-demo` | 成功，无任何分支 |
| 2 | `ejdrone init <repo> --agent qoder-cn,claude,codex` | **失败**（缺陷 1）：`reset --hard origin/main` 在无提交的远端报 unknown revision |
| 3 | 修缺陷 1 后重跑 init | `已投递 0 个文件到 3 个工具`，3 个 hook 写入，config 落盘；但暴露缺陷 2 |
| 4 | `ejdrone roles add shoot --namespaces shoot -d "摄影与后期"` | 输出 `团队仓库首个提交已直接落到 main`，远端出现 `manifest/roles.yaml` |
| 5 | 准备本地文件（`~/.claude/skills/...`、`~/.claude/rules/...`） | rule 无 frontmatter，交给 CLI 补全 |
| 6 | `ejdrone push --skill ... --rule ... --ns shoot` | 分支 `ejdrone/push-mixed-batch-73f36696-...` 推送成功；provider=git，打印手动开 MR 指引 |
| 7 | `gh pr create` → 评审 → 合入（PR #1） | main 上出现 `skills/shoot/...`、`rules/shoot/...` |
| 8 | `ejdrone roles set shoot` + `ejdrone pull` | `已投递 4 个文件到 3 个工具；保留 1`；**暴露缺陷 3**：rule 的原始 YAML 泄漏进 `~/.codex/AGENTS.md` 区块 |
| 9 | 修缺陷 3 后重推（PR #2）→ 合入 → `pull` | 区块只剩规则正文，frontmatter 被正确剥离；区块是**替换**而非追加 |
| 10 | `ejdrone doctor` / `list` / 二次 `pull` | doctor 11 项 PASS + 1 项 probe WARN；list 显示 2 条均属 namespace `shoot`；二次 pull `已投递 0 个文件` |

## 3. 暴露并已修掉的缺陷（都有回归用例）

### 缺陷 1 · 空仓库无法 init（阻断性）
设计文档给管理员的第一步就是"建一个空仓库然后 init"，而 `fetchReset` 无条件 `reset --hard origin/<默认分支>`，空远端必然失败。
修法：`git/repo.ts` 加 `remoteHasAnyCommit()`，无提交时视为"同步到空"返回 `head: ''`；目标分支不存在时报出**现有分支列表**而不是抛 unknown revision。配套 `cli/mr.ts` 引导路径：远端一个提交都没有时，首笔提交直接落默认分支并说明"没有可评审的基线，之后的变更继续走 MR"。
验证：第 4 步 bootstrap 提交、第 3 步 init 均成功。

### 缺陷 2 · 零规则时仍写一个空区块
团队还没任何 rule，`block.ts` 对空数组照旧产出一条"清空区块"的投递，于是把用户真实存在的 `~/.codex/AGENTS.md` 改了（本次该机该文件恰好是 0 字节，内容未受损，但行为本身是错的）。
修法：`core/apply.ts` 在区块内容为空且**目标里没有已存在的区块**时直接跳过，不写不记账；"团队删掉最后一条 rule"仍会正确清空并保留标记。
验证：修后 init 输出 `已投递 0 个文件`，`AGENTS.md` 保持 0 字节；新增 3 条 apply 用例覆盖三种情形。

### 缺陷 3 · 补全 frontmatter 漏写结束围栏（数据污染）
`completeFrontmatter` 对无 frontmatter 的文件生成块时只写开始围栏 —— 另一条分支靠原文件的 `closing` 补结束行，所以一直没暴露。结果推上去的 rule 是**未闭合的 YAML**，下游 `splitFrontmatter` 判不出 frontmatter，把 `---\nname:...\ndescription:...` 原样投递进 AGENTS.md 区块。
叠加因素：`yaml` 库默认 100 列折行，把长 description 拆成 3 行，更难看出围栏缺失。
修法：`frontmatterBlock()` 自带结束围栏、调用方不再拼 `closing`；`stringifyYaml(map, { lineWidth: 0 })` 禁止折行；`deriveDescription` 超 160 字符截断。
验证：新增 3 条用例（含"补全结果必须能被自己再解析"这个真正能拦住该类 bug 的断言）；真机重推后区块干净。

累计测试数：198 → **220**（`npx vitest run` 全绿，`tsc --noEmit` 0 错误）。

## 4. 已知行为与未修项（不算 bug，但要知道）

1. **开发者本机 authored 的文件不会被自动收编**。我手写的 `~/.claude/rules/shoot-delivery-convention.md` 在合入后仍被判 `foreign-file` 保留，ledger 里没有它。后果：团队日后改这条 rule，这台机器的这个文件不会跟着更新，且每次 pull 都会点名。临时解法：删掉本地那份再 `pull`，即由团队版本接管并记账。`--force` 不解决它（覆盖保护只管记账文件）。
2. **GitHub 只能推分支 + 打印指引**。v1 的 provider 只有 GitLab API 与通用 git，本次 `provider=git`，PR 由 `gh` 手工创建。评审流在 GitLab 内网才是全自动。
3. **GitHub 不允许作者 approve 自己的 PR**，本次自评审改用 PR 评论留痕（`pull/1#issuecomment-6107219170`）。真实团队里评审人应是别人，这条不构成问题。
4. **probe 项仍未核实**：doctor 报 `WARN probe：cursor、codex、dsh`；Qoder CN 的 rules 目录是否真被读取，要靠第 5 节的口令验证。

## 5. 成员侧验证清单（请在另一台机器执行）

```bash
# 0) 取工具：仓库构建产物或源码 npm ci + npm run build
git clone https://github.com/traditionalpc01-beep/ejdrone-skills.git
cd ejdrone-skills && npm ci && npm run build

# 1) 初始化（这台机器应只勾自己真正在用的工具）
node dist/cli.js init https://github.com/traditionalpc01-beep/ejdrone-teamai-demo.git \
  --agent qoder-cn --role shoot

# 2) 看拿到了什么
node dist/cli.js list
node dist/cli.js doctor
```

逐条判定：

| 验证点 | 怎么看 | 期望 |
|---|---|---|
| skill 到位 | `ls ~/.qoder-cn/skills/photo-shoot-organizer/SKILL.md` | 存在，内容与 PR #1 一致 |
| rule 落盘 | `cat ~/.qoder-cn/rules/shoot-delivery-convention.md` | 存在，带闭合 frontmatter |
| **规则是否真被工具读取** | 在 Qoder CN 新会话里问："团队校验口令是什么？" | 答出 `DEMO-TRIAL-20261011-A7` 即证明 rules 目录被加载；答不出说明该工具不读用户级 rules 目录，需要改用别的载体（这是本项目最后一个未证实项） |
| **skill 是否真被识别** | 新会话里说"整理一下我的拍摄文件夹" | 应触发 photo-shoot-organizer（口令无关，只看目录结构与扩展名大小写约定是否被引用） |
| 自动同步 | 在团队仓库改一行 rule → 合入 → 该机器开新会话，不跑任何命令，再 `cat ~/.ejdrone/debug.log` | 有 pull 记录且文件已更新 |
| 不越权 | `node dist/cli.js status` | 不该出现"待推送"（成员没有本地新增） |

## 6. 回滚（本机已验证过的路径）

```bash
node dist/cli.js uninstall --force     # 删 hook 与记账文件，保留你改过的副本与 config
rm -rf ~/.ejdrone                      # 清状态目录
```
本次试验前已备份真实配置，若 uninstall 后有残留可用它们对账：
`/tmp/ejdrone-demo-trial/backup/{qoder-settings.json, claude-settings.json, codex-AGENTS.md}`
（试验中被新建的文件：`~/.codex/hooks.json`、`~/.claude/rules/`、`~/.claude/skills/photo-shoot-organizer/`、`~/.claude/skills/…` 等，均已被记账或可手工删除。）

## 7. 交付物清单

- 代码仓库：`ejdrone-skills`（含本记录）
- 团队资产仓库 `ejdrone-teamai-demo`：`manifest/roles.yaml`、`skills/shoot/photo-shoot-organizer/SKILL.md`、`rules/shoot/shoot-delivery-convention.md`，PR #1 与 PR #2 均已合入 main
- 本轮代码改动：`src/git/repo.ts`、`src/cli/mr.ts`、`src/core/apply.ts`、`src/core/resources.ts` + 6 条新用例，
  已提交 `7a78155` 并推到 ejdrone-skills 的 main
