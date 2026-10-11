import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hermesAdapter } from '../../src/agents/hermes.js';
import type { Resource } from '../../src/core/types.js';
import { describeAdapter } from './suite.js';

// 公共六项表驱动断言。
describeAdapter(hermesAdapter);

const HOME_ENV: NodeJS.ProcessEnv = {}; // 显式空 env：绝不读真实 process.env.HOME

const ruleFixture: Resource = {
  kind: 'rules',
  namespace: '',
  name: 'code-style',
  files: { content: '---\ndescription: Style guide\npaths:\n  - "src/**"\n---\n\n# Code Style\nBody.\n' },
};

/**
 * 特例：rulesMode 'none' 且表里没给 hookFile。
 * 回归保护：真机上 ~/.hermes/hooks 是一个**目录**（不是我们的 {hooks:{…}} JSON 文件）。
 * 谁要是误给 hermes 配上 hookFile='.hermes/hooks' 之类的形状，upsertHook 会撞上同名目录；
 * 而按当前表（无 hookFile），installHook 必须在目录存在时依旧 installed:false、不抛错、
 * 绝不往那个目录里写东西。
 */
describe('hermes 特例：rules none、无 hook，且 ~/.hermes/hooks 是目录时不受扰动', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ejdrone-hermes-none-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('rulesMode none：planRules 返回空数组', () => {
    expect(hermesAdapter.planRules([ruleFixture], home, HOME_ENV)).toEqual([]);
    expect(hermesAdapter.planRules([], home, HOME_ENV)).toEqual([]);
  });

  it('无 hookFile：installHook 返回 installed:false，不抛错', () => {
    mkdirSync(join(home, '.hermes'), { recursive: true });
    let outcome = { installed: true };
    expect(() => {
      outcome = hermesAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    }).not.toThrow();
    expect(outcome.installed).toBe(false);
    expect(() => hermesAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
  });

  it('回归：~/.hermes/hooks 为同名目录时，installHook 仍 installed:false，目录与其内容原样不动', () => {
    const hooksDir = join(home, '.hermes', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const sentinel = join(hooksDir, 'user-owned.txt');
    writeFileSync(sentinel, 'not ours, do not touch\n', 'utf8');

    let outcome = { installed: true };
    expect(() => {
      outcome = hermesAdapter.installHook(home, HOME_ENV, 'ejdrone pull --silent');
    }).not.toThrow();
    expect(outcome.installed).toBe(false);

    // 目录仍是目录，没被替换成 JSON 文件，里面也没有我们的任何痕迹
    expect(statSync(hooksDir).isDirectory()).toBe(true);
    expect(existsSync(join(hooksDir, 'settings.json'))).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('not ours, do not touch\n');

    expect(() => hermesAdapter.uninstallHook(home, HOME_ENV)).not.toThrow();
    expect(statSync(hooksDir).isDirectory()).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toBe('not ours, do not touch\n');
  });
});
