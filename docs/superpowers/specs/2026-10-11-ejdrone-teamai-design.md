# ejdrone-teamai 设计文档（1.0）

> 状态：已批准，待实现 · 日期：2026-10-11 · 路线：自研轻量闭环（方案 A）
> 参照物：Tencent/teamai-cli（借鉴架构决策，不复用代码）

## 1. 目标与非目标

**要解决的问题**：15-25 人团队，分工不同 → 需要的 skills/rules 不同；AI 工具上下文有限，无关资产常驻会挤占上下文。个人电脑上调教好的经验无法变成团队资产。

**成功判据**：
- 一个人写好 skill → 提 MR → 评审合入 → 队友下次开 AI 会话自动可用，全程零手工通知
- 后端成员的上下文里不出现前端 skill / rule
- 新人入职当天一条命令达到与老成员一致的 AI 配置
- 单人可在 3-4 周（兼职）内维护该工具

**非目标（v1 明确不做，每项一句理由）**

| 不做 | 理由 |
|---|---|
| MCP 按 namespace 下发 | 团队确认缓做。架构上 `ResourceKind` 已抽象，新增一类不改 plan 算法。**注意：这是上下文裁剪收益最大的一项，重新评估时优先** |
| env 变量 / secrets 声明 | 同上，收益不匹配当前痛点 |
| projects 多项目维度 | 角色是"人"的属性；15-25 人以分工为主 |
| tags 标签订阅 | 角色 + 多角色已覆盖，两套机制会互相绕 |
| models 统一下发 | 团队对模型出口无限制、无合规要求 |
| sources 跨团队订阅 / packages | 无跨团队共享需求 |
| project scope（含 worktree、git hooks、scope 继承） | **本项是复杂度剪枝的主刀**，预估剪掉参照物约 40% 的复杂度来源 |
| 单仓模式（`--self`）/ HTTP provider | 两种运行模式会翻倍状态管理 |
| GitHub / GitCode / CNB / TGit 适配 | 只支持内网 GitLab + 通用 Git |
| Windows 支持 | 记为 v1.1；v1 仅 macOS / Linux |
| Team Context / Team Improvement（learnings、recall、teamwiki、session、digest、dashboard） | 参照物中这些仍是 beta，schema 在动 |
| GUI / TUI | CLI 足够 |

## 2. 核心架构决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | Git 仓库是唯一真相源，不建服务端 | 团队养不起第二个系统；评审、回滚、审计复用现有 MR 流程 |
| 2 | **目录即角色**：`skills/<ns>/`、`rules/<ns>/`；根目录 = 全员共享 | 不设 `common` namespace 概念，少一层心智负担 |
| 3 | namespace 同名条目**整体替换**根条目，不做字段合并 | 沿用参照物已验证语义，"谁优先"的坑它已踩完 |
| 4 | 只保留 user scope | 角色跟人走；配合决策 3 让 plan 计算成为纯函数 |
| 5 | **本地改过的文件绝不覆盖**：保留 + 点名 | 信任基础；没有它团队不敢让工具写 `~/.claude` |
| 6 | push 自动建分支 + 开 MR；通用 Git 退化为打印手动合并指引 | 评审流是"团队工具"与"个人工具箱"的分水岭 |
| 7 | 所有本地文件格式带 `version: 1` | 防御未来 schema 演进，避免参照物 0.25/0.26 拒绝未知 key 式破坏 |

## 3. 命名

- npm 包名：`ejdrone-teamai`
- 可执行命令：`ejdrone`（缩短日常输入；如需与包名一致改 bin 即可）
- 团队资产仓库（数据，非代码）建议命名：`ejdrone-teamai`
- 本地状态目录：`~/.ejdrone/`

## 4. 资产仓库结构

```
ejdrone-teamai/
├── manifest/roles.yaml
├── skills/
│   ├── team-release/SKILL.md          # 根：全员
│   ├── fe/fe-code-review/SKILL.md      # 仅 fe 角色
│   └── devops/ops-deploy/SKILL.md    # 仅 devops 角色
└── rules/
    ├── code-style.md                   # 全员
    └── fe/react-conventions.md         # 仅 fe
```

```yaml
# manifest/roles.yaml
version: 1
roles:
  - id: fe
    description: 前端
    namespaces: [fe]        # 即 skills/fe/、rules/fe/
  - id: be
    description: 后端
    namespaces: [be]
  - id: devops
    description: 运维/流程
    namespaces: [devops]
```

**放置规矩（必须写进团队文档）**：共享内容放根目录，差异化才放 namespace。若把共享内容放进某个激活的 namespace，会出现该成员同时收到根目录与 namespace 两份。

## 5. 投递矩阵（v1 覆盖 5 个工具）

| 工具 id | skills 落点 | rules 落点 | rules 模式 |
|---|---|---|---|
| `claude` | `~/.claude/skills/<name>/` | `~/.claude/rules/<name>.md` | rulesdir |
| `qoder-cn` | `~/.qoder-cn/skills/<name>/` | `~/.qoder-cn/rules/<name>.md` | rulesdir |
| `cursor` | `~/.cursor/skills/<name>/` | `~/.cursor/rules/<name>.mdc`（生成 frontmatter，默认 `alwaysApply: true`） | mdc |
| `codex` | `~/.codex/skills/<name>/` | `~/.codex/AGENTS.md` 标记区块 | block |
| `dsh` | `$DSH_HOME/skills/`（未设为 `~/.dsh/skills/`） | `$DSH_HOME/AGENTS.md` 标记区块 | block |

**所有路径集中在 `src/agents/paths.ts` 一张表**——某工具改目录约定只改这一个文件。表内每项标注 `PROBE`：实现 M1 时必须真机探测确认（Qoder CN 的 rules 目录、DSH 的 skills 目录为已知不确定项）。

block 模式格式（标记外的用户自有内容保持不动）：

```markdown
<!-- [ejdrone:team-rules:start] -->
<!-- 单条 rule：去 frontmatter；带 paths: 的在正文开头加一行 `Applies to files matching: <globs>` -->
<!-- [ejdrone:team-rules:end] -->
```

## 6. 模块划分与契约

```
src/
├── cli.ts                # 命令入口
├── core/
│   ├── types.ts          # ★ 全部共享类型与接口（先写，冻结）
│   ├── manifest.ts       # roles.yaml 解析 + zod 校验
│   ├── resources.ts      # SKILL.md / rule 解析、frontmatter 自动补全
│   ├── plan.ts           # ★ 纯函数：plan(repoTree, activeNs, ledger) → Plan
│   └── ledger.ts         # 投递账本读写
├── git/
│   ├── repo.ts           # clone / fetch / reset / branch / commit / push
│   ├── provider.ts       # GitProvider 接口 + 工厂
│   ├── gitlab.ts         # 开 MR（token 只从环境变量读）
│   └── generic.ts        # 降级：打印分支名与手动合并指引
├── agents/
│   ├── paths.ts          # 5 工具路径表（唯一改点）
│   ├── claude.ts qoder.ts cursor.ts codex.ts dsh.ts
│   └── rulesdir.ts mdc.ts block.ts      # 3 种 rules 投递 helper
├── hooks.ts              # SessionStart hook 安装/移除
└── state.ts              # ~/.ejdrone/config.yaml 读写
```

### 6.1 共享类型（`core/types.ts`，已冻结并实现）

唯一权威定义在 `src/core/types.ts`，此处只记形状与语义要点（实现版与本文初稿的差异见 §14）：

```ts
export type ResourceKind = 'skills' | 'rules';   // 预留 'mcp' | 'env'
export interface Resource { kind; namespace; name; files: Record<string,string> }  // namespace '' = 根/全员
export type ResourceKey = string;                // `${kind}:${name}`

// 命名空间裁决（纯函数，无 IO）
export function resolve(input: ResolveInput): Resolution
export interface Resolution { skills: Resource[]; rules: Resource[]; conflicts: string[]; warnings: string[] }
export function activeNamespaces(config: Config, manifest: RolesManifest | null): { namespaces: string[]; warnings: string[] }

// 投递
export interface PlannedWrite { path: string; content: string; resource: ResourceKey; region?: { start: string; end: string } }
export interface ApplyInput  { writes: PlannedWrite[]; activeResources: ResourceKey[]; ledger: Ledger; isManaged: (p: string) => boolean; now?: () => Date }
export function applyPlan(input: ApplyInput): { result: ApplyResult; ledger: Ledger }   // 不改传入 ledger
export interface ApplyResult { written: PlannedWrite[]; deleted: string[]; kept: KeptFile[] }

// 适配器：home/env 显式传入（临时 HOME 可测的前提），不读 process.env.HOME
export interface AgentAdapter {
  id; label;
  detect(home, env): boolean;
  planSkills(skills, home, env): PlannedWrite[];
  planRules(rules, home, env): PlannedWrite[];      // rulesdir / mdc / block 三种 helper
  ownsPath(path, home, env): boolean;               // block 模式下对 AGENTS.md 返回 false
  installHook(home, env, cmd): HookInstallOutcome;
  uninstallHook(home, env): void;
}

export interface GitProvider { kind: 'gitlab' | 'git'; openMr(req: MrRequest): Promise<MrResult> }
export interface MrRequest { branch: string; title: string; body: string; targetBranch?: string }
export interface MrResult  { url: string | null; instructions?: string }   // 永不抛错代替"报成 push 失败"
```

三条实现期定下、初稿没有的语义（很重要，别再改回去）：
1. **`region` 投递**：`content` 是区块正文而非整个文件；"是否被本地改过"只比较区块文本，
   否则用户自己写的 `AGENTS.md` 内容会被误判为团队区块被改。
2. **`activeResources` = 本次所有 writes 的 resource 去重集合**（含 block 合成 key
   `rules:team-rules-block`）。冲突的 kind 需额外把它已记账的资源标为 active —— 否则候选集为空会被
   当成"删除指令"，把全体成员已装的该类型内容清空。
3. **空目录回收在 CLI 层**：多文件 skill 被团队删除后 `applyPlan` 只 unlink 文件，留下的空
   `skills/<name>/` 会被 AI 工具当成无效条目，由 `src/cli/dirclean.ts` 清掉。

### 6.2 本地文件格式

```yaml
# ~/.ejdrone/config.yaml
version: 1
repo: https://gitlab.example.com/team/ejdrone-teamai.git
provider: gitlab            # gitlab | git
gitlabBaseUrl: https://gitlab.example.com     # 可选，默认取 repo origin
primaryRole: devops
additionalRoles: []
agents: [qoder-cn, claude]  # init 时选定，追加不覆盖
```

GitLab token **不落盘**：只读 `EJDRONE_GITLAB_TOKEN`（或 `GL_TOKEN`）。缺失时 push 仍完成分支推送，并打印"请用此 token 重跑开 MR 步骤"的指引。

```json
// ~/.ejdrone/ledger.json
{ "version": 1, "entries": [
  { "path": "/Users/x/.claude/skills/team-release/SKILL.md",
    "hash": "sha256:...", "resource": "skills:team-release", "deliveredAt": "..." } ] }
```

团队仓库 clone 在 `~/.ejdrone/repo/`（v1 只有 user scope，故无按项目分区）。

## 7. 核心算法：plan 计算（纯函数，测试主体）

```
输入：repoTree（根 + 各 namespace 的 skills/rules 条目）、activeNs（primaryRole + additionalRoles 的 namespaces 并集）、ledger
1. 候选集 = 根条目 ∪ activeNs 条目；同 (kind,name) 时 namespace 条目替换根条目
2. 两个 activeNs 定义同 (kind,name) → 记入 conflicts，该 kind 整体停发（其他 kind 不受影响）
3. skill 目录缺 SKILL.md → 跳过并记入 warnings，不下发
4. 对每个候选目标文件：本地已存在且 hash ≠ 本次内容 hash，且 ≠ ledger 中记录的投递 hash
   → 判定"用户改过" → 进 keeps，不写
5. ledger 中已有、但不在候选集：hash 匹配投递内容 → deletes；被改过 → keeps
输出：Plan{ writes, deletes, keeps, conflicts }
```

**幂等要求**：同一输入连续两次 plan，第二次 writes/deletes 为空。

## 8. 命令集（9 个）

| 命令 | 行为 | 退出码 |
|---|---|---|
| `ejdrone init <repo>` | 探测 provider（`--provider gitlab\|git` 可覆盖）、检测已装工具并选择（`--agent` 跳过交互，适合 CI）、写 config、选角色、装 hook、末尾 pull 一次 | 0；非交互且缺 token 时不阻塞 |
| `ejdrone pull [--force] [--silent]` | fetch → 算 plan → 投递 → 写 ledger。`--silent` 供 hook 用，问题只写 `~/.ejdrone/debug.log` 且恒返回 0 | 0 正常；1 有 keep/conflict 警告 |
| `ejdrone push [--skill <path>] [--rule <path>] [--all] [--role <id>] [--ns <namespace>]` | 采集本地资源 → 补 frontmatter → 建分支 `ejdrone/push-<kind>-<name>-<ts>` → push → 开 MR。`--role` 经 manifest 映射到 namespace；映射出多个时**必须**用 `--ns` 指定 | 0；generic provider 打印手动指引 |
| `ejdrone status` | 本地资源 vs 仓库：待推送 / 落后 / 本地已改（keep 类） | 0 |
| `ejdrone list [skills\|rules] [--source repo\|local\|all]` | 列出资源及归属 namespace、是否根条目 | 0 |
| `ejdrone roles list/set/add/remove` | `set <primary> [--add <ids>]` 改本地 config；`add/remove` 走 MR 改团队 manifest（管理员） | 0 |
| `ejdrone remove <kind> <name...>` | **只从团队仓库删除（走 MR）**，不动本地副本 —— 未合入就删会与团队其他成员不一致。合入后 `pull` 移除各工具副本；你改过的副本保留并点名 | 0 |
| `ejdrone readme` | 生成/更新团队仓库首页的 `README.md`（走 MR）。空仓库的引导提交会自动带一份，这样新成员打开仓库首页就知道这是什么、怎么加入、怎么退出，不靠群里口头传 | 0；内容已是最新时不产生空 MR |
| `ejdrone doctor [--json]` | 逐项检查：config 可读、repo 可达、manifest 可解析、每个选定工具的 hook 已装、ledger 与磁盘一致、paths 未核对项（WARN） | 0 全绿；非 0 有失败项 |
| `ejdrone uninstall [--force]` | 移除所有工具的 hook + 删除 ledger 记账且内容仍匹配的文件；保留 config 与你改过的副本 | 0 |

hook 写入的命令是**绝对路径**形式：`EJDRONE_HOOK=1 '<node>' '<abs cli.js>' pull --silent`。
理由：GUI 启动的 agent 常常不带 npm 全局 bin 的 PATH，裸 `ejdrone` 会让"会话自动 pull"这条主价值链静默失效。
`EJDRONE_HOOK=1` 同时是 `hooks.ts` 识别自家条目的标记（不新增自定义 JSON 字段，避免工具侧 schema 校验失败）。

## 9. 错误处理原则

- **类型级故障隔离**：skills 出错不影响 rules（参照物同策略，验证有效）
- **manifest 不可解析** → 全部停发，保留已装内容，doctor 指出文件与出错位置
- **冲突只停该 kind**，不停整个 pull
- **网络失败** → 已装内容不变，下次 pull 自动重试
- **hook 静默失败**：SessionStart hook 命令永不非零退出，不影响用户开工具
- 任何写操作前先算完整 plan（避免半途中断留下不一致状态）

## 10. 安全红线

1. 永不覆盖本地修改过的投递文件（决策 5）
2. `push` 对工具目录只读
3. 零遥测；网络只碰团队仓库与 GitLab API
4. token 不落盘，只从环境变量读
5. 声明式约定：**SKILL.md / rule 内禁止写入密钥**。v1 无 secrets 功能，靠 MR 评审兜底；`git/repo.ts` 预留 `prePushScan()` 空扩展点
6. 写文件路径必须限制在 `paths.ts` 表内目录之下，禁止路径穿越（namespace 名做白名单字符校验 `[a-z0-9-_]`）

## 11. 测试策略

| 层 | 方式 |
|---|---|
| `plan.ts` | table-driven 单测：替换、冲突停发、keep 点名、删除、幂等、缺 SKILL.md |
| `manifest/resources` | zod 校验失败用例；frontmatter 补全（含损坏 YAML 保留原文 + 告警） |
| `agents/*` | 临时 HOME 端到端：假装有某工具目录 → pull → 断言落点与内容；block 模式断言标记外内容不变 |
| `git/*` | `child_process` 用本地裸仓库 fixture；GitLab 用 mock fetch |
| `cli` | 冒烟：init→push(分支已建)→改仓库→pull→status |
| 集成门槛 | `tsc --noEmit` + `vitest run` 全绿为每次里程碑验收线 |

## 12. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M1 核心闭环** | `types.ts` 冻结、`core/*`、`agents/*`（含 paths 探测）、`state.ts`、`git/repo.ts`、`init/pull/list/status` | 手动往仓库提交一个 skill + 一条 rule + roles.yaml，`ejdrone pull` 后 5 个工具目录内容正确，二次 pull 幂等 |
| **M2 评审流** | `push`、`git/provider+gitlab+generic`、`roles` 命令、namespace 替换与冲突 | 一条 skill 从个人电脑 → MR → 合入 → 队友 pull 全链路通 |
| **M3 自动化** | `hooks.ts`（5 工具 SessionStart）、`doctor`、`remove`、`uninstall` | 合入 MR 后队友零操作；故意改坏 manifest 后 doctor 能指到文件 |
| **M4 打磨** | 多角色 `--add`、keep/conflict 点名文案、README + 团队 onboarding、发布 npm 内网包 | 15-25 人铺开 |

粗估：单人兼职，M1 一周、M2 一周、M3 一周、M4 数天。

## 13. 参照物经验（已在设计中吸收，勿重复踩）

- 共享内容必须放根目录、差异化放 namespace，否则重复下发（参照物文档明确警告）
- "唯一角色自动选中"要保留，降低 init 摩擦；但不引入"项目不自动激活"那类反直觉例外
- 投递账本必须能区分"我投递的"与"你自己的文件"，否则 remove/uninstall 会伤人
- 停用 namespace 后要能恢复根条目并清理独有条目（本设计在 plan 步骤 5 覆盖）
- `rules` 在不同工具有三种落点，必须一开始就抽象成 helper 三件套，不要往适配器里塞 if-else

## 14. 1.0 实现状态（2026-10-11）

已实现并验收：`src/` 42 文件 / 5221 行，`test/` 16 文件 / 3493 行；里程碑 M1–M3 完成，
M4 的 README 已写、内网发包未做。规模约为参照物的 1/10。

**与本文初稿的偏差（均为有意，勿改回）**

| 项 | 初稿 | 实现 | 理由 |
|---|---|---|---|
| `remove` | 团队仓库 + 各工具同时删除 | 只走 MR 删仓库，合入后由 `pull` 移除 | 未合入就删本地会与团队其他成员不一致 |
| push 的 `--role` | 当作 namespace 名 | 经 manifest 映射；多 namespace 角色要求 `--ns` | 角色 id ≠ namespace 目录名，猜一个会把团队内容放错目录 |
| hook 命令 | `ejdrone pull --silent` | 绝对路径 node + cli，前缀 `EJDRONE_HOOK=1` | PATH 缺失会让自动 pull 静默失效；前缀兼作识别标记 |
| 冲突处理 | 该 kind 停发 | 停发**且**把已记账资源标为 active | 否则候选集为空会被 apply 当成删除指令，清空全员已装内容 |
| provider 判定 | 主机名含 gitlab | 加 `--provider` 显式覆盖 | 自建 GitLab 常用别的域名 |
| §6.1 类型草图 | `Plan{writes,deletes,keeps}` 吃 ledger | `resolve()` 纯裁决 + `applyPlan()` 落盘并返回新 ledger | 拆分后 plan 可纯函数测试，IO 集中在 apply |

**仍未真机核实（`ejdrone doctor` 以 WARN 逐条列出，全部集中在 `src/agents/paths.ts`）**
- Qoder CN 的 `~/.qoder-cn/rules/` 是否被该工具读取（Claude 侧已核实：`~/.claude/rules/` 是官方用户级载体，支持 `paths:` 按需加载）
- Cursor / Codex / DeepSeek Harness 的 hook 落点与事件名（Claude 的形状已真机核对）
- Codex 真机存在 `~/.codex/rules/`，但那是它自己的 `*.rules` 命令策略目录，不是 markdown rules —— 投递矩阵走 `AGENTS.md` 区块是对的

**终审后修掉的缺陷（已各有回归用例）**
- `--force` 原本会删掉**从未记账**的同名文件（用户自己写的），现只覆盖 ledger 里有记账的路径
- rules 命名空间冲突停发时，block 适配器仍会产出"清空区块"的投递，会抹掉已装的 Codex / DSH 团队区块；
  现由 `Resolution.haltedKinds` 让 delivery 整个跳过该 kind
- hook 命令里的绝对路径在 nvm 换版本 / npm 全局升级后会失效，而 doctor 原先只看"条目在不在"照样 PASS；
  现核对命令里的 node/cli 路径是否仍存在、是否指向当前这份安装（FAIL / WARN）
- `hooks.ts` 在事件值不是数组时会直接覆盖掉别人的配置；现拒绝覆盖并抛 `HookSettingsError`；
  `removeHook` 在没有自家条目时不再重写文件；uninstall 只报告真装过的工具
- 加 `sync.lock`（`src/cli/lock.ts`，5 分钟 stale 回收）：pull 全程持锁、submitMrChange 从建分支到推 MR 持锁。
  此前两个会话同时启动会交错 load/saveLedger，后写者丢掉先写的记账，那些文件此后被当成他人文件永久保留；
  hook 的 fetchReset 还可能插在 push 的 writeFiles 与 commitAll 之间，表现为"空提交、没有 MR"
- GitLab repo URL 解析失败的错误消息现在会先 `scrubCredentials`（URL 内嵌凭据不再回显）
- `DSH_HOME` 只接受绝对路径（GUI agent 的 cwd 不可预测，相对值会投到随机目录并留孤儿）
- AGENTS.md 里只剩半个区块标记时不再追加新区块，改为保留该文件并点名（否则会反复堆叠并永久判成本地改动）

**已知限制（未修）**：Windows 不支持；单仓模式与 HTTP provider 未做；Team Context / Improvement 未做。
并发保护覆盖 pull 与 MR 提交，push 最前面的 snapshot fetch 仍在锁外（竞争时表现为一次可见的 git 报错，不会丢数据）。

**验收**：`tsc --noEmit` 0 错误；`npm run build` 通过；`npx vitest run` **214/214 全绿**
（15 个测试文件，含真实 `git init --bare` 端到端：init → push → 合入 → 成员 pull → 角色切换 →
本地改动保护 → 团队删除 → 幂等 → 冲突 × 区块 → 并发锁 → hook 失效可见性）。
`node dist/cli.js doctor` 在未初始化时打印 FAIL 与下一步并以 1 退出。
