import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAgentContextJson } from './file-context.js';
import { scanProject } from './context-scan.js';
import { assertContextEdits, expandAgentContext } from './agent-context.js';

let root: string;
const content = Array.from({ length: 600 }, (_, index) => `unique source line ${index + 1}`).join('\n');
const file = { path: 'README.md', language: 'markdown', content, truncated: false };
const context = () => formatAgentContextJson([file], 'summary', [], { prompt: '最后加一个1' });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-context-'));
  await fs.writeFile(path.join(root, 'README.md'), content);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.remove(root); });

describe('adaptive context', () => {
  it('excludes cache, generated files and secrets from the project overview', async () => {
    for (const name of ['.pnpm-store/v11/files/cache', '.cache/data', 'node_modules/a.js', 'build/a.js', 'dist/a.js', '.env', '.aws/credentials', '.ssh/config', 'private.key']) {
      await fs.outputFile(path.join(root, name), 'not context');
    }
    const project = await scanProject(root);
    expect(project.files).toEqual(['README.md']);
    expect(project.summary).not.toContain('.pnpm-store');
    expect(project.summary).not.toContain('private.key');
  });
  it('sends only the actual tail, preserving absolute line numbers and source identity', () => {
    const view = JSON.parse(context()).contextFiles[0];
    expect(view.partial).toBe(true); expect(view.totalLines).toBe(600);
    expect(view.includedRanges).toEqual([{ startLine: 551, endLine: 600 }]);
    expect(view.numberedContent).toMatch(/^\s*551\| unique source line 551/);
    expect(view.numberedContent).not.toContain('unique source line 100');
    expect(view.sourceHash).toHaveLength(64);
    expect(context().length).toBeLessThan(formatAgentContextJson([file]).length / 4);
  });
  it('preserves full context for whole-file tasks, ambiguous multi-file tasks and unknown tasks', () => {
    for (const prompt of ['重写整个 README，包括末尾', '审查最后一章与全文是否一致', '修复文档格式', 'update all headings, including the last']) {
      expect(JSON.parse(formatAgentContextJson([file], '', [], { prompt })).contextFiles[0].partial).toBe(false);
    }
    expect(JSON.parse(formatAgentContextJson([file, { ...file, path: 'other.md' }], '', [], { prompt: '最后加1' })).contextFiles.every((f: { partial: boolean }) => !f.partial)).toBe(true);
  });
  it('never presents a truncated prefix as the true file ending', () => {
    const view = JSON.parse(formatAgentContextJson([{ ...file, truncated: true }], '', [], { prompt: '最后加1' })).contextFiles[0];
    expect(view.truncated).toBe(true); expect(view.totalLines).toBeNull();
    expect(view.includedRanges[0].startLine).toBe(1);
    expect(view.sourceHash).toBeNull();
  });
  it('supports head-only tasks', () => {
    const view = JSON.parse(formatAgentContextJson([file], '', [], { prompt: '开头加一行标题' })).contextFiles[0];
    expect(view.includedRanges).toEqual([{ startLine: 1, endLine: 50 }]);
  });
  it('blocks full overwrite and unseen ranges, but permits a visible local patch', async () => {
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, content: 'only tail' }], context(), root)).rejects.toThrow('覆盖整个文件');
    await expect(assertContextEdits([{ action: 'CREATE_FILE', path: file.path, content: 'only tail' }], context(), root)).rejects.toThrow('覆盖整个文件');
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, startLine: 10, endLine: 10, replace: 'bad' }], context(), root)).rejects.toThrow('超出');
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, search: 'unique source line 100', replace: 'bad' }], context(), root)).rejects.toThrow('已读取');
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, startLine: 600, endLine: 600, replace: '1' }], context(), root)).resolves.toBeUndefined();
  });
  it('rejects stale snippets and incomplete prefix lines', async () => {
    await fs.writeFile(path.join(root, file.path), content + ' changed');
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, search: 'line 600', replace: '1' }], context(), root)).rejects.toThrow('发生变化');
    const prefix = formatAgentContextJson([{ ...file, content: 'unique source li', truncated: true }]);
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, startLine: 1, endLine: 1, replace: '1' }], prefix, root)).rejects.toThrow('未完整读取');
  });
  it('reads a requested range or full file without changing any project file', async () => {
    const range = await expandAgentContext(root, context(), [{ path: file.path, startLine: 20, endLine: 40 }]);
    expect(JSON.parse(range).contextFiles[0].includedRanges).toEqual([{ startLine: 20, endLine: 40 }]);
    const full = await expandAgentContext(root, range, [{ path: file.path }]);
    expect(JSON.parse(full).contextFiles[0].partial).toBe(false);
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: file.path, content: 'reviewed full rewrite' }], full, root)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(root, file.path), 'utf8')).toBe(content);
  });
  it('rejects private paths, traversal, binaries, folders and missing files', async () => {
    await fs.mkdir(path.join(root, 'folder')); await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 1]));
    for (const name of ['../outside', '.env', '.pnpm-store/a', '.aws/credentials', '.ssh/config', 'C:/secret', 'a.png', 'binary.txt', 'folder', 'missing.txt']) {
      await expect(expandAgentContext(root, context(), [{ path: name }])).rejects.toThrow();
    }
  });
  it('enforces the read budget and rejects symlinks encountered while resolving a request', async () => {
    await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(150000));
    await expect(expandAgentContext(root, context(), [{ path: 'large.txt' }])).rejects.toThrow('过长');
    vi.spyOn(fs, 'lstat').mockResolvedValueOnce({ isSymbolicLink: () => true } as Awaited<ReturnType<typeof fs.lstat>>);
    await expect(expandAgentContext(root, context(), [{ path: 'linked/code.ts' }])).rejects.toThrow('符号链接');
  });
});
