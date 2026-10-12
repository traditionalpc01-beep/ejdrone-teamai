import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLOCK_RESOURCE_KEY } from '../../src/agents/block.js';
import { AGENTS_EXT, TOOL_PATHS } from '../../src/agents/paths.js';
import { HOOK_COMMAND_MARKER } from '../../src/hooks.js';
import type { AgentAdapter, PlannedWrite, Resource } from '../../src/core/types.js';

/**
 * 每个适配器都该有的一组行为断言，全部从 paths.ts 的表推导期望值。
 *
 * 1.0 时这些断言是照 claude 手写五遍，加一个工具就要抄一遍；
 * 2.0 有 16 个工具，改成表驱动：表填对了就自动获得这六项覆盖，
 * 表填错（比如 ID 与 paths.ts 对不上、rulesSubdir 写漏）当场失败。
 * 特例（env 覆盖、多级 skills 目录、无 hook 的原因文案）留在各工具自己的测试文件里。
 */

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

export const SKILL_NAME = 'demo-skill';
export const RULE_NAME = 'code-style';

export function skillFixture(): Resource {
  return {
    kind: 'skills',
    namespace: '',
    name: SKILL_NAME,
    files: { 'SKILL.md': '# Demo\nskill body\n', 'scripts/run.sh': 'echo hello\n' },
  };
}

export function ruleFixture(): Resource {
  return {
    kind: 'rules',
    namespace: '',
    name: RULE_NAME,
    files: { content: '---\ndescription: Style guide\npaths:\n  - "src/**"\n---\n\n# Code Style\nBody.\n' },
  };
}

export const AGENT_NAME = 'reviewer';

/** 带完整 frontmatter 的 agent 源：四种 format 的期望都从它推导。 */
export function agentFixture(): Resource {
  return {
    kind: 'agents',
    namespace: '',
    name: AGENT_NAME,
    files: {
      content:
        '---\nname: reviewer\ndescription: 评审助手\ntools: Read, Grep\nmodel: sonnet\n---\n\n# Reviewer\nBody.\n',
    },
  };
}

const AGENT_BODY = '\n# Reviewer\nBody.\n';

function specOf(id: string) {
  const spec = TOOL_PATHS[id];
  if (!spec) throw new Error(`describeAdapter: paths.ts 里没有 ${id}`);
  return spec;
}

/**
 * 接收适配器实例而不是 id：M5 分批落地时，新适配器还没进 index.ts 的注册表，
 * 也要能先跑这套断言。注册表版本由 suite.test.ts 遍历 AGENT_IDS 覆盖。
 */
export function describeAdapter(adapter: AgentAdapter): void {
  const id = adapter.id;
  const spec = specOf(id);
  /** 独立重算一遍期望路径（不复用 paths.ts 的 helper，否则测了个寂寞）。 */
  const expectedRoot = (home: string): string => join(home, spec.rootRel);

  describe(`adapter ${id}`, () => {
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), `ejdrone-adapter-${id}-`));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it('注册信息取自表：id 与 label 对得上', () => {
      expect(adapter.id).toBe(id);
      expect(adapter.label).toBe(spec.label);
    });

    it('detect：根目录不在则 false，存在则 true', () => {
      expect(adapter.detect(home, HOME_ENV)).toBe(false);
      mkdirSync(expectedRoot(home), { recursive: true });
      expect(adapter.detect(home, HOME_ENV)).toBe(true);
    });

    it('planSkills：每个文件一条 write，落在 <root>/<skillsSubdir>/<name>/ 下', () => {
      const writes = adapter.planSkills([skillFixture()], home, HOME_ENV);
      const base = join(expectedRoot(home), spec.skillsSubdir, SKILL_NAME);
      expect(writes).toHaveLength(2);
      const byPath = new Map(writes.map((w) => [w.path, w]));
      expect(byPath.get(join(base, 'SKILL.md'))?.content).toBe('# Demo\nskill body\n');
      expect(byPath.get(join(base, 'scripts', 'run.sh'))?.content).toBe('echo hello\n');
      for (const w of writes) {
        expect(w.resource).toBe(`skills:${SKILL_NAME}`);
        expect(w.region).toBeUndefined();
      }
    });

    it(`planRules：按表里的 rulesMode=${spec.rulesMode} 落点`, () => {
      const writes = adapter.planRules([ruleFixture()], home, HOME_ENV);
      if (spec.rulesMode === 'none') {
        expect(writes).toEqual([]);
        return;
      }
      expect(writes).toHaveLength(1);
      const w = writes[0] as PlannedWrite;
      if (spec.rulesMode === 'block') {
        expect(w.path).toBe(join(expectedRoot(home), spec.rulesBlockFile));
        expect(w.resource).toBe(BLOCK_RESOURCE_KEY);
        expect(w.region).toBeDefined();
        expect(w.content).toContain('# Code Style');
        return;
      }
      const ext = spec.rulesMode === 'mdc' ? 'mdc' : (spec.rulesExt ?? 'md');
      expect(w.path).toBe(join(expectedRoot(home), spec.rulesSubdir ?? '', `${RULE_NAME}.${ext}`));
      expect(w.resource).toBe(`rules:${RULE_NAME}`);
      expect(w.region).toBeUndefined();
    });

    it('planMcp：有 mcpTarget 的工具恒发恰好一条 merge write（entries 可为空对象）；没有则不实现 planMcp', () => {
      if (!spec.mcpTarget) {
        expect(adapter.planMcp).toBeUndefined();
        return;
      }
      expect(typeof adapter.planMcp).toBe('function');
      // 空 server 列表也必须产出这一条 —— 它是"最后一个 server 停投也能清掉"的前提；
      // 缺了它，账本与成员文件里会留下永远没人认领的孤儿条目。
      const writes = adapter.planMcp!([], home, HOME_ENV);
      expect(writes).toHaveLength(1);
      const w = writes[0] as PlannedWrite;
      expect(w.resource).toBe(`mcp:${id}-merge`);
      expect(w.content).toBe('');
      expect(w.region).toBeUndefined();
      expect(w.merge).toEqual({ format: spec.mcpTarget.format, pointer: spec.mcpTarget.pointer, entries: {} });
      // 路径独立重算：homeFile 锚 HOME，file 锚工具根（不复用 paths.ts helper）。
      const expectedPath = spec.mcpTarget.homeFile
        ? join(home, spec.mcpTarget.homeFile)
        : join(expectedRoot(home), spec.mcpTarget.file ?? '');
      expect(w.path).toBe(expectedPath);
    });

    it('planAgents：有 agents 落点 → 一 agent 一文件（namespace 拍平、按 agentsFormat 转形）；无落点则不实现 planAgents', () => {
      const format = spec.agentsFormat;
      if (!spec.agentsSubdir || !format) {
        // 能力有无只由表决定（同 mcpTarget 先例）：表里没给的工具**不实现**这个方法
        expect(adapter.planAgents).toBeUndefined();
        return;
      }
      expect(typeof adapter.planAgents).toBe('function');
      const source = (agentFixture().files as Record<string, string>)['content'];
      const writes = adapter.planAgents!([agentFixture()], home, HOME_ENV);
      expect(writes).toHaveLength(1);
      const w = writes[0] as PlannedWrite;
      // 期望路径独立重算（不复用 agentsTarget helper）
      expect(w.path).toBe(join(expectedRoot(home), spec.agentsSubdir, `${AGENT_NAME}${AGENTS_EXT[format]}`));
      expect(w.resource).toBe(`agents:${AGENT_NAME}`);
      expect(w.region).toBeUndefined();
      expect(w.merge).toBeUndefined();
      switch (format) {
        case 'md':
        case 'agent-md':
          // 完整 frontmatter → 逐字节原样（正文自然一字不变）
          expect(w.content).toBe(source);
          break;
        case 'toml':
          expect(w.content).toContain(`name = "${AGENT_NAME}"`);
          expect(w.content).toContain('developer_instructions =');
          expect(w.content).toContain('model = "sonnet"');
          // §7.1 冻结：codex 形态故意不写 tools
          expect(w.content).not.toContain('tools');
          break;
        case 'json': {
          const parsed = JSON.parse(w.content) as Record<string, unknown>;
          expect(parsed.name).toBe(AGENT_NAME);
          expect(parsed.description).toBe('评审助手');
          expect(parsed.prompt).toBe(AGENT_BODY);
          // §7.1 冻结：不注入 hooks.agentSpawn
          expect(parsed.hooks).toBeUndefined();
          break;
        }
      }
      // namespace 拍平：ns 条目与根条目落在同一个文件名（agents 是 override 语义，name 不含 ns 段）
      const nsWrites = adapter.planAgents!([{ ...agentFixture(), namespace: 'be' }], home, HOME_ENV);
      expect(nsWrites[0]?.path).toBe(w.path);
      expect(nsWrites[0]?.resource).toBe(w.resource);
    });

    it('ownsPath：管 skills 子树与 rules 子树，绝不管工具根本身或 block 文件', () => {
      expect(adapter.ownsPath(join(expectedRoot(home), spec.skillsSubdir, 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
      if (spec.rulesSubdir) {
        expect(adapter.ownsPath(join(expectedRoot(home), spec.rulesSubdir, 'x.md'), home, HOME_ENV)).toBe(true);
      }
      if (spec.rulesBlockFile) {
        expect(adapter.ownsPath(join(expectedRoot(home), spec.rulesBlockFile), home, HOME_ENV)).toBe(false);
      }
      // M7：agents 子树同样要纳管，否则卸载留孤儿；没有 agents 落点的工具不认领它
      if (spec.agentsSubdir) {
        expect(adapter.ownsPath(join(expectedRoot(home), spec.agentsSubdir, 'x.md'), home, HOME_ENV)).toBe(true);
      } else {
        expect(adapter.ownsPath(join(expectedRoot(home), 'agents', 'x.md'), home, HOME_ENV)).toBe(false);
      }
      // 根本身与别人的目录都不管
      expect(adapter.ownsPath(expectedRoot(home), home, HOME_ENV)).toBe(false);
      expect(adapter.ownsPath(join(home, '.some-other-tool', 'skills', 'a'), home, HOME_ENV)).toBe(false);
    });

    if (spec.hookFile && spec.hookEvent) {
      it('installHook：写入自己的条目、幂等，且不碰用户条目；uninstall 只摘自己', () => {
        mkdirSync(expectedRoot(home), { recursive: true });
        const settingsPath = join(expectedRoot(home), spec.hookFile as string);
        writeFileSync(
          settingsPath,
          JSON.stringify(
            {
              theme: 'dark',
              hooks: {
                [spec.hookEvent as string]: [
                  { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
                ],
              },
            },
            null,
            2,
          ),
          'utf8',
        );
        const cmd = `${HOOK_COMMAND_MARKER} node /opt/ejdrone-skills/dist/cli.js pull --silent`;
        expect(adapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });
        expect(adapter.installHook(home, HOME_ENV, cmd)).toEqual({ installed: true });

        const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
          theme: string;
          hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }>>;
        };
        expect(settings.theme).toBe('dark');
        const list = settings.hooks[spec.hookEvent as string] ?? [];
        const ours = list.filter((e) => (e.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)));
        const user = list.filter((e) => (e.hooks ?? []).some((h) => h.command === 'echo mine'));
        expect(ours).toHaveLength(1);
        expect(user).toHaveLength(1);

        adapter.uninstallHook(home, HOME_ENV);
        const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
          hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }>>;
        };
        const afterList = after.hooks[spec.hookEvent as string] ?? [];
        expect(afterList.some((e) => (e.hooks ?? []).some((h) => h.command.includes(HOOK_COMMAND_MARKER)))).toBe(false);
        expect(afterList.some((e) => (e.hooks ?? []).some((h) => h.command === 'echo mine'))).toBe(true);
      });
    } else {
      it('无用户级 hook 落点：installHook 返回 installed:false + 可读原因，不抛错', () => {
        let outcome = { installed: true, reason: '' };
        expect(() => {
          const r = adapter.installHook(home, HOME_ENV, 'ejdrone pull');
          outcome = { installed: r.installed, reason: r.reason ?? '' };
        }).not.toThrow();
        expect(outcome.installed).toBe(false);
        expect(outcome.reason.length).toBeGreaterThan(0);
        expect(() => adapter.uninstallHook(home, HOME_ENV)).not.toThrow();
      });
    }

    it('uninstallHook 对不存在的落点静默返回', () => {
      expect(() => adapter.uninstallHook(join(home, 'no-such-home'), HOME_ENV)).not.toThrow();
    });
  });
}
