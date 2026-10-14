// 把内置技能正文复制进构建产物：npm 只发布 dist/（package.json 的 files），
// 而 dist/cli/builtin-skills.js 是从 ../skills/<name>/SKILL.md 读它们的。
// 为什么不是 npm script 里写 `cp -r`：本项目支持 macOS / Linux / Windows，cmd.exe 没有 cp。
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'skills');
const to = join(root, 'dist', 'skills');

if (!existsSync(from)) {
  console.log(`[copy-skills] 没有 ${from}，跳过（内置技能正文尚未就位）`);
} else {
  cpSync(from, to, { recursive: true });
  console.log('[copy-skills] skills/** -> dist/skills/**');
}
