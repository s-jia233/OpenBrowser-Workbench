import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fileToolRequestSchema, type FileToolRequest } from '../protocol/index.js';
import { formatAgentContextJson } from './file-context.js';
import { runFileTools } from './file-tools.js';
import { assertContextEdits } from './agent-context.js';

let root: string;
const login = 'export function login() {\n  throw new Error("LOGIN_FAILED");\n}\n';
const empty = () => formatAgentContextJson([], 'project');
const run = (requests: unknown[], context = empty()) => runFileTools(root, context, requests.map((request) => fileToolRequestSchema.parse(request)), 5);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-file-tools-'));
  await fs.outputFile(path.join(root, 'src/auth/login.ts'), login);
  await fs.outputFile(path.join(root, 'tests/login.test.ts'), 'test("login", () => {});\n');
  await fs.outputFile(path.join(root, 'README.md'), '# README\nLiteral pattern .* here\n中文登录失败\n');
  await fs.mkdir(path.join(root, 'empty'));
  for (const name of ['.env', '.npmrc', '.secrets/data.txt', '.aws/credentials', '.openbrowser/chat.json', '.pnpm-store/a.txt', 'node_modules/a.js', 'dist/a.js']) {
    await fs.outputFile(path.join(root, name), 'LOGIN_FAILED=secret-data');
  }
});
afterEach(async () => { vi.restoreAllMocks(); await fs.remove(root); });

describe('read-only project discovery tools', () => {
  it('lists root and nested files, including empty directories, without private or generated paths', async () => {
    const { results } = await run([{ tool: 'list_files', path: '.', depth: 3 }]);
    const result = results[0];
    expect(result.ok).toBe(true); expect(result.truncated).toBe(false);
    const entries = result.entries as { path: string; type: string }[];
    expect(entries).toContainEqual({ path: 'empty', type: 'directory' });
    expect(entries).toContainEqual({ path: 'src/auth/login.ts', type: 'file' });
    expect(JSON.stringify(entries)).not.toMatch(/secret|\.env|node_modules|pnpm-store|openbrowser|\.npmrc|dist\//);
    const shallow = await run([{ tool: 'list_files', path: 'src', depth: 1 }]);
    expect(shallow.results[0].entries).toEqual([{ path: 'src/auth', type: 'directory' }]);
  });
  it('finds error text with project-relative path and exact line number, without dumping file bodies', async () => {
    const { results, context } = await run([{ tool: 'search', query: 'LOGIN_FAILED' }]);
    expect(results[0].ok).toBe(true);
    expect(results[0].hits).toEqual([{ path: 'src/auth/login.ts', line: 2, column: 20, text: '  throw new Error("LOGIN_FAILED");', clipped: false }]);
    expect(JSON.parse(context).contextFiles).toEqual([]);
    expect(context).not.toContain('secret-data');
    expect(await fs.readFile(path.join(root, 'src/auth/login.ts'), 'utf8')).toBe(login);
  });
  it('supports literal queries, Chinese text, case choice and file/folder scoping', async () => {
    expect((await run([{ tool: 'search', query: '.*', path: 'README.md' }])).results[0].hits).toHaveLength(1);
    expect((await run([{ tool: 'search', query: '登录失败' }])).results[0].hits).toHaveLength(1);
    expect((await run([{ tool: 'search', query: 'login_failed', path: 'src' }])).results[0].hits).toHaveLength(1);
    expect((await run([{ tool: 'search', query: 'login_failed', caseSensitive: true }])).results[0].hits).toEqual([]);
    expect((await run([{ tool: 'search', query: 'login', path: 'tests' }])).results[0].hits).toHaveLength(1);
  });
  it('reports no matches without fabricating source', async () => {
    const result = (await run([{ tool: 'search', query: 'does-not-exist' }])).results[0];
    expect(result.hits).toEqual([]); expect(result.truncated).toBe(false);
    expect(result.scannedFiles).toBeGreaterThan(0);
  });
  it('reads exact requested lines, then permits only a patch within those lines', async () => {
    const { context, results } = await run([{ tool: 'read_file', path: 'src/auth/login.ts', startLine: 2, endLine: 2 }]);
    expect(results[0].partial).toBe(true);
    const data = JSON.parse(context);
    expect(data.contextFiles[0].numberedContent).toBe('   2|   throw new Error("LOGIN_FAILED");');
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: 'src/auth/login.ts', startLine: 2, endLine: 2, replace: '  return true;' }], context, root)).resolves.toBeUndefined();
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: 'src/auth/login.ts', content: 'guess' }], context, root)).rejects.toThrow('覆盖整个文件');
  });
  it('does not let search hints authorize edits, including after failed tool reads', async () => {
    const { context } = await run([{ tool: 'search', query: 'login' }, { tool: 'read_file', path: 'missing.ts' }]);
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: 'src/auth/login.ts', content: 'guess' }], context, root)).rejects.toThrow('read_file');
  });
  it('rejects changes based on stale full-file reads', async () => {
    const { context } = await run([{ tool: 'read_file', path: 'src/auth/login.ts' }]);
    await fs.writeFile(path.join(root, 'src/auth/login.ts'), 'external edit');
    await expect(assertContextEdits([{ action: 'EDIT_FILE', path: 'src/auth/login.ts', content: 'guess' }], context, root)).rejects.toThrow('发生变化');
  });
  it('caps matches, listing entries and result history without cutting JSON records', async () => {
    await fs.outputFile(path.join(root, 'many.txt'), Array.from({ length: 100 }, () => 'repeated token').join('\n'));
    const result = await run([{ tool: 'search', query: 'repeated token', path: 'many.txt' }]);
    expect(result.results[0].hits).toHaveLength(30); expect(result.results[0].truncated).toBe(true);
    await Promise.all(Array.from({ length: 100 }, (_, index) => fs.outputFile(path.join(root, `many/${index}.txt`), 'data')));
    const listed = await run([{ tool: 'list_files', path: 'many' }]);
    expect(listed.results[0].entries).toHaveLength(80); expect(listed.results[0].truncated).toBe(true);
    let context = empty();
    for (let index = 0; index < 10; index++) context = (await run([{ tool: 'list_files', path: 'many' }], context)).context;
    expect(JSON.parse(context).toolResults.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(JSON.parse(context).toolResults).length).toBeLessThanOrEqual(20000);
  });
  it('reports skipped oversized or binary source instead of claiming complete coverage', async () => {
    await fs.outputFile(path.join(root, 'large.txt'), 'x'.repeat(1000001));
    await fs.outputFile(path.join(root, 'binary.txt'), Buffer.from([0, 1, 2]));
    const result = (await run([{ tool: 'search', query: 'x', path: 'large.txt' }])).results[0];
    expect(result.truncated).toBe(true); expect(result.skippedFiles).toBe(1);
    expect((await run([{ tool: 'search', query: 'data', path: 'binary.txt' }])).results[0].hits).toEqual([]);
  });
  it('returns bounded errors for invalid, private and outside-project paths', async () => {
    for (const name of ['../outside', '.env', '.aws/credentials', '.npmrc', 'node_modules', '.openbrowser', '.secrets', 'CON', 'NUL.txt', 'missing']) {
      const requests = ['list_files', 'search', 'read_file'].map((tool) => ({ tool, path: name, ...(tool === 'search' ? { query: 'secret' } : {}), ...(tool === 'list_files' ? { depth: 1 } : {}) })) as FileToolRequest[];
      const { results, context } = await runFileTools(root, empty(), requests, 5);
      expect(results.every((result) => !result.ok)).toBe(true);
      expect(context).not.toContain('secret-data');
    }
  });
  it('honors a host authorization denial without disclosing content', async () => {
    const result = await runFileTools(root, empty(), [fileToolRequestSchema.parse({ tool: 'read_file', path: 'README.md' })], 5, async () => { throw new Error('policy denied'); });
    expect(result.results[0].ok).toBe(false); expect(result.context).not.toContain('Literal pattern');
  });
  it('rejects symlinks before reading source and stops an exhausted scan budget', async () => {
    vi.spyOn(fs, 'lstat').mockResolvedValueOnce({ isSymbolicLink: () => true } as Awaited<ReturnType<typeof fs.lstat>>);
    const link = await run([{ tool: 'read_file', path: 'linked.ts' }]);
    expect(link.results[0].ok).toBe(false); expect(link.results[0].error).toContain('符号链接');
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 5000));
    const read = vi.spyOn(fs, 'readFile');
    const timed = await run([{ tool: 'search', query: 'login' }]);
    expect(timed.results[0].ok).toBe(false); expect(timed.results[0].error).toContain('预算');
    expect(read).not.toHaveBeenCalled();
  });
});
