import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLOCK_RESOURCE_KEY } from '../../src/agents/block.js';
import { registry } from '../../src/agents/index.js';
import { TOOL_PATHS } from '../../src/agents/paths.js';
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

function specOf(id: string) {
  const spec = TOOL_PATHS[id];
  if (!spec) throw new Error(`describeAdapter: paths.ts 里没有 ${id}`);
  return spec;
}

function adapterOf(id: string): AgentAdapter {
  const adapter = registry().byId(id);
  if (!adapter) throw new Error(`describeAdapter: ${id} 在 paths.ts 有表项但未注册适配器`);
  return adapter;
}

/** 独立重算一遍期望路径（不复用 paths.ts 的 helper，否则测了个寂寞）。 */
function expectedRoot(id: string, home: string): string {
  return join(home, specOf(id).rootRel);
}

export function describeAdapter(id: string): void {
  describe(`adapter ${id}`, () => {
    const spec = specOf(id);
    const adapter = adapterOf(id);
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
      mkdirSync(expectedRoot(id, home), { recursive: true });
      expect(adapter.detect(home, HOME_ENV)).toBe(true);
    });

    it('planSkills：每个文件一条 write，落在 <root>/<skillsSubdir>/<name>/ 下', () => {
      const writes = adapter.planSkills([skillFixture()], home, HOME_ENV);
      const base = join(expectedRoot(id, home), spec.skillsSubdir, SKILL_NAME);
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
        expect(w.path).toBe(join(expectedRoot(id, home), spec.rulesBlockFile));
        expect(w.resource).toBe(BLOCK_RESOURCE_KEY);
        expect(w.region).toBeDefined();
        expect(w.content).toContain('# Code Style');
        return;
      }
      const ext = spec.rulesMode === 'mdc' ? 'mdc' : (spec.rulesExt ?? 'md');
      expect(w.path).toBe(join(expectedRoot(id, home), spec.rulesSubdir ?? '', `${RULE_NAME}.${ext}`));
      expect(w.resource).toBe(`rules:${RULE_NAME}`);
      expect(w.region).toBeUndefined();
    });

    it('ownsPath：管 skills 子树与 rules 子树，绝不管工具根本身或 block 文件', () => {
      expect(adapter.ownsPath(join(expectedRoot(id, home), spec.skillsSubdir, 'a', 'SKILL.md'), home, HOME_ENV)).toBe(true);
      if (spec.rulesSubdir) {
        expect(adapter.ownsPath(join(expectedRoot(id, home), spec.rulesSubdir, 'x.md'), home, HOME_ENV)).toBe(true);
      }
      if (spec.rulesBlockFile) {
        expect(adapter.ownsPath(join(expectedRoot(id, home), spec.rulesBlockFile), home, HOME_ENV)).toBe(false);
      }
      // 根本身与别人的目录都不管
      expect(adapter.ownsPath(expectedRoot(id, home), home, HOME_ENV)).toBe(false);
      expect(adapter.ownsPath(join(home, '.some-other-tool', 'skills', 'a'), home, HOME_ENV)).toBe(false);
    });

    if (spec.hookFile && spec.hookEvent) {
      it('installHook：写入自己的条目、幂等，且不碰用户条目；uninstall 只摘自己', () => {
        mkdirSync(expectedRoot(id, home), { recursive: true });
        const settingsPath = join(expectedRoot(id, home), spec.hookFile as string);
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
