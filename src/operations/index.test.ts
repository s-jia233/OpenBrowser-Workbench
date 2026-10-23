import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileOperation } from '../core/index.js';
import { executeOperations, FileTransactionError } from './index.js';
import * as memory from '../memory/index.js';

const tempRoots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-operations-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});

describe('executeOperations transaction', () => {
  it('keeps rollback facts even if saving operation history also fails', async () => {
    const root = await tempProject(); await fs.writeFile(path.join(root, 'code.txt'), 'original');
    vi.spyOn(memory, 'appendHistory').mockRejectedValue(new Error('audit storage unavailable'));
    const failure = await executeOperations([{ action: 'EDIT_FILE', path: 'code.txt', content: 'changed' }], root).catch((error) => error);
    expect(failure).toBeInstanceOf(FileTransactionError); expect(failure.rolledBack).toBe(true);
    expect(failure.historyError).toContain('audit storage'); expect(await fs.readFile(path.join(root, 'code.txt'), 'utf8')).toBe('original');
  });
  it('preserves literal escape sequences in line, search and full-file edits', async () => {
    const root = await tempProject();
    const before = 'const newline = "\\n";\nconst tab = "\\t";\n';
    await fs.writeFile(path.join(root, 'code.ts'), before);
    await executeOperations([{ action: 'EDIT_FILE', path: 'code.ts', search: '"\\n"', replace: '"\\r\\n"' }], root);
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe(before.replace('"\\n"', '"\\r\\n"'));
    await executeOperations([{ action: 'EDIT_FILE', path: 'code.ts', content: before }], root);
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe(before);
    await executeOperations([{ action: 'EDIT_FILE', path: 'code.ts', startLine: 1, endLine: 1, replace: 'const quote = "\\\\";' }], root);
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('const quote = "\\\\";\nconst tab = "\\t";\n');
  });
  it('rejects ambiguous search text rather than modifying an arbitrary match', async () => {
    const root = await tempProject();
    await fs.writeFile(path.join(root, 'text.txt'), 'same same');
    await expect(executeOperations([{ action: 'EDIT_FILE', path: 'text.txt', search: 'same', replace: 'changed' }], root)).rejects.toThrow('unique');
    expect(await fs.readFile(path.join(root, 'text.txt'), 'utf8')).toBe('same same');
  });
  it('rolls back earlier writes and newly-created parent directories', async () => {
    const root = await tempProject();
    await fs.writeFile(path.join(root, 'existing.txt'), 'before');
    const operations: FileOperation[] = [
      { action: 'EDIT_FILE', path: 'existing.txt', content: 'after' },
      { action: 'CREATE_FILE', path: 'nested/new.txt', content: 'new' },
    ];
    let steps = 0;

    await expect(
      executeOperations(operations, root, {
        onStep: () => {
          steps += 1;
          if (steps === 2) {
            throw new Error('simulated failure');
          }
        },
      }),
    ).rejects.toThrow('all file changes were rolled back');

    await expect(fs.readFile(path.join(root, 'existing.txt'), 'utf8')).resolves.toBe('before');
    await expect(fs.pathExists(path.join(root, 'nested'))).resolves.toBe(false);
  });

  it('denies model-proposed commands by default', async () => {
    const root = await tempProject();
    const operations: FileOperation[] = [
      { action: 'RUN_COMMAND', command: 'echo unsafe' },
    ];

    await expect(executeOperations(operations, root)).rejects.toThrow(
      'RUN_COMMAND is disabled',
    );
  });

  it('refuses to overwrite an existing file with CREATE_FILE', async () => {
    const root = await tempProject();
    await fs.writeFile(path.join(root, 'keep.txt'), 'original');

    await expect(
      executeOperations(
        [{ action: 'CREATE_FILE', path: 'keep.txt', content: 'replacement' }],
        root,
      ),
    ).rejects.toThrow('CREATE_FILE refuses to overwrite');

    await expect(fs.readFile(path.join(root, 'keep.txt'), 'utf8')).resolves.toBe('original');
  });
});
