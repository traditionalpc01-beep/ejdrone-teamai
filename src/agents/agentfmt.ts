import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { completeFrontmatter } from '../core/resources.js';
import type { AgentsFormat } from './paths.js';

/**
 * M7 子 Agent 的格式转换收口（AGENTS.md 的「模式实现收口在一处」同条规矩：
 * 四种 AgentsFormat 的全部转换只允许出现在这个文件，适配器与 common.ts 都不许按工具 id 判断）。
 *
 * 冻结事实（2.0 计划 §7.1，照抄不必重新讨论）：
 * - `md` / `agent-md`：正文与已有 frontmatter **逐字节保留**，只补全缺失的 name/description
 *   （completeFrontmatter 的既有语义：坏 YAML 保留原文 + warning）。agent-md 与 md 内容相同，
 *   差别只在文件名（`.agent.md`，AGENTS_EXT 负责）。
 * - `toml`（Codex）：只出 `name/description/developer_instructions/model`，**故意不写 tools**
 *   —— teamai 实测结论，键多写反而不被读。
 * - `json`（Kiro）：出 `name/description/prompt/model/tools`；teamai 往同一文件注入
 *   `hooks.agentSpawn`，我们**不做**（agents 与 hooks 两条链路，混一起会让「装了什么 hook」无处可查）。
 *
 * 所有形态都保证「正文一字不变」：转换只动 frontmatter/封装 ——
 * toml 的 developer_instructions 与 json 的 prompt 反解回来必须与 body 逐字节相等。
 */

export interface AgentRenderInput {
  /** 条目名（文件名去扩展名；也是 ledger 记账名的来源） */
  name: string;
  /** frontmatter 的 description；缺失时是 ''（渲染层各自回退：md 走 completeFrontmatter 推导，其余退 name） */
  description: string;
  /** frontmatter 的 tools（逗号串或数组都已归一）；无则 undefined */
  tools?: string[];
  model?: string;
  /** 去 frontmatter 后的正文，逐字节投递 */
  body: string;
  /** 仓库原文（含 frontmatter）；md/agent-md 以它为源 */
  raw: string;
}

export interface AgentRenderOutcome {
  content: string;
  /** 人类可读告警（如坏 YAML 保留原文）；planAgents 的冻结签名没有 note 通道，调用方能接就接 */
  warning?: string;
}

const FRONTMATTER_OPEN_RE = /^---[ \t]*\r?\n/;

/**
 * 与 resources.ts 的私有 splitFrontmatter 同一形状的解析（那边没导出，契约文件不改，这里自备一份薄解析）。
 * 解析不出（无围栏 / 坏 YAML）时返回 null，调用方按「无 frontmatter」处理。
 */
function split(content: string): { map: Record<string, unknown>; body: string } | null {
  const open = FRONTMATTER_OPEN_RE.exec(content);
  if (!open) return null;
  const afterOpen = content.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(afterOpen);
  if (!close) return null;
  const fenceStart = close.index + (close[1] ?? '').length;
  const fence = /^---[ \t]*(\r?\n|$)/.exec(afterOpen.slice(fenceStart));
  if (!fence) return null;
  let parsed: unknown;
  try {
    parsed = afterOpen.slice(0, close.index).trim() === '' ? {} : parseYaml(afterOpen.slice(0, close.index));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return { map: parsed as Record<string, unknown>, body: afterOpen.slice(fenceStart + fence[0].length) };
}

function toList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const parts = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    return parts.length > 0 ? parts : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

/** 仓库 md 原文 → 结构化渲染输入。坏/无 frontmatter 都不抛：正文按全文处理。 */
export function parseAgentSource(content: string, name: string): AgentRenderInput {
  const split_ = split(content);
  if (!split_) return { name, description: '', body: content, raw: content };
  const description = typeof split_.map.description === 'string' ? split_.map.description : '';
  const model = typeof split_.map.model === 'string' && split_.map.model !== '' ? split_.map.model : undefined;
  const tools = toList(split_.map.tools);
  return { name, description, tools, model, body: split_.body, raw: content };
}

/** TOML basic string：JSON.stringify 的转义集是 TOML 合法子集（与 mcpfmt 同一口径）。 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function renderAgentChecked(input: AgentRenderInput, format: AgentsFormat): AgentRenderOutcome {
  switch (format) {
    case 'md':
    case 'agent-md': {
      const done = completeFrontmatter(input.raw, input.name);
      const warning =
        done.warning === undefined
          ? undefined
          : `agent "${input.name}" 的 frontmatter 无法补全，按原文投递：${done.warning}`;
      return { content: done.content, warning };
    }
    case 'toml': {
      const lines = [
        `name = ${tomlString(input.name)}`,
        `description = ${tomlString(input.description === '' ? input.name : input.description)}`,
        `developer_instructions = ${tomlString(input.body)}`,
      ];
      // model 没有文档化字段时不硬造？codex 的 agent toml 有 model（teamai 表）；tools 则是**故意不写**。
      if (input.model !== undefined) lines.push(`model = ${tomlString(input.model)}`);
      return { content: `${lines.join('\n')}\n` };
    }
    case 'json': {
      const obj: Record<string, unknown> = {
        name: input.name,
        description: input.description === '' ? input.name : input.description,
        prompt: input.body,
      };
      if (input.model !== undefined) obj.model = input.model;
      if (input.tools !== undefined) obj.tools = input.tools;
      return { content: `${JSON.stringify(obj, null, 2)}\n` };
    }
  }
}

export function renderAgent(input: AgentRenderInput, format: AgentsFormat): string {
  return renderAgentChecked(input, format).content;
}

/**
 * 反向转换（push --agent 采集用）：工具目录里的投递形态 → 仓库 md 原文。
 * - md / agent-md：逐字节回原样（我们投的就是补全过的仓库 md）。
 * - json：还原 frontmatter + prompt 正文。解析不出返回 error（点名，不产半成品）。
 * - toml：不做反向解析 —— 与 MCP 侧「TOML 落点只点名、不请回解析器」同一决定（父计划 §7.1）。
 */
export function agentToRepoMarkdown(
  content: string,
  format: AgentsFormat,
): { markdown?: string; error?: string } {
  switch (format) {
    case 'md':
    case 'agent-md':
      return { markdown: content };
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        return { error: `该 json 落点文件不是合法 JSON：${(e as Error).message}` };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: '该 json 落点文件的顶层不是对象' };
      }
      const map = parsed as Record<string, unknown>;
      const prompt = typeof map.prompt === 'string' ? map.prompt : null;
      if (prompt === null) return { error: '该 json 落点文件里没有字符串的 prompt 字段（正文无从还原）' };
      const fm: Record<string, unknown> = {};
      if (typeof map.name === 'string' && map.name !== '') fm.name = map.name;
      if (typeof map.description === 'string' && map.description !== '') fm.description = map.description;
      if (typeof map.model === 'string' && map.model !== '') fm.model = map.model;
      const tools = toList(map.tools);
      if (tools !== undefined) fm.tools = tools;
      const text = stringifyYaml(fm, { lineWidth: 0 }).replace(/\s+$/, '');
      return { markdown: `---\n${text}\n---\n${prompt}` };
    }
    case 'toml':
      return {
        error:
          '该落点是 toml 形态（Codex），投递时只做受控拼接、故意没有反向解析器 —— 与 push --mcp 对 TOML 的决定同一口径',
      };
  }
}
