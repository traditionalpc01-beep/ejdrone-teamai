import { describe, expect, it } from 'vitest';

import {
  agentToRepoMarkdown,
  parseAgentSource,
  renderAgent,
  renderAgentChecked,
  type AgentRenderInput,
} from '../../src/agents/agentfmt.js';

/**
 * M7 子 Agent 的四种目标形态（paths.ts 的 AgentsFormat）收口测试。
 * 分派只按 format，不按工具 id —— 这里全部直接调纯函数，不经过任何适配器。
 */

const BODY = '# Reviewer\n\n逐步核对改动。\n- 要点一\n';

const withFm = '---\nname: reviewer\ndescription: 评审助手\ntools: Read, Grep\nmodel: sonnet\n---\n' + BODY;
const noFm = BODY;
const brokenFm = '---\nname: [unclosed\n---\n' + BODY;

function input(patch: Partial<AgentRenderInput> = {}): AgentRenderInput {
  return {
    name: 'reviewer',
    description: '评审助手',
    tools: ['Read', 'Grep'],
    model: 'sonnet',
    body: BODY,
    raw: withFm,
    ...patch,
  };
}

describe('parseAgentSource', () => {
  it('解析 frontmatter 的 description/tools/model，body 去 frontmatter 后逐字节保留', () => {
    const spec = parseAgentSource(withFm, 'reviewer');
    expect(spec.name).toBe('reviewer');
    expect(spec.description).toBe('评审助手');
    expect(spec.tools).toEqual(['Read', 'Grep']);
    expect(spec.model).toBe('sonnet');
    expect(spec.body).toBe(BODY);
    expect(spec.raw).toBe(withFm);
  });

  it('tools 数组形态同样归一为数组', () => {
    const spec = parseAgentSource('---\nname: x\ntools:\n  - Read\n  - Write\n---\nbody\n', 'x');
    expect(spec.tools).toEqual(['Read', 'Write']);
  });

  it('无 frontmatter：description 回退空（渲染层补 name），body 即全文', () => {
    const spec = parseAgentSource(noFm, 'reviewer');
    expect(spec.description).toBe('');
    expect(spec.body).toBe(BODY);
  });

  it('坏 YAML：不抛错，body 保留全文交给渲染层原样处理', () => {
    const spec = parseAgentSource(brokenFm, 'reviewer');
    expect(spec.body).toBe(brokenFm);
  });
});

describe('renderAgent: md', () => {
  it('已有完整 frontmatter：逐字节原样投（teamai 旧格式"逐字节复制"的语义保留）', () => {
    expect(renderAgent(input(), 'md')).toBe(withFm);
  });

  it('缺 frontmatter：补 name/description，正文一字不变', () => {
    const out = renderAgent(parseAgentSource(noFm, 'reviewer'), 'md');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('name: reviewer');
    expect(out.endsWith(BODY)).toBe(true);
    // 正文部分逐字节 = 原文（转换只动 frontmatter）
    expect(out.slice(out.indexOf('\n---\n') + '\n---\n'.length)).toBe(BODY);
  });

  it('frontmatter 多余键（color 等）原样保留', () => {
    const raw = '---\nname: reviewer\ndescription: 评审助手\ncolor: green\n---\n' + BODY;
    expect(renderAgent(parseAgentSource(raw, 'reviewer'), 'md')).toBe(raw);
  });

  it('坏 YAML：保留原文并给出 warning（renderAgentChecked），renderAgent 不抛', () => {
    const checked = renderAgentChecked(parseAgentSource(brokenFm, 'reviewer'), 'md');
    expect(checked.warning).toContain('invalid');
    expect(checked.content).toBe(brokenFm);
  });
});

describe('renderAgent: agent-md', () => {
  it('内容与 md 完全一致（差别只在文件名，AGENTS_EXT 负责）', () => {
    expect(renderAgent(input(), 'agent-md')).toBe(renderAgent(input(), 'md'));
  });
});

describe('renderAgent: toml（codex）', () => {
  it('出 name/description/developer_instructions/model，**不写 tools**（§7.1 冻结）', () => {
    const out = renderAgent(input(), 'toml');
    expect(out).toBe(
      `name = "reviewer"\ndescription = "评审助手"\ndeveloper_instructions = ${JSON.stringify(BODY)}\nmodel = "sonnet"\n`,
    );
    expect(out).not.toContain('tools');
  });

  it('缺 model/tools 时不硬造键；正文含引号换行也只靠转义承载（正文一字不变）', () => {
    const body = '他说"要改"\n然后换行\n';
    const out = renderAgent(input({ model: undefined, tools: undefined, body }), 'toml');
    expect(out).not.toContain('model');
    expect(out).not.toContain('tools');
    // developer_instructions 反解回原文逐字节
    const quoted = /developer_instructions = (.*)\n/.exec(out)?.[1];
    expect(quoted).toBeDefined();
    expect(JSON.parse(quoted as string)).toBe(body);
  });
});

describe('renderAgent: json（kiro）', () => {
  it('出 name/description/prompt/model/tools，不注入 hooks.agentSpawn（§7.1 冻结）', () => {
    const out = renderAgent(input(), 'json');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.name).toBe('reviewer');
    expect(parsed.description).toBe('评审助手');
    expect(parsed.prompt).toBe(BODY);
    expect(parsed.model).toBe('sonnet');
    expect(parsed.tools).toEqual(['Read', 'Grep']);
    expect(parsed.hooks).toBeUndefined();
    expect(out).not.toContain('agentSpawn');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('缺 tools/model 时省略键；prompt 与正文逐字节一致', () => {
    const out = renderAgent(input({ tools: undefined, model: undefined }), 'json');
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect('tools' in parsed).toBe(false);
    expect('model' in parsed).toBe(false);
    expect(parsed.prompt).toBe(BODY);
  });
});

describe('agentToRepoMarkdown（push --agent 反向采集）', () => {
  it('md / agent-md：逐字节回原样（仓库侧本就是 md）', () => {
    expect(agentToRepoMarkdown(withFm, 'md').markdown).toBe(withFm);
    expect(agentToRepoMarkdown(withFm, 'agent-md').markdown).toBe(withFm);
  });

  it('json：还原 frontmatter + prompt 正文', () => {
    const json = renderAgent(input(), 'json');
    const back = agentToRepoMarkdown(json, 'json');
    expect(back.error).toBeUndefined();
    const spec = parseAgentSource(back.markdown as string, 'reviewer');
    expect(spec.description).toBe('评审助手');
    expect(spec.model).toBe('sonnet');
    expect(spec.tools).toEqual(['Read', 'Grep']);
    expect(spec.body).toBe(BODY);
  });

  it('json 解析不出来：拒绝并说明，不产出半成品', () => {
    const back = agentToRepoMarkdown('{ broken', 'json');
    expect(back.markdown).toBeUndefined();
    expect(back.error).toContain('JSON');
  });

  it('toml：不做反向解析（照 MCP 的 TOML 决定），点名原因与出路', () => {
    const back = agentToRepoMarkdown(renderAgent(input(), 'toml'), 'toml');
    expect(back.markdown).toBeUndefined();
    expect(back.error).toContain('toml');
  });
});
