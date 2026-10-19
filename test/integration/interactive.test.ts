import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, installTools, seedTeamRepo, type Harness, type Member } from './helpers.js';

/**
 * 交互路径：把 ctx.choose / ctx.confirm 注进来（不碰 stdin），
 * 验证 init 选工具选角色、push 勾选候选、uninstall 二次确认。
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
  seedTeamRepo(h);
});

afterEach(() => {
  h.cleanup();
});

async function initInteractive(member: Member, picks: { agent: string[]; role: string[] }): Promise<{ code: number; all: string }> {
  installTools(member, ['claude', 'codex']);
  let call = 0;
  const result = await member.run(['init', h.origin], {
    interactive: true,
    choose: async (_question, items, preset) => {
      const chosen = (call += 1) === 1 ? picks.agent : picks.role;
      return items.filter((item) => chosen.includes(item.value)).map((item) => item.value);
    },
    prompt: async () => '',
    confirm: async () => false,
  });
  return { code: result.code, all: result.all };
}

describe('交互式 init', () => {
  it('勾选 claude、选 fe 角色 → 只下发 fe 与根条目', async () => {
    const member = h.member('interactive-init');
    const result = await initInteractive(member, { agent: ['claude'], role: ['fe'] });
    expect(result.code, result.all).toBe(0);
    expect(result.all).toContain('工具=claude');
    expect(result.all).toContain('角色=fe');
    expect(member.exists('.claude', 'skills', 'fe-review', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'skills', 'be-deploy')).toBe(false);
    expect(member.exists('.claude', 'settings.json')).toBe(true);
    expect(member.exists('.codex', 'hooks.json')).toBe(false);
  });

  it('选"不设角色"时只下发根条目', async () => {
    const member = h.member('interactive-norole');
    const result = await initInteractive(member, { agent: ['claude'], role: [] });
    expect(result.code, result.all).toBe(0);
    expect(member.exists('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'rules', 'db.md')).toBe(false);
  });

  it('角色问答把管理员写的描述亮出来（非开发者不认识 fe/be 这类内部 id）', async () => {
    const member = h.member('interactive-role-labels');
    installTools(member, ['claude']);
    let roleLabels: string[] = [];
    let call = 0;
    const result = await member.run(['init', h.origin], {
      interactive: true,
      choose: async (_question, items) => {
        call += 1;
        if (call === 2) {
          roleLabels = items.map((item) => item.label);
          return []; // 选「跳过」
        }
        return items.filter((item) => item.value === 'claude').map((item) => item.value);
      },
      prompt: async () => '',
      confirm: async () => false,
    });

    expect(result.code, result.all).toBe(0);
    expect(roleLabels).toContain('角色 be（后端）');
    expect(roleLabels).toContain('角色 fe（前端）');
    // 跳过项说人话，并指路事后修改
    expect(roleLabels.some((l) => l.includes('不确定') && l.includes('roles set'))).toBe(true);
    expect(result.all).toContain('roles set');
  });
});

describe('交互式 push 与 uninstall', () => {
  it('不带选择器时列出本地候选供勾选，只推被选中的', async () => {
    const member = h.member('interactive-push');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    member.write('.claude/skills/picked-one/SKILL.md', '# Picked one\n\n选中了。\n');
    member.write('.claude/skills/picked-two/SKILL.md', '# Picked two\n\n没选中。\n');

    let listed: string[] = [];
    const pushed = await member.run(['push'], {
      interactive: true,
      choose: async (_question, items) => {
        listed = items.map((item) => item.value);
        return items.filter((item) => item.value === 'skills:picked-one').map((item) => item.value);
      },
      prompt: async () => '',
      confirm: async () => false,
    });
    expect(pushed.code, pushed.all).toBe(0);
    expect(listed.sort()).toEqual(['skills:picked-one', 'skills:picked-two']);

    const branch = h.remoteBranches().find((b) => b.includes('picked-one'));
    expect(branch, `远端分支：${h.remoteBranches().join(', ')}`).toBeTruthy();
    expect(h.remoteBranches().some((b) => b.includes('picked-two'))).toBe(false);
    h.mergeIntoMain(branch as string);
    expect(h.seedRead('skills/be/picked-one/SKILL.md')).toContain('name: picked-one');
  });

  it('uninstall 二次确认被拒时什么都不动', async () => {
    const member = h.member('interactive-uninstall');
    installTools(member, ['claude']);
    const init = await member.run(['init', h.origin, '--agent', 'claude', '--role', 'be']);
    expect(init.code, init.all).toBe(0);

    const cancelled = await member.run(['uninstall'], {
      interactive: true,
      confirm: async () => false,
      choose: async (_q, items) => items.map((item) => item.value),
      prompt: async () => '',
    });
    expect(cancelled.code, cancelled.all).toBe(0);
    expect(cancelled.all).toContain('已取消');
    expect(member.exists('.claude', 'skills', 'root-note', 'SKILL.md')).toBe(true);
    expect(member.exists('.claude', 'settings.json')).toBe(true);
  });
});
