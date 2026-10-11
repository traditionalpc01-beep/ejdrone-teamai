import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectResources, completeFrontmatter } from '../../src/core/resources.js';
import type { RolesManifest } from '../../src/core/types.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function tmp(): string {
  root = mkdtempSync(join(tmpdir(), 'ejdrone-'));
  return root;
}

function file(base: string, rel: string, content = 'x'): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

function dir(base: string, rel: string): void {
  mkdirSync(join(base, rel), { recursive: true });
}

const manifestWith = (...namespaces: string[]): RolesManifest => ({
  version: 1,
  roles: [{ id: 'r1', namespaces }],
});

function skillNames(resources: { name: string; namespace: string }[]): string[] {
  return resources.map((r) => `${r.namespace || '<root>'}/${r.name}`);
}

describe('collectResources: skills', () => {
  it('collects a root skill (dir with SKILL.md)', () => {
    const base = tmp();
    file(base, 'skills/team-release/SKILL.md', '# Release\n');
    const res = collectResources(base, null);
    expect(skillNames(res.skills)).toEqual(['<root>/team-release']);
    expect(res.skills[0]?.namespace).toBe('');
    expect(res.skills[0]?.files['SKILL.md']).toBe('# Release\n');
    expect(res.warnings).toEqual([]);
  });

  it('collects a namespace skill and keeps files keyed relative to the skill dir', () => {
    const base = tmp();
    file(base, 'skills/fe/fe-code-review/SKILL.md', 'root body');
    file(base, 'skills/fe/fe-code-review/references/guide.md', 'guide');
    file(base, 'skills/fe/fe-code-review/scripts/run.sh', 'run');
    const res = collectResources(base, manifestWith('fe'));
    expect(skillNames(res.skills)).toEqual(['fe/fe-code-review']);
    const files = res.skills[0]?.files ?? {};
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.sh']);
    expect(files['references/guide.md']).toBe('guide');
  });

  it('skips a skill directory that has no SKILL.md, with a warning', () => {
    const base = tmp();
    file(base, 'skills/broken/README.md', 'nope');
    const res = collectResources(base, null);
    expect(res.skills).toEqual([]);
    expect(res.warnings.some((w) => w.includes('skills/broken') && /SKILL\.md/.test(w))).toBe(true);
  });

  it('skips a namespace subdirectory that has no SKILL.md, with a warning', () => {
    const base = tmp();
    file(base, 'skills/fe/real/SKILL.md', 'ok');
    file(base, 'skills/fe/notaskill/other.md', 'no');
    const res = collectResources(base, manifestWith('fe'));
    expect(skillNames(res.skills)).toEqual(['fe/real']);
    expect(res.warnings.some((w) => w.includes('skills/fe/notaskill'))).toBe(true);
  });

  it('does not support deep nesting and warns', () => {
    const base = tmp();
    file(base, 'skills/fe/real/SKILL.md', 'ok');
    file(base, 'skills/fe/deep/inner/SKILL.md', 'too deep');
    const res = collectResources(base, manifestWith('fe'));
    expect(skillNames(res.skills)).toEqual(['fe/real']);
    expect(res.warnings.some((w) => w.includes('skills/fe/deep'))).toBe(true);
  });

  it('skips symlinked skill directories', () => {
    const base = tmp();
    file(base, 'skills/multi/SKILL.md', 'real');
    symlinkSync(join(base, 'skills', 'multi'), join(base, 'skills', 'linkdir'), 'dir');
    const res = collectResources(base, null);
    expect(skillNames(res.skills)).toEqual(['<root>/multi']);
    expect(res.warnings.some((w) => w.includes('skills/linkdir') && /symlink/.test(w))).toBe(true);
  });
});

describe('collectResources: root-vs-namespace ambiguity (skills)', () => {
  it('treats a dir with SKILL.md as a ROOT entry even when it has skill subdirs', () => {
    const base = tmp();
    file(base, 'skills/pkg/SKILL.md', 'pkg root');
    file(base, 'skills/pkg/sub/SKILL.md', 'sub skill');
    const res = collectResources(base, null);
    // pkg is a root skill; its subdir SKILL.md becomes just a file of pkg, not a separate skill
    expect(skillNames(res.skills)).toEqual(['<root>/pkg']);
    expect(Object.keys(res.skills[0]?.files ?? {}).sort()).toEqual(['SKILL.md', 'sub/SKILL.md']);
  });

  it('treats the SAME dir as a namespace once declared in the manifest', () => {
    const base = tmp();
    file(base, 'skills/pkg/SKILL.md', 'pkg root');
    file(base, 'skills/pkg/sub/SKILL.md', 'sub skill');
    const res = collectResources(base, manifestWith('pkg'));
    // pkg is now a namespace: own SKILL.md ignored, subdir becomes the entry
    expect(skillNames(res.skills)).toEqual(['pkg/sub']);
  });
});

describe('collectResources: rules', () => {
  it('collects root and namespace rules', () => {
    const base = tmp();
    file(base, 'rules/code-style.md', '# style');
    file(base, 'rules/fe/react-conventions.md', '# react');
    const res = collectResources(base, manifestWith('fe'));
    expect(skillNames(res.rules)).toEqual(['<root>/code-style', 'fe/react-conventions']);
    expect(res.rules[0]?.files.content).toBe('# style');
    expect(res.rules[1]?.files.content).toBe('# react');
  });

  it('treats a directory containing .md files as a namespace, not an entry', () => {
    const base = tmp();
    file(base, 'rules/notes/a.md', 'a');
    const res = collectResources(base, null);
    expect(skillNames(res.rules)).toEqual(['notes/a']);
  });

  it('skips a rules directory with no .md files and no manifest declaration', () => {
    const base = tmp();
    file(base, 'rules/notes/readme.txt', 'txt');
    const res = collectResources(base, null);
    expect(res.rules).toEqual([]);
    expect(res.warnings.some((w) => w.includes('rules/notes'))).toBe(true);
  });

  it('a manifest-declared but empty namespace contributes nothing without a warning', () => {
    const base = tmp();
    dir(base, 'rules/qa');
    const res = collectResources(base, manifestWith('qa'));
    expect(res.rules).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('warns on nested directories under a rule namespace', () => {
    const base = tmp();
    file(base, 'rules/fe/sub/deep.md', 'x');
    const res = collectResources(base, manifestWith('fe'));
    expect(res.rules).toEqual([]);
    expect(res.warnings.some((w) => w.includes('rules/fe/sub'))).toBe(true);
  });
});

describe('completeFrontmatter', () => {
  it('fills a missing name and derives description from the first heading paragraph', () => {
    const res = completeFrontmatter('---\ndescription: existing\n---\n# Title\nFirst paragraph.\nSecond.', 'my-skill');
    expect(res.changed).toBe(true);
    expect(res.warning).toBeUndefined();
    expect(res.content).toContain('name: my-skill');
    expect(res.content).toContain('description: existing');
    expect(res.content).toContain('First paragraph.');
  });

  it('补全无 frontmatter 的文件时必须自带结束围栏（真机暴露的缺陷）', () => {
    const body = '# 摄影交付口径\n\n- 目录名固定\n- 口令 DEMO-TRIAL-1\n';
    const res = completeFrontmatter(body, 'shoot-convention');
    const fences = res.content.split('\n').filter((line) => line.trim() === '---');
    expect(fences).toHaveLength(2);
    expect(res.content.startsWith('---\n')).toBe(true);
    // 第二个围栏之后必须还是原正文，不能被吞进 YAML
    expect(res.content.split('---\n')[2]).toBe(body);
    // 补全结果要能被自己再解析出来（否则下游 block/mdc 会把 YAML 当正文投递）
    const again = completeFrontmatter(res.content, 'ignored');
    expect(again.changed).toBe(false);
  });

  it('补全已有 frontmatter 时不重复结束围栏', () => {
    const res = completeFrontmatter('---\ndescription: existing\n---\n# T\ntext\n', 's2');
    expect(res.content.split('\n').filter((line) => line.trim() === '---')).toHaveLength(2);
    expect(res.content).toContain('description: existing');
    expect(res.content.split('---\n')[2]).toBe('# T\ntext\n');
  });

  it('description 过长会被截断成单行，不把 YAML 折成多行', () => {
    const long = `# T\n${'- 一条很长的团队约定 '.repeat(20)}\n`;
    const res = completeFrontmatter(long, 'long-rule');
    const descLine = res.content.split('\n').find((line) => line.startsWith('description:')) ?? '';
    expect(descLine.length).toBeLessThan(200);
    expect(res.content.split('\n')[3]?.trim()).toBe('---');
  });

  it('leaves content untouched when both name and description are present', () => {
    const input = '---\nname: x\ndescription: y\n---\nbody\n';
    const res = completeFrontmatter(input, 'ignored');
    expect(res.changed).toBe(false);
    expect(res.content).toBe(input);
  });

  it('fills name when description is an empty value', () => {
    const res = completeFrontmatter('---\nname: foo\ndescription: ""\n---\n# T\nThe real description.', 'foo');
    expect(res.changed).toBe(true);
    expect(res.content).toContain('description: The real description.');
  });

  it('returns the original unchanged when the frontmatter YAML is corrupt', () => {
    const input = '---\nname: [unclosed\n---\nbody text';
    const res = completeFrontmatter(input, 's');
    expect(res.changed).toBe(false);
    expect(res.content).toBe(input);
    expect(res.warning).toBeDefined();
  });

  it('returns the original unchanged when the frontmatter root is not a mapping', () => {
    const input = '---\n- just\n- a list\n---\nbody';
    const res = completeFrontmatter(input, 's');
    expect(res.changed).toBe(false);
    expect(res.content).toBe(input);
    expect(res.warning).toBeDefined();
  });

  it('prepends a frontmatter block when there is none', () => {
    const res = completeFrontmatter('# My Heading\nSome description text.\n', 'my-skill');
    expect(res.changed).toBe(true);
    expect(res.content.startsWith('---\n')).toBe(true);
    expect(res.content).toContain('name: my-skill');
    expect(res.content).toContain('description: Some description text.');
    expect(res.content).toContain('# My Heading');
  });

  it('falls back to the name for description when there is no heading', () => {
    const res = completeFrontmatter('plain body with no heading', 'fb-name');
    expect(res.content).toContain('name: fb-name');
    expect(res.content).toContain('description: fb-name');
  });

  it('preserves other frontmatter keys and the full body', () => {
    const input = '---\ndescription: keep me\nalwaysApply: true\n---\nBODY line\nmore';
    const res = completeFrontmatter(input, 'nm');
    expect(res.content).toContain('name: nm');
    expect(res.content).toContain('description: keep me');
    expect(res.content).toContain('alwaysApply: true');
    expect(res.content).toContain('BODY line\nmore');
  });

  it('completes an empty frontmatter block', () => {
    const res = completeFrontmatter('---\n---\n# T\nDesc here.', 'empty-fm');
    expect(res.changed).toBe(true);
    expect(res.content).toContain('name: empty-fm');
    expect(res.content).toContain('description: Desc here.');
  });
});
