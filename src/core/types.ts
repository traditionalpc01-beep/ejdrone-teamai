/**
 * ejdrone-teamai 跨模块契约 —— 已冻结。
 *
 * 三个并行实现方（core / agents / git+state+hooks）都只依赖本文件通信。
 * 若你认为某个签名需要调整：不要就地修改，把理由回报给协调者。
 *
 * 设计文档：docs/superpowers/specs/2026-10-11-ejdrone-teamai-design.md
 */

// ---------------------------------------------------------------- 资源模型

/**
 * 2.0 M6 加 'mcp'，M7 加 'agents'，M8 加 'docs'，M9 加 'learnings'。
 * 加进这个联合类型后 `KindSet` 会强制所有分派点补齐 —— 漏一处就编译不过
 * （`core/plan.ts` 的 KIND_ROOT、`cli/kinds.ts` 的 SPELLINGS 都是 Record<ResourceKind, …>）。
 */
export type ResourceKind = 'skills' | 'rules' | 'mcp' | 'agents' | 'docs' | 'learnings';

/** 全部资源类型的集合；装配与测试用 `emptyKinds()` 起头。 */
export type KindSet = Record<ResourceKind, Resource[]>;

/** 一条团队资源。
 * namespace === '' 表示仓库根目录条目（全员共享）。
 * files: skills 为「仓库内相对路径 → 内容」（必含 SKILL.md）；
 * rules / agents / docs / learnings 为 { content: 正文 }（后三类是带 frontmatter 的单文件 md）；
 * mcp 为空对象，结构化内容在 payload（`mcp/mcp.yaml` 是列表文件，解析后一个 server 一条 Resource）。
 *
 * **name 的唯一性按 kind 分两档**（`resourceKey` = `${kind}:${name}` 是 ledger 的记账键，两条资源撞键
 * 会让其中一条永远删不掉 —— 停用的那份被还在用的那份顶活着）：
 * - skills / rules / agents / mcp：name = 条目名（不含 namespace），namespace 只用于裁决；
 * - **docs / learnings：name = kind 根以下的相对路径去扩展名**（`ns1/arch`、根文件则是 `guide`），
 *   namespace 同时保留在 `namespace` 字段上供过滤。这两类是并集语义，同名的根条目与 ns 条目
 *   **都要投、都要各自记账**，所以键必须不同。
 */
export interface Resource {
  kind: ResourceKind;
  namespace: string;
  name: string;
  files: Record<string, string>;
  /**
   * 条目上的标签订阅声明（2.1）：文件类资源来自 frontmatter 的 `tags:`，mcp 来自条目的 `tags:` 字段。
   * 只做**加法豁免**——成员订阅了任一标签时，非活跃 namespace 里带标条目也进候选；
   * 不参与替换方向（同名 ns 替换根、双 ns 冲突停发的语义与无标签时逐字相同）。
   * 根条目全员下发，标签写了也无效但无害。
   */
  tags?: string[];
  /** 仅 kind === 'mcp' 使用；其他 kind 必须为 undefined。 */
  payload?: McpServerDef;
}

/** `mcp/mcp.yaml` 里一个 server 条目（字段形状与 ${VAR} 约定见设计文档 2.0 §3.1）。 */
export interface McpServerDef {
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  /** http / sse 用 */
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** stdio 用 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** 这些可执行文件在 PATH 上找不到时跳过该 server 并点名 */
  requires?: string[];
  /** 只下发给这些工具 id；缺省 = 所有声明了 mcpTarget 的工具 */
  tools?: string[];
  /** 条目标签（2.1）：成员订阅任一标签即下发该 server（跨 namespace 豁免，语义同 Resource.tags） */
  tags?: string[];
}

/** 取 mcp 资源的结构化内容；缺失说明上游装配写错了（内部不变量，直接抛）。 */
export function mcpPayload(resource: Resource): McpServerDef {
  if (resource.kind !== 'mcp' || !resource.payload) {
    throw new Error(`mcp payload missing: ${resourceKey(resource.kind, resource.name)}`);
  }
  return resource.payload;
}

/** resource 的唯一键，用于 ledger 与冲突报告。 */
export type ResourceKey = string; // `${kind}:${name}`

export function resourceKey(kind: ResourceKind, name: string): ResourceKey {
  return `${kind}:${name}`;
}

// ------------------------------------------------------------ manifest / config

/** manifest/roles.yaml */
export interface RoleDef {
  id: string;
  description?: string;
  /** 对应 skills/<ns>/ 与 rules/<ns>/ 的目录名 */
  namespaces: string[];
}

export interface RolesManifest {
  version: number;
  roles: RoleDef[];
}

export interface ManifestParseResult {
  manifest: RolesManifest | null;
  /** 解析失败原因；非空时 pull 必须全量停发（设计文档 §9） */
  error?: string;
}

/** ~/.ejdrone/config.yaml（由 state.ts 读写） */
export interface Config {
  version: number;
  repo: string;
  // 2026-10-19 增量扩展，未改既有签名：加 'codeup'（云效 Codeup，OpenAPI 自动开 MR / 免 git 推送）
  provider: 'gitlab' | 'git' | 'codeup';
  gitlabBaseUrl?: string;
  primaryRole: string | null;
  additionalRoles: string[];
  /**
   * 本地订阅的标签（2.1）：任一资源（含非活跃 namespace 的）带这些标签即下发。
   * 旧 config 没有该字段 = 空订阅（state.ts 的 schema 有 default([])）。
   */
  subscribedTags: string[];
  /** init 时选定的工具 id 列表；追加不覆盖 */
  agents: string[];
}

// ---------------------------------------------------------------------- plan

export interface ResolveInput {
  /** 待裁决的全部资源，按 kind 分组（用 emptyKinds() 起头装配） */
  kinds: KindSet;
  /** primaryRole + additionalRoles 映射出的 namespace 并集 */
  activeNamespaces: string[];
  /** 本地订阅的标签（2.1）；缺省 = 无标签豁免，行为与 2.0 逐字节相同 */
  activeTags?: string[];
}

/**
 * 纯函数的命名空间裁决结果（设计文档 §7 步骤 1-3），逐 kind 一套。
 * conflicts 非空时，该 kind 本次整体停发，其他 kind 不受影响。
 */
export interface Resolution {
  kinds: KindSet;
  conflicts: string[];
  warnings: string[];
  /**
   * 因冲突被整体停发的 kind。调用方必须据此跳过该 kind 的投递计划 ——
   * 空数组对 block 模式适配器意味着"清空团队区块"，而停发要求的是"不动已装内容"。
   */
  haltedKinds: ResourceKind[];
}

export type KindSemantics = 'override' | 'union';

/**
 * 每类资源在团队仓库里的顶层目录名，以及它的 namespace 裁决语义。
 *
 * `KIND_SEMANTICS`：
 * - `override`（skills / rules / agents）—— 活跃 ns 的同名条目**整体替换**根条目，两个活跃 ns 同名则该 kind 停发。
 * - `union`（docs / learnings）—— 纯并集，**既不替换也不判冲突**：文档互相覆盖没有收益，只有惊讶；
 *   把两条同名文档都投进镜像目录也只会让 recall 多出一条近似重复的命中。
 * 用表而不是 `kind === 'docs' ? … : …`：新增 kind 时漏了这一格会编译失败。
 */
export const RESOURCE_KINDS: ResourceKind[] = ['skills', 'rules', 'mcp', 'agents', 'docs', 'learnings'];

export function emptyKinds(): KindSet {
  const kinds = {} as KindSet;
  for (const kind of RESOURCE_KINDS) kinds[kind] = [];
  return kinds;
}

/** 把按 kind 分组的资源摊平成一个列表（列表类命令用）。 */
export function allResources(kinds: KindSet): Resource[] {
  const out: Resource[] = [];
  for (const kind of RESOURCE_KINDS) out.push(...kinds[kind]);
  return out;
}

/** 待写入的一个文件（绝对路径） */
export interface PlannedWrite {
  path: string;
  content: string;
  resource: ResourceKey;
  /**
   * 区块投递（block 模式）专用。存在时：
   *  - content 是**区块正文**，不是整个文件
   *  - 写入方式：把 path 内 start/end 标记之间的内容替换为 content；标记外的用户内容保持不动
   *  - 文件不存在则新建并只写区块
   *  - "是否被本地修改"的判定只比较区块文本，不比较整个文件 —— 否则用户自己写的
   *    AGENTS.md 内容会被误判为"团队区块被改过"
   */
  region?: { start: string; end: string };
  /**
   * 条目级合并（MCP 这类共享配置文件）专用，与 region 互斥。存在时 content 不整文件写入，
   * 由 core/merge.ts 读原文件、只增删改 entries 里那几个键：
   *  - pointer 指向条目表位置（JSON 键路径，如 ['mcpServers']；TOML 时为表名前缀）
   *  - entries 是 key → 已解析 ${VAR} 之后的条目文本
   *  - "是否被本地改过"只比较我们那几个 key 的文本，绝不比较整个文件
   *  - 这类 path 永不进 apply 的 unlink 分支：文件是成员在用的，我们只认领自己的条目
   */
  merge?: {
    format: 'json' | 'toml';
    pointer: string[];
    entries: Record<string, string>;
    /**
     * 这些条目里含有把 `${VAR}` 解析成明文后的值 —— apply 必须把该文件收紧到 0600。
     * 由 planMcp 显式标注：apply 自己看不出来（它只拿到已经渲染好的文本，
     * 而"像不像密钥"这种猜测会把没有密钥的文件也一起改掉权限）。
     */
    hasResolvedValue?: boolean;
  };
}

/** 因管辖权或本地修改而保留不动的既有文件 */
export interface KeptFile {
  path: string;
  resource: ResourceKey;
  reason: 'modified-locally' | 'foreign-file';
  /**
   * 条目级合并（merge 投递）专用：这个文件里具体是哪几条没被动过。
   * 共享配置文件一条路径下可能挂着好几条团队 server，只报"这个文件保留了"成员没法知道改哪一条。
   */
  entries?: string[];
}

export interface ApplyResult {
  written: PlannedWrite[];
  deleted: string[];
  kept: KeptFile[];
}

export interface ApplyInput {
  writes: PlannedWrite[];
  /**
   * 本次候选集打算保留的全部 resource key。ledger 里有、但不在该集合中的条目 → 删除。
   * 注意：block 模式适配器必须把自己的合成 key（如 `rules:team-rules-block`）也放进来，
   * 否则每次 pull 都会误删区块。
   */
  activeResources: ResourceKey[];
  ledger: Ledger;
  /** 该路径是否落在本次管辖范围（由各 adapter.ownsPath 组合而来） */
  isManaged: (path: string) => boolean;
  /** 注入时钟，便于测试；默认新 Date */
  now?: () => Date;
}

/** applyPlan 不修改传入的 ledger，返回新 ledger 供调用方落盘 */
export interface ApplyOutcome {
  result: ApplyResult;
  ledger: Ledger;
}

// -------------------------------------------------------------------- ledger

export interface LedgerEntry {
  /** 投递到的绝对路径 */
  path: string;
  /** `sha256:<hex>` */
  hash: string;
  resource: ResourceKey;
  deliveredAt: string;
  /**
   * 条目级合并（merge 投递）专用：我们写进那个共享文件的每个键 → 当时投递的文本哈希。
   * 判"成员改过没有"只能逐键比，整文件哈希在这里毫无意义（文件里还有成员自己的条目）。
   * 旧账本没有这个字段 = 空集，必须仍然算合法（否则回落空账本会把全部已投文件当别人的）。
   */
  managedKeys?: Record<string, string>;
}

export interface Ledger {
  version: number;
  entries: LedgerEntry[];
}

// -------------------------------------------------------------------- agents

/**
 * 每个 AI 工具一个适配器。home / env 显式传入（不读 process.env.HOME），
 * 这是临时 HOME 目录端到端测试的前提。
 */
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;

  /** 该工具是否已安装（目录或二进制存在） */
  detect(home: string, env: NodeJS.ProcessEnv): boolean;

  /** skills → 落到该工具原生 skills 目录的文件写计划 */
  planSkills(skills: Resource[], home: string, env: NodeJS.ProcessEnv): PlannedWrite[];

  /** rules → 三种模式之一（rulesdir / mdc / block） */
  planRules(rules: Resource[], home: string, env: NodeJS.ProcessEnv): PlannedWrite[];

  /**
   * MCP server → 该工具原生 MCP 配置里的受管条目（条目级合并，见 PlannedWrite.merge）。
   * 可选：paths.ts 没给 mcpTarget 的工具不实现它，delivery 按"没有该能力"处理。
   * `note` 是给点名的出口（缺变量 / 缺可执行 / 不支持的 transport 而跳过的 server）：
   * "跳过并点名"是红线，静默跳过会让成员以为团队下发了而自己没拿到。
   * 只允许传人类可读的名字，已解析的密钥值不得进入任何 note。
   */
  planMcp?(
    servers: Resource[],
    home: string,
    env: NodeJS.ProcessEnv,
    note?: (message: string) => void,
  ): PlannedWrite[];

  /**
   * 子 Agent（M7）→ 该工具原生 agents 目录里的一个文件，按 `paths.ts` 的 `agentsFormat` 转形
   * （md / agent-md / toml / json 四种，转换只在 `agents/agentfmt.ts` 一处）。
   * 可选，与 planMcp 同一条原则：**能力有无只由落点表决定**，
   * 表里 `agentsSubdir` 缺席的工具不实现这个方法，delivery 按「该工具没有 agents 落点」跳过，
   * 不许在适配器或投递层按工具 id 写 if。
   * 落点是 `<agents>/<name>.<ext>` 这样的一文件一 agent，整文件覆写（不是 mcp 那种条目级合并）；
   * 与 block 模式的共同点是「文件里可能还有工具自家或其他人的内容」吗？不是 —— agents 目录里
   * 一个名字一个文件，所以沿用 skills 的「本地改过就不覆盖、只点名」。
   * `note` 与 planMcp 同用途：坏 frontmatter「保留原文投递」这类降级必须被看见，
   * 静默降级会被成员当成"团队下发了但我没拿到"。只允许人类可读的名字，不得含仓库内容片段。
   */
  planAgents?(
    agents: Resource[],
    home: string,
    env: NodeJS.ProcessEnv,
    note?: (message: string) => void,
  ): PlannedWrite[];

  /** 该绝对路径是否属于本适配器管辖（用于删除与 uninstall） */
  ownsPath(path: string, home: string, env: NodeJS.ProcessEnv): boolean;

  /**
   * 安装 SessionStart hook。内部调用 hooks.ts 的
   * upsertHook(settingsPath, { event, cmd })。cmd 形如 `ejdrone pull --silent`。
   * 不支持 hook 的工具应内部 no-op 并返回 false 语义（见返回值）。
   */
  installHook(home: string, env: NodeJS.ProcessEnv, cmd: string): HookInstallOutcome;

  uninstallHook(home: string, env: NodeJS.ProcessEnv): void;
}

export interface HookInstallOutcome {
  installed: boolean;
  /** 未安装原因（如该工具无 hook 机制），人类可读 */
  reason?: string;
}

/** 所有适配器通过 registry 暴露给 CLI */
export interface AgentRegistry {
  all(): AgentAdapter[];
  byId(id: string): AgentAdapter | undefined;
  ids(): string[];
}

// ---------------------------------------------------------------------- git

export interface MrRequest {
  branch: string;
  title: string;
  body: string;
  /** 目标分支（默认分支）。push 命令已经知道它，显式传入以免 provider 反查本地 checkout */
  targetBranch?: string;
}

export interface MrResult {
  /** MR URL；generic provider 时为 null */
  url: string | null;
  /** 给用户看的下一步指引（generic 或 token 缺失时非空；成功路径也可携带说明性备注） */
  instructions?: string;
  /**
   * 本次实际使用的远端分支名（2026-10-19 增量扩展）。免 git 推送由 provider 决定分支
   * （可能复用既有分支），调用方展示与记账需要知道最终用了哪个；openMr 场景恒等于
   * req.branch，可不填。
   */
  branch?: string;
  /** 空仓库引导提交已直推默认分支、无需 MR（2026-10-19 增量扩展，仅 apiPush 使用） */
  bootstrapped?: boolean;
}

/**
 * 免 git 推送请求（2026-10-19 增量扩展，未改既有签名，本扩展已经用户批准）。
 * 本机没有 git 时，`GitProvider.apiPush` 用纯 OpenAPI 完成「（复用或新建）分支 → 写文件 →
 * 删文件 → 开 MR」，files / removedPaths 与 git 路径的 MrChange 同源（仓库根相对路径 → 内容）。
 * 分支策略由 provider 负责：按 branchPrefix 复用远端既有未合并分支，没有才新开（与 git 路径
 * 的 listRemoteBranches 复用语义对齐）——调用方没有 git，列不了远端分支。
 */
export interface ApiPushRequest {
  /** 分支前缀（如 ejdrone/push-skills-alpha-）；provider 在此基础上复用或新建分支 */
  branchPrefix: string;
  /** 目标分支（默认分支）；缺省由 provider 回落 main */
  targetBranch?: string;
  title: string;
  body: string;
  /** 仓库根相对路径 → 内容（与 MrChange.files 同形） */
  files: Record<string, string>;
  /**
   * 要从仓库删除的仓库根相对路径。可能是目录（skills/<ns>/<name>），provider 负责
   * 展开成目标分支上的具体文件路径再逐个删除。
   */
  removedPaths?: string[];
  /**
   * 空仓库首笔引导（2026-10-19 增量扩展）：远端没有任何提交时为 true，provider 把
   * files 直接写入默认分支（不开分支不开 MR），对应 git 路径的 bootstrap 语义。
   */
  bootstrap?: boolean;
}

export interface GitProvider {
  readonly kind: Config['provider'];
  openMr(req: MrRequest): Promise<MrResult>;
  /**
   * 可选（2026-10-19 增量扩展，未改既有签名）：托管有 OpenAPI 时实现，
   * 承接本机没有 git 的推送降级；没有实现的能力按「不支持免 git 推送」处理。
   * 与 openMr 同一姿态：失败折进 MrResult.instructions，绝不上抛（远端可能已推了一半）。
   */
  apiPush?(req: ApiPushRequest): Promise<MrResult>;
}

export interface CheckoutHandle {
  dir: string;
  /** 当前 checkout 的 commit */
  head: string;
}

/** 推送前扫描扩展点（设计文档 §10 第 5 条，v1 为空实现） */
export type PrePushScan = (files: Record<string, string>) => string[];
