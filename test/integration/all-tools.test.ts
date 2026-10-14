import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';

import { BLOCK_END, BLOCK_START } from '../../src/agents/block.js';
import { TOOL_PATHS } from '../../src/agents/paths.js';
import { parseHookWrapper } from '../../src/cli/constants.js';
import { ledgerPath } from '../../src/state.js';
import { loadLedger } from '../../src/core/ledger.js';
import { createHarness, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * M5 的全量矩阵端到端：16 个工具一次性 init + pull，逐工具核对落点、二次 pull 幂等，
 * 并且断言"账本里每个路径都落在 16 个工具根之内" —— 投递越界（写到 HOME 下别的地方）
 * 是这一层最贵的事故，单测按表推导测不出来。
 *
 * 每个工具的深度行为（block 停发不清空、mdc frontmatter、ownsPath 边界）由
 * test/agents/ 下的表驱动套件与各自特例测；这里只走一遍全链路，不乘 16 重复细测。
 */

const ALL_IDS = Object.keys(TOOL_PATHS);
// seedTeamRepo：根 root-note + be/be-deploy（含 scripts/run.sh）+ fe/fe-review；根 style.md + be/db.md + fe/react.md
const BE_SKILLS = ['root-note', 'be-deploy'];

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
});

afterEach(() => {
  h.cleanup();
});

function summary(text: string): { written: number; deleted: number; kept: number } {
  const m = /已投递 (\d+) 个文件到 \d+ 个工具；删除 (\d+)；保留 (\d+)/.exec(text);
  if (!m) throw new Error(`输出里没有投递摘要：\n${text}`);
  return { written: Number(m[1]), deleted: Number(m[2]), kept: Number(m[3]) };
}

async function memberWithAllTools(label: string): Promise<Member> {
  const member = h.member(label);
  installTools(member, ALL_IDS);
  const init = await member.run(['init', h.origin, '--agent', ALL_IDS.join(','), '--role', 'be']);
  expect(init.code, init.all).toBe(0);
  return member;
}

describe('16 工具全量投递', () => {
  it('每个工具都按表拿到自己的技能与规范，前端条目一个都不下发', async () => {
    const member = await memberWithAllTools('all-tools');

    for (const id of ALL_IDS) {
      const spec = TOOL_PATHS[id];
      const root = [spec.rootRel];
      for (const name of BE_SKILLS) {
        expect(
          member.exists(...root, spec.skillsSubdir, name, 'SKILL.md'),
          `${id}: 期望 ${spec.rootRel}/${spec.skillsSubdir}/${name}/SKILL.md 存在`,
        ).toBe(true);
      }
      // fe namespace 未激活：前端技能与规范一份都不能落到任何工具
      expect(member.exists(...root, spec.skillsSubdir, 'fe-review')).toBe(false);

      switch (spec.rulesMode) {
        case 'rulesdir':
          expect(member.read(...root, spec.rulesSubdir ?? 'rules', 'style.md')).toContain('统一风格');
          expect(member.read(...root, spec.rulesSubdir ?? 'rules', 'db.md')).toContain('改库');
          expect(member.exists(...root, spec.rulesSubdir ?? 'rules', 'react.md')).toBe(false);
          break;
        case 'mdc': {
          const text = member.read(...root, spec.rulesSubdir ?? 'rules', 'style.mdc');
          expect(text).toContain('alwaysApply: true');
          expect(text).toContain('统一风格');
          expect(member.exists(...root, spec.rulesSubdir ?? 'rules', 'react.mdc')).toBe(false);
          break;
        }
        case 'block': {
          const text = member.read(...root, spec.rulesBlockFile ?? 'AGENTS.md');
          expect(text).toContain(BLOCK_START);
          expect(text).toContain(BLOCK_END);
          expect(text).toContain('统一风格');
          expect(text).toContain('改库');
          expect(text).not.toContain('React rule');
          break;
        }
        case 'none':
          // 没有 markdown rules 载体的工具：宁可一份都不写，也不能造出它不读的目录
          expect(member.exists(...root, 'rules')).toBe(false);
          expect(member.exists(...root, 'AGENTS.md')).toBe(false);
          break;
      }

      if (spec.hookFile) {
        expect(member.exists(...root, spec.hookFile), `${id}: hook 应写在 ${spec.rootRel}/${spec.hookFile}`).toBe(true);
      } else {
        expect(member.exists(...root, 'settings.json', 'hooks')).toBe(false);
      }
    }
  });

  it('二次 pull 零写入零删除零保留，且账本里没有一个路径落在 16 个工具根之外', async () => {
    const member = await memberWithAllTools('all-tools-idempotent');
    const second = await member.run(['pull']);
    expect(second.code, second.all).toBe(0);
    expect(summary(second.all)).toEqual({ written: 0, deleted: 0, kept: 0 });

    const { ledger } = loadLedger(ledgerPath(member.env));
    expect(ledger.entries.length).toBeGreaterThan(0);
    // win32 下 entry.path 用反斜杠，硬拼 '/' 会让 startsWith 假阴性；按平台分隔符拼根前缀
    const roots = ALL_IDS.map((id) => member.path(TOOL_PATHS[id].rootRel));
    for (const entry of ledger.entries) {
      expect(roots.some((root) => entry.path.startsWith(root + sep)), `越界投递：${entry.path}`).toBe(true);
    }
  });

  it('16 个工具的 hook 条目各归各文件，互不认领', async () => {
    const member = await memberWithAllTools('all-hooks-isolated');
    const withHook = ALL_IDS.filter((id) => TOOL_PATHS[id].hookFile);
    expect(withHook.length).toBeGreaterThan(0);

    for (const id of withHook) {
      const spec = TOOL_PATHS[id];
      const raw = member.read(spec.rootRel, spec.hookFile ?? '') as string;
      const doc = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }>> };
      const ours = Object.values(doc.hooks ?? {})
        .flat()
        .filter((entry) => (entry.hooks ?? []).some((h) => h.command?.includes('EJDRONE_HOOK=1')));
      expect(ours, `${id}: 应恰好一条自己的 hook`).toHaveLength(1);
      // Windows 形态下工具配置里只剩 `<wrapper> EJDRONE_HOOK=1`，带单引号的 node/cli 形状在
      // wrapper 正文里（这是三 shell 通吃的代价，见 constants.ts 顶部实测矩阵）。
      // 断言"这条 hook 指向的就是这个成员的 cli 入口"，POSIX 读命令、win32 读 wrapper，语义同一件事。
      const command = ours[0]?.hooks?.[0]?.command ?? '';
      const wrapper = parseHookWrapper(command);
      const payload = wrapper === null ? command : readFileSync(wrapper.replace(/\//g, sep), 'utf8');
      expect(payload).toContain(`'${member.env.EJDRONE_CLI}' pull --silent`);
    }
  });
});
