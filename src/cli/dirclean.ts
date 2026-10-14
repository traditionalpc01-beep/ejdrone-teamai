import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** path 是否严格位于 dir 之下（resolve 后比较，防越界）。 */
function under(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function boundaryOf(path: string, roots: string[]): string | null {
  for (const root of roots) {
    if (under(path, root)) return resolve(root);
  }
  return null;
}

/**
 * 删完文件后收掉只剩空壳的目录：AI 工具会把空 skill 目录当无效条目。
 * 只在给定根目录之内向上收，绝不越过根目录本身。
 */
export function pruneAfterDeletions(paths: string[], roots: string[]): number {
  let removed = 0;
  for (const path of paths) {
    const boundary = boundaryOf(path, roots);
    if (boundary === null) continue;
    let current = dirname(resolve(path));
    while (current !== boundary && under(current, boundary)) {
      if (!existsSync(current)) {
        current = dirname(current);
        continue;
      }
      if (readdirSync(current).length > 0) break;
      try {
        rmdirSync(current);
        removed += 1;
      } catch {
        break;
      }
      current = dirname(current);
    }
  }
  return removed;
}
