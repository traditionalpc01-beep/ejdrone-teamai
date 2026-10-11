/**
 * ejdrone-skills 跨模块契约 —— 已冻结。
 *
 * 三个并行实现方（core / agents / git+state+hooks）都只依赖本文件通信。
 * 若你认为某个签名需要调整：不要就地修改，把理由回报给协调者。
 *
 * 设计文档：docs/superpowers/specs/2026-10-11-ejdrone-skills-design.md
 */

// ---------------------------------------------------------------- 资源模型

/** v1 只做两类。预留 'mcp' | 'env'，新增一类不得改动下面的算法签名。 */
export type ResourceKind = 'skills' | 'rules';

/**
 * 一条团队资源。
 * namespace === '' 表示仓库根目录条目（全员共享）。
 * files: skills 为「仓库内相对路径 → 内容」（必含 SKILL.md）；rules 为 { content: 正文 }。
 */
export interface Resource {
  kind: ResourceKind;
  namespace: string;
  name: string;
  files: Record<string, string>;
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

// ------------------------------------------------------------------ 仓库快照

/** 一次 pull 读到的团队仓库快照（由 git/repo.ts 采集，core/resources.ts 解析填充） */
export interface RepoSnapshot {
  /** checkout 绝对路径 */
  root: string;
  /** manifest 解析结果 */
  manifest: ManifestParseResult;
  skills: Resource[];
  rules: Resource[];
  /** 仓库内被跳过的条目（如缺 SKILL.md），人类可读 */
  warnings: string[];
}

// ---------------------------------------------------------------------- plan

export interface ResolveInput {
  skills: Resource[];
  rules: Resource[];
  /** primaryRole + additionalRoles 映射出的 namespace 并集 */
  activeNamespaces: string[];
}

/**
 * 纯函数的命名空间裁决结果（设计文档 §7 步骤 1-3）。
 * conflicts 非空时，该 kind 本次整体停发，其他 kind 不受影响。
 */
export interface Resolution {
  skills: Resource[];
  rules: Resource[];
  conflicts: string[];
  warnings: string[];
  /**
   * 因冲突被整体停发的 kind。调用方必须据此跳过该 kind 的投递计划 ——
   * 空数组对 block 模式适配器意味着"清空团队区块"，而停发要求的是"不动已装内容"。
   */
  haltedKinds: ResourceKind[];
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
