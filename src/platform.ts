import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * M10「Windows 支持」的平台差异收口层（T10.1）：Windows 与 POSIX 的差异全部收敛成纯函数，
 * 后续任务（hook 命令形态、doctor 检查、PATHEXT 探测、路径比较）只调这一层。
 *
 * 所有函数显式接收 env / platform 参数，不在函数外读 process.env、不做模块级 process.env 绑定
 * （默认参数 `= process.platform` 是唯一例外：它只是平台标识，不涉及 env 内容），
 * 这样测试能在同一进程里注入多套 env 做端到端隔离——开发机是 macOS，没有 Windows 真机，
 * win32 行为全靠注入 `platform` 参数覆盖。
 */

/** 当前是否 Windows。platform 可注入（测试用），默认 process.platform。 */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

// ------------------------------------------------------------------ findGitBash

/**
 * 找 Git for Windows 的 bash.exe 绝对路径；找不到返回 null。
 *
 * 为什么不用 PATH 上的裸 bash：团队踩坑结论——裸 bash 可能解析到 WSL 启动器，跑起来的
 * shell 不是 MSYS2 环境，Node 18 跑不动我们的产物，hook 直接静默崩。必须锁定 Git 安装目录
 * 下的 bin\bash.exe（自带 MSYS2 运行时，git/curl 等产物才稳）。
 *
 * 为什么 reg query 失败必须 catch：非 Windows 机器上 reg 不存在（ENOENT）、没装
 * Git for Windows 时注册表无该键（非 0 退出码）、输出解析不出值——这些全是「没装」的
 * 正常形态，静默继续下一个候选即可；外抛会让上层整条链路崩掉。
 */
/** 注册表读取器：抽出来是为了让「没有 Git for Windows」这条分支在任何主机上都可测。 */
export type GitInstallPathReader = (env: NodeJS.ProcessEnv) => string | null;

export function findGitBash(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  readRegistry: GitInstallPathReader = gitInstallPathFromRegistry,
): string | null {
  if (platform !== 'win32') return null; // 非 Windows：不碰 env、不跑 reg
  const candidates: string[] = [];
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const dir = envGet(env, key);
    if (dir !== undefined && dir !== '') candidates.push(join(dir, 'Git', 'bin', 'bash.exe'));
  }
  // 非管理员用户运行 Git for Windows 安装器时默认装到 %LOCALAPPDATA%\Programs\Git
  // （没有写 ProgramFiles 的权限姿态）—— 企业电脑极常见此形态，漏查会让 init 误报
  // "需要安装 Git for Windows"（其实装了），会话自动 pull 静默缺失。LOCALAPPDATA 缺省时跳过。
  const localAppData = envGet(env, 'LOCALAPPDATA');
  if (localAppData !== undefined && localAppData !== '') {
    candidates.push(join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  const installPath = readRegistry(env);
  if (installPath !== null) candidates.push(join(installPath, 'bin', 'bash.exe'));
  for (const candidate of candidates) {
    if (isRegularFile(candidate)) return candidate;
  }
  return null;
}

/**
 * reg query <hive>\SOFTWARE\GitForWindows /v InstallPath → InstallPath 的值；任何失败返回 null。
 * 输出形如（值可能是含空格的路径，必须整段截取到行尾）：
 *   HKEY_LOCAL_MACHINE\SOFTWARE\GitForWindows
 *       InstallPath    REG_SZ    C:\Program Files\Git
 *
 * hive 顺序 HKLM → HKCU：系统级安装写 HKLM，**非管理员用户的 per-user 安装写 HKCU**
 * （安装器没有权限写 HKLM 时的默认行为）—— 两条都查才能覆盖企业电脑的常见形态。
 */
function gitInstallPathFromRegistry(env: NodeJS.ProcessEnv): string | null {
  for (const hive of ['HKLM', 'HKCU'] as const) {
    const found = queryRegistryInstallPath(env, hive);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 查单个 hive 的 GitForWindows InstallPath。导出不是为了给业务代码用（业务只走 findGitBash），
 * 而是让真机验证脚本能只针对 HKCU 跑生产代码路径 —— 注入式单测的注册表读取器是假的，
 * 「HKCU 有值而 HKLM 没有」这个子形态在真机上只有这条路能按原代码验证。
 */
export function queryRegistryInstallPath(env: NodeJS.ProcessEnv, hive: 'HKLM' | 'HKCU'): string | null {
  try {
    const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*InstallPath\s+REG_SZ\s+(.*\S)\s*$/i.exec(line);
      if (m) return m[1] ?? null;
    }
    return null;
  } catch {
    return null; // reg 不存在/权限不足/键不存在/解析不出：都当没装，不抛
  }
}

// -------------------------------------------------------------- whichWithPathext

/** PATHEXT 缺省值（Windows 默认四件套）。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * 带 PATHEXT 的 PATH 查找（对应 POSIX 的 which / mcpfmt 的 whichOn）。
 *
 * win32：
 * - name 为空 → null；
 * - name 是绝对路径或含路径分隔符（\ 或 /）→ 直探该路径本身，找不到再依次拼 PATHEXT 各后缀；
 * - 否则遍历 PATH 目录（';' 分隔），每级目录依次试 name、name+ext（PATHEXT 各后缀）；
 * - PATHEXT 从 env 大小写不敏感读取，后缀匹配大小写不敏感（PATHEXT 常写作大写 .EXE，
 *   磁盘文件常是小写 fake.exe——真 Windows 文件系统本就大小写不敏感，多写法是给
 *   大小写敏感的 POSIX 测试机与跨平台一致性兜底）；
 * - 命中判据：存在且是普通文件（statSync().isFile()）——目录同名不算，与 CreateProcess 一致。
 *
 * 非 win32：退化为 POSIX which——PATH 用 ':' 分隔、只试 name 本身（不加后缀）、要求 X_OK，
 * 语义与 mcpfmt.whichOn 完全一致。
 */
export function whichWithPathext(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (name === '') return null;
  if (platform === 'win32') return whichOnWin32(name, env);
  return whichOnPosix(name, env);
}

function whichOnWin32(name: string, env: NodeJS.ProcessEnv): string | null {
  const exts = pathextList(env);
  // 直探一个基路径：先裸名，再依次拼 PATHEXT 各后缀（每种后缀试三种大小写写法）。
  const probe = (base: string): string | null => {
    if (isRegularFile(base)) return base;
    for (const ext of exts) {
      for (const variant of extCaseVariants(ext)) {
        const withExt = base + variant;
        if (isRegularFile(withExt)) return withExt;
      }
    }
    return null;
  };
  // isAbsolute 在 POSIX 测试机上对 C:\ 形态判 false，所以必须补 \ 与 / 的分隔符判断，
  // 才能把 win32 绝对路径（C:\x、C:/x）与相对路径名（.\x、sub/x）都收进直探分支。
  if (isAbsolute(name) || name.includes('\\') || name.includes('/')) return probe(name);
  for (const dir of (envGet(env, 'PATH') ?? '').split(';')) {
    if (dir === '') continue;
    const found = probe(join(dir, name));
    if (found !== null) return found;
  }
  return null;
}

/** PATHEXT 列表：env 大小写不敏感读取，缺省 '.COM;.EXE;.BAT;.CMD'；按 ';' 分割、去空项。 */
function pathextList(env: NodeJS.ProcessEnv): string[] {
  const raw = envGet(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * 同一后缀的候选写法，按「小写 → as-is → 大写」去重。
 * 为什么小写优先：PATHEXT 常写作大写（.EXE）而磁盘文件常是小写（fake.exe），
 * 大小写不敏感的文件系统上三种写法都能命中，小写优先保证返回的是磁盘上的真实文件名
 * （上层拿这个路径去拼命令/打日志，看到的名字应该跟磁盘一致）。
 */
function extCaseVariants(ext: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const variant of [ext.toLowerCase(), ext, ext.toUpperCase()]) {
    if (!seen.has(variant)) {
      seen.add(variant);
      ordered.push(variant);
    }
  }
  return ordered;
}

/** POSIX 分支：语义与 mcpfmt.whichOn 完全一致（':' 分 PATH、只试裸名、要求 X_OK）。 */
function whichOnPosix(name: string, env: NodeJS.ProcessEnv): string | null {
  const probe = (candidate: string): string | null => {
    try {
      if (!statSync(candidate).isFile()) return null;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      return null; // 不存在/无权限：换下一个候选，不抛
    }
  };
  if (name.includes('/')) return name.startsWith('/') ? probe(name) : null;
  const pathValue = envGet(env, 'PATH') ?? '';
  for (const dir of pathValue.split(':')) {
    if (dir === '') continue;
    const found = probe(join(dir, name));
    if (found !== null) return found;
  }
  return null;
}

// --------------------------------------------------------------------- samePath

/**
 * 路径相等比较。POSIX：严格 ===。win32：大小写不敏感 + '/'/'\\' 归一后比较
 * （Windows 文件系统大小写不敏感、两种斜杠等价——doctor 判「同一路径」必须走这里）。
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return a === b;
  const normalize = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  return normalize(a) === normalize(b);
}

// ---------------------------------------------------------------------- helpers

/** 命中判据：路径存在且是普通文件（目录/断链 symlink/无权限都算没有，绝不抛）。 */
function isRegularFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * env 键大小写不敏感读取：Windows 上 ProgramFiles 可能是 programfiles（历史遗留的大小写抖动）。
 * 先精确匹配（快路径），再大小写不敏感扫描 Object.keys（慢路径）。
 */
function envGet(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = env[key];
  if (exact !== undefined) return exact;
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) return env[k];
  }
  return undefined;
}
