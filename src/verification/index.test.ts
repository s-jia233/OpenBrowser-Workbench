import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runVerificationInSandbox, selectScripts, VerificationSetupError } from './index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});

describe('selectScripts', () => {
  it('refuses missing selected scripts instead of silently skipping them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-missing-script-')); tempRoots.push(root);
    await expect(runVerificationInSandbox(root, { scripts: ['test'] })).rejects.toBeInstanceOf(VerificationSetupError);
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'node -e "process.exit(0)"' } });
    await expect(runVerificationInSandbox(root, { scripts: ['test', 'lint'] })).rejects.toThrow('lint');
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 123 } });
    await expect(runVerificationInSandbox(root, { scripts: ['test'] })).rejects.toThrow('缺失或不可用');
    await fs.writeJson(path.join(root, 'package.json'), null);
    await expect(runVerificationInSandbox(root, { scripts: ['test'] })).rejects.toThrow('配置格式不正确');
  });
  it('reports successful scripts individually and never marks a later failed script as passed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-script-results-')); tempRoots.push(root);
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(1)"' } });
    const passed: string[] = [];
    await expect(runVerificationInSandbox(root, { scripts: ['test', 'lint'], onScriptPassed: (script) => passed.push(script) })).rejects.toThrow('failed');
    expect(passed).toEqual(['test']);
  });
  it('copies dependencies when links are denied, runs the script, and preserves the original dependency', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-copy-deps-test-'));
    tempRoots.push(root);
    await fs.outputFile(path.join(root, 'node_modules', 'test-dependency', 'index.js'), 'module.exports = 42;');
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'node -e "const fs=require(\'node:fs\');if(require(\'test-dependency\')!==42)process.exit(1);fs.writeFileSync(require.resolve(\'test-dependency\'),\'changed only in sandbox\')"' } });
    vi.spyOn(fs, 'symlink').mockRejectedValue(Object.assign(new Error('Link not permitted'), { code: 'EPERM' }));
    const logs: string[] = [];
    const result = await runVerificationInSandbox(root, { scripts: ['test'], onLog: (message) => logs.push(message) });
    expect(result.summary).toContain('passed');
    expect(logs.join('\n')).toContain('改用依赖副本');
    expect(await fs.readFile(path.join(root, 'node_modules', 'test-dependency', 'index.js'), 'utf8')).toBe('module.exports = 42;');
  });
  it('uses a deterministic safe default order', () => {
    expect(
      selectScripts({ build: 'tsc', test: 'vitest', typecheck: 'tsc --noEmit' }),
    ).toEqual(['typecheck', 'test', 'build']);
  });

  it('honors an explicit allowlist and removes duplicates', () => {
    expect(selectScripts({ test: 'vitest', deploy: 'ship' }, ['test', 'deploy', 'test']))
      .toEqual(['test', 'deploy']);
  });

  it('runs scripts in a temporary copy without writing into the project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-verification-test-'));
    tempRoots.push(root);
    await fs.writeJson(path.join(root, 'package.json'), {
      scripts: {
        test: 'node -e "require(\'node:fs\').writeFileSync(\'generated.txt\', \'ok\')"',
      },
    });

    const result = await runVerificationInSandbox(root, { scripts: ['test'] });

    expect(result.summary).toContain('passed');
    await expect(fs.pathExists(path.join(root, 'generated.txt'))).resolves.toBe(false);
  });
});
