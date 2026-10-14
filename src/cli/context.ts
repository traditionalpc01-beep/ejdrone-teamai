import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * 命令层唯一的进程边界：env / cwd / 输出 / 交互都从这里注入，
 * 端到端测试因此能伪造 HOME 而不碰真实目录。
 */
export interface Choice {
  value: string;
  label: string;
}

export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
  prompt(question: string, def?: string): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  /** 多选：返回选中项的 value（顺序按 items 原序） */
  choose(question: string, items: Choice[], preset: string[]): Promise<string[]>;
}

export type CliContextInput = Partial<Omit<CliContext, 'home'> & { home: string }>;

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== '' ? value : null;
}

function askLine(text: string): Promise<string> {
  return new Promise((fulfill) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (answer: string): void => {
      if (done) return;
      done = true;
      fulfill(answer.trim());
    };
    rl.question(text, (answer) => {
      finish(answer);
      rl.close();
    });
    rl.on('close', () => finish(''));
  });
}

export function createContext(input: CliContextInput = {}): CliContext {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const home = input.home ?? nonEmpty(env.HOME) ?? homedir();
  const out = input.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = input.err ?? ((text: string) => process.stderr.write(`${text}\n`));
  const interactive =
    input.interactive ??
    (Boolean(process.stdin.isTTY) && nonEmpty(env.EJDRONE_NONINTERACTIVE) === null && nonEmpty(env.CI) === null);

  const defaultPrompt = async (question: string, def?: string): Promise<string> => {
    const hint = def ? ` [${def}]` : '';
    const answer = await askLine(`${question}${hint}: `);
    return answer === '' ? (def ?? '') : answer;
  };

  const defaultConfirm = async (question: string, def = false): Promise<boolean> => {
    const hint = def ? 'Y/n' : 'y/N';
    const answer = (await askLine(`${question} [${hint}]: `)).toLowerCase();
    if (answer === '') return def;
    return answer === 'y' || answer === 'yes';
  };

  const defaultChoose = async (question: string, items: Choice[], preset: string[]): Promise<string[]> => {
    out(question);
    items.forEach((item, index) => {
      out(`  ${index + 1}. ${item.label}${preset.includes(item.value) ? ' [已选]' : ''}`);
    });
    const answer = await askLine('输入序号（逗号分隔，回车保持默认）: ');
    if (answer === '') return preset.filter((v) => items.some((i) => i.value === v));
    const picked = new Set<string>();
    for (const token of answer.split(/[,，\s]+/).filter((t) => t !== '')) {
      const index = Number(token);
      const item = Number.isInteger(index) && index >= 1 && index <= items.length ? items[index - 1] : undefined;
      if (item) picked.add(item.value);
    }
    return items.filter((i) => picked.has(i.value)).map((i) => i.value);
  };

  // 交互函数必须可注入：端到端测试不碰 stdin
  return {
    env,
    cwd,
    home: resolve(home),
    out,
    err,
    interactive,
    prompt: input.prompt ?? defaultPrompt,
    confirm: input.confirm ?? defaultConfirm,
    choose: input.choose ?? defaultChoose,
  };
}

/** 面向人的错误：必须带上"下一步做什么"。 */
export function reportError(ctx: CliContext, message: string, nextStep: string): void {
  ctx.err(`错误：${message}`);
  ctx.err(`下一步：${nextStep}`);
}

export function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(/[,，]/)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** commander 的累积型选项 */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
