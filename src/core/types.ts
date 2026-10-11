/**
 * ejdrone-skills 跨模块契约 —— 已冻结。
 *
 * 三个并行实现方（core / agents / git+state+hooks）都只依赖本文件通信。
 * 若你认为某个签名需要调整：不要就地修改，把理由回报给协调者。
 *
 * 设计文档：docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md
 */

// ---------------------------------------------------------------- 资源模型

/**
 * 2.0 M6：新增 'mcp'。后续里程碑（M7 子 Agent、M8 团队知识、M9 经验沉淀）各自再加，
 * 加进这个联合类型后 `KindSet` 会强制所有分派点补齐 —— 漏一处就编译不过。
 */
export type ResourceKind = 'skills' | 'rules' | 'mcp';

/** 全部资源类型的集合；装配与测试用 `emptyKinds()` 起头。 */
export type KindSet = Record<ResourceKind, Resource[]>;

/** 一条团队资源。
 * namespace === '' 表示仓库根目录条目（全员共享）。
 * files: skills 为「仓库内相对路径 → 内容」（必含 SKILL.md）；rules 为 { content: 正文 }；
 * mcp 为空对象，结构化内容在 payload（`mcp/mcp.yaml` 是列表文件，解析后一个 server 一条 Resource）。
 */
export interface Resource {
  kind: ResourceKind;
  namespace: string;
  name: string;
  files: Record<string, string>;
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
  provider: 'gitlab' | 'git';
  gitlabBaseUrl?: string;
  primaryRole: string | null;
  additionalRoles: string[];
  /** init 时选定的工具 id 列表；追加不覆盖 */
  agents: string[];
}

// ---------------------------------------------------------------------- plan

export interface ResolveInput {
  /** 待裁决的全部资源，按 kind 分组（用 emptyKinds() 起头装配） */
  kinds: KindSet;
  /** primaryRole + additionalRoles 映射出的 namespace 并集 */
  activeNamespaces: string[];
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

/** 空的 kind 集合；装配数据与测试都用它起头，新增 kind 时编译期会提醒补全所有分派点。 */
export const RESOURCE_KINDS: ResourceKind[] = ['skills', 'rules', 'mcp'];

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
  };
}

/** 因管辖权或本地修改而保留不动的既有文件 */
export interface KeptFile {
  path: string;
  resource: ResourceKey;
  reason: 'modified-locally' | 'foreign-file';
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
   */
  planMcp?(servers: Resource[], home: string, env: NodeJS.ProcessEnv): PlannedWrite[];

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
  /** 给用户看的下一步指引（generic 或 token 缺失时非空） */
  instructions?: string;
}

export interface GitProvider {
  readonly kind: Config['provider'];
  openMr(req: MrRequest): Promise<MrResult>;
}

export interface CheckoutHandle {
  dir: string;
  /** 当前 checkout 的 commit */
  head: string;
}

/** 推送前扫描扩展点（设计文档 §10 第 5 条，v1 为空实现） */
export type PrePushScan = (files: Record<string, string>) => string[];
