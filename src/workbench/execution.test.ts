import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchService, taskInput } from './service.js';
import { WorkbenchSessionStore } from './session-store.js';
import * as verification from '../verification/index.js';

let root: string;
const services: WorkbenchService[] = [];
const create = () => { const service = new WorkbenchService(root); services.push(service); return service; };
async function reviewed(scripts: ('test' | 'lint')[] = []) {
  const service = create();
  const task = await service.create(taskInput.parse({ prompt: 'Update code', mode: 'agent', delivery: 'manual', contextPaths: ['code.ts'], scripts }));
  await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'code.ts', content: 'updated\n' }] }));
  expect(task.status).toBe('review'); return { service, task };
}
async function settled(service: WorkbenchService, id: string) {
  const locks = (service as unknown as { locks: Set<string> }).locks;
  for (let n = 0; n < 100; n++) { if (service.get(id).status !== 'applying' && !locks.size) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw Error('Application did not settle');
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-execution-')); await fs.writeFile(path.join(root, 'code.ts'), 'original\n'); });
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) await service.close(); await fs.remove(root); });

describe('persistent observed execution facts', () => {
  it('records skipped verification separately from a successful file application, including after follow-up', async () => {
    const { service, task } = await reviewed(); await service.apply(task.id); await settled(service, task.id);
    expect(task.executionRuns?.[0]).toMatchObject({ changes: 'applied', verification: 'skipped', passed: [] });
    await service.followUp(task.id, taskInput.parse({ prompt: 'Explain change', mode: 'ask', delivery: 'manual' }));
    expect(task.executionRuns).toEqual([]); expect(task.turns[0].executionRuns?.[0].verification).toBe('skipped');
    await service.flush(); const saved = (await new WorkbenchSessionStore(root).load())[0];
    expect(saved.turns[0].executionRuns[0].changes).toBe('applied');
  });
  it('records only actually passed script names and persists the result across restart', async () => {
    vi.spyOn(verification, 'runVerificationInSandbox').mockImplementation(async (_root, options) => {
      options?.onScriptPassed?.('test'); return { scripts: ['test'], summary: 'passed selected test' };
    });
    const { service, task } = await reviewed(['test']); await service.apply(task.id); await settled(service, task.id); await service.close();
    const next = create(); await next.initialize();
    expect(next.get(task.id).executionRuns?.[0]).toMatchObject({ changes: 'applied', verification: 'passed', requested: ['test'], passed: ['test'] });
  });
  it('rolls back a missing selected script and pauses without calling it passed or retrying the model', async () => {
    await fs.writeJson(path.join(root, 'package.json'), { scripts: {} });
    const { service, task } = await reviewed(['test']); await service.apply(task.id); await settled(service, task.id);
    expect(task.status).toBe('failed'); expect(task.attempt).toBe(1);
    expect(task.executionRuns?.[0]).toMatchObject({ changes: 'rolled_back', verification: 'setup_failed', passed: [] });
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('original\n');
  });
  it('keeps earlier successful scripts when a later script fails and ignores fake rollback text', async () => {
    vi.spyOn(verification, 'runVerificationInSandbox').mockImplementation(async (_root, options) => {
      options?.onScriptPassed?.('test'); throw Error('script output: rollback also failed (untrusted text)');
    });
    const { service, task } = await reviewed(['test', 'lint']); await service.apply(task.id); await settled(service, task.id);
    expect(task.status).toBe('awaiting_response'); expect(task.attempt).toBe(2);
    expect(task.executionRuns?.[0]).toMatchObject({ attempt: 1, changes: 'rolled_back', verification: 'failed', passed: ['test'] });
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('original\n');
  });
  it('reports a real rollback failure as unresolved and never automatically retries it', async () => {
    vi.spyOn(verification, 'runVerificationInSandbox').mockRejectedValue(Error('test failed'));
    const { service, task } = await reviewed(['test']);
    const write = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(((file: string, data: string | Buffer, options?: never) => {
      if (file === path.join(root, 'code.ts') && Buffer.isBuffer(data)) return Promise.reject(Error('restore denied'));
      return write(file, data, options);
    }) as typeof fs.writeFile);
    await service.apply(task.id); await settled(service, task.id);
    expect(task.status).toBe('failed'); expect(task.attempt).toBe(1);
    expect(task.executionRuns?.[0].changes).toBe('rollback_failed');
  });
  it('releases the project lock and keeps the original review if saving approval fails before any writes', async () => {
    const { service, task } = await reviewed();
    const spy = vi.spyOn(service, 'flush').mockRejectedValueOnce(Error('disk denied'));
    await expect(service.apply(task.id)).rejects.toThrow('disk denied'); spy.mockRestore();
    expect(task.status).toBe('review'); expect(task.executionRuns).toEqual([]);
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('original\n');
    await service.apply(task.id); await settled(service, task.id); expect(task.status).toBe('complete');
    expect(task.executionRuns).toHaveLength(1);
  });
  it('does not convert interrupted applications into success or restored files on restart', async () => {
    const { service, task } = await reviewed(); task.status = 'applying';
    task.executionRuns = [{ attempt: 1, startedAt: new Date().toISOString(), changes: 'in_progress', verification: 'running', requested: ['test'], passed: [] }];
    await service.close(); const next = create(); await next.initialize();
    expect(next.get(task.id).status).toBe('failed');
    expect(next.get(task.id).executionRuns?.[0]).toMatchObject({ changes: 'unknown', verification: 'unknown' });
  });
});
