/**
 * 区块（region）投递的标记语义 —— 唯一实现处。
 * apply 写入与 uninstall 撤销必须用同一套定位与规范化，否则"这块内容是不是我们投递的"
 * 会在两处得出不同结论。
 */

export interface RegionLocation {
  /** start 标记所在行的行首 */
  lineStart: number;
  /** end 标记所在行的行尾之后（含那个换行） */
  lineEnd: number;
  /** 区块正文起点（start 行之后） */
  contentStart: number;
  /** 区块正文终点（end 行的行首） */
  contentEnd: number;
}

/** 定位第一对 start/end 标记；标记不完整（孤儿）时返回 null。 */
export function locateRegion(text: string, start: string, end: string): RegionLocation | null {
  const a = text.indexOf(start);
  if (a < 0) return null;
  const nlAfterStart = text.indexOf('\n', a + start.length);
  if (nlAfterStart < 0) return null;
  const contentStart = nlAfterStart + 1;
  const b = text.indexOf(end, contentStart);
  if (b < 0) return null;
  const endLineStart = text.lastIndexOf('\n', b - 1) + 1;
  const contentEnd = Math.max(contentStart, endLineStart);
  const afterEnd = text.indexOf('\n', b + end.length);
  return {
    lineStart: text.lastIndexOf('\n', a - 1) + 1,
    lineEnd: afterEnd < 0 ? text.length : afterEnd + 1,
    contentStart,
    contentEnd,
  };
}

export function normalizeInner(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

/**
 * 出现了标记但配不成对（用户删掉一半、或顺序反了）。
 * 此时追加新区块会让 locate 把中间的正文卷进区块，永久判成本地改动并反复堆叠标记，
 * 所以宁可不动这个文件。
 */
export function hasOrphanMarker(text: string, start: string, end: string): boolean {
  if (!text.includes(start) && !text.includes(end)) return false;
  return locateRegion(text, start, end) === null;
}

/** 只替换第一对标记之间的内容；标记外的字节逐字节保持。 */
export function replaceRegion(existing: string, loc: RegionLocation, content: string): string {
  return existing.slice(0, loc.contentStart) + normalizeInner(content) + existing.slice(loc.contentEnd);
}

export function blockText(start: string, end: string, content: string): string {
  return `${start}\n${normalizeInner(content)}${end}\n`;
}

export function appendBlock(existing: string, start: string, end: string, content: string): string {
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return `${existing}${sep}${blockText(start, end, content)}`;
}

/** 撤掉整对标记及其正文（含各自所在行），标记外内容逐字节保持。 */
export function stripRegion(text: string, loc: RegionLocation): string {
  return text.slice(0, loc.lineStart) + text.slice(loc.lineEnd);
}
