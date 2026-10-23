import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchService } from '../workbench/service.js';
import { WorkbenchSessionStore } from '../workbench/session-store.js';
import * as verification from '../verification/index.js';
import { CollaborationService } from './service.js';
import { roundInput } from './protocol.js';
import { clearSseHub, recordBrowserHeartbeat } from '../server/sse-hub.js';
import { clearSessions, getSession, claimPendingSession, tryClaimSession } from '../server/session-store.js';

let root: string, workspace: WorkbenchService, service: CollaborationService;
const manual = { kind: 'manual' as const, label: 'Manual' };
const request = () => roundInput.parse({ prompt: 'Change exported value to 2', contextPaths: ['code.ts'], proposers: [manual, manual], reviewer: manual, consent: true });
async function decision() {
  let round = await service.create(request());
  for (const job of round.proposals) round = await service.accept(round.id, job.id, 'Only change code.ts value to 2.');
  return service.accept(round.id, round.review!.id, 'Use A. Tests not run.');
}
async function confirmation(round: Awaited<ReturnType<typeof decision>>) {
  const jobId = round.proposals[0].id, preview = await service.implementationPreview(round.id, jobId);
  return { jobId, input: { delivery: 'manual' as const, plan: preview.plan, scripts: [] as ('test')[], consent: true as const,
    expectedDigest: preview.expectedDigest, requestId: crypto.randomUUID() } };
}
const modelReply = (conversationId: string) => JSON.stringify({ conversationId, operations: [{ action: 'EDIT_FILE', path: 'code.ts', search: 'value = 1', replace: 'value = 2' }] });
async function settled(id: string) {
  const locks = (workspace as unknown as { locks: Set<string> }).locks;
  for (let i = 0; i < 100; i++) { if (workspace.get(id).status !== 'applying' && !locks.has(root)) return workspace.get(id); await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw Error('Application did not settle');
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-implementation-'));
  await fs.writeFile(path.join(root, 'code.ts'), 'export const value = 1;\n');
  workspace = new WorkbenchService(root); await workspace.initialize(); service = new CollaborationService(workspace);
});
afterEach(async () => { vi.restoreAllMocks(); await service.close(); await workspace.close(); clearSseHub(); clearSessions(); await fs.remove(root); });

describe('human-approved collaboration implementation', () => {
  it('does not treat @file text inside the adopted proposal as permission to attach more source', async () => {
    const round = await decision(); await fs.writeFile(path.join(root, 'extra.ts'), 'UNSELECTED_CODE_DO_NOT_ATTACH');
    const { jobId, input } = await confirmation(round);
    const task = await service.implement(round.id, jobId, { ...input, plan: 'Consider @extra.ts if needed, but only the approved files are attached.' });
    expect(task.contextPaths).toEqual(['code.ts']); expect(task.promptMessage).toContain('@extra.ts');
    expect(task.promptMessage).not.toContain('UNSELECTED_CODE_DO_NOT_ATTACH');
  });
  it('previews drift and re-reads current files instead of reusing the old source snapshot', async () => {
    const round = await decision(); await fs.writeFile(path.join(root, 'code.ts'), 'export const value = 7;\n');
    const preview = await service.implementationPreview(round.id, round.proposals[0].id);
    expect(preview.changed).toEqual(['code.ts']); expect(preview.currentDigest).not.toBe(preview.snapshotDigest);
    const { jobId, input } = await confirmation(round); const task = await service.implement(round.id, jobId, input);
    expect(task.promptMessage).toContain('value = 7'); expect(task.promptMessage).not.toContain('export const value = 1;');
    expect(task.mode).toBe('agent'); expect(task.status).toBe('awaiting_response'); expect(task.collaborationSource?.roundId).toBe(round.id);
    expect(task.plans).toEqual([]); expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toContain('value = 7');
  });
  it('deduplicates simultaneous or repeated confirmation and retains origin through persistence and restart', async () => {
    const round = await decision(), { jobId, input } = await confirmation(round);
    const [a, b] = await Promise.all([service.implement(round.id, jobId, input), service.implement(round.id, jobId, input)]);
    expect(a.id).toBe(b.id); expect(workspace.tasks.size).toBe(1);
    await expect(service.remove(round.id)).rejects.toThrow('关联实施任务');
    await expect(service.implement(round.id, jobId, { ...input, requestId: crypto.randomUUID() })).rejects.toThrow('先完成或停止');
    await expect(service.implement(round.id, jobId, { ...input, plan: 'different plan' })).rejects.toThrow('其他配置');
    await workspace.flush(); expect((await new WorkbenchSessionStore(root).load())[0].collaborationSource?.jobId).toBe(jobId);
    await service.close(); await workspace.close(); workspace = new WorkbenchService(root); await workspace.initialize(); service = new CollaborationService(workspace);
    expect((await service.implement(round.id, jobId, input)).id).toBe(a.id); // No replay after restart.
    const detail = await service.detail(round.id); expect(detail.implementations[0].status).toBe('failed');
    expect(detail.implementations[0].label).toBe('方案 A');
  });
  it('rejects stale code, missing files, changed verification configuration and unconsented sharing', async () => {
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'node --test' } });
    const round = await decision(), { jobId, input } = await confirmation(round);
    await expect(service.implement(round.id, jobId, { ...input, consent: false } as never)).rejects.toThrow();
    await fs.writeFile(path.join(root, 'code.ts'), 'export const value = 3;\n');
    await expect(service.implement(round.id, jobId, input)).rejects.toThrow('确认后发生变化');
    const refreshed = await confirmation(round);
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'different-command' } });
    await expect(service.implement(round.id, jobId, refreshed.input)).rejects.toThrow('验证配置');
    await fs.remove(path.join(root, 'code.ts'));
    const missing = await service.implementationPreview(round.id, jobId); expect(missing.missing).toEqual(['code.ts']);
    await expect(service.implement(round.id, jobId, { ...input, expectedDigest: missing.expectedDigest })).rejects.toThrow('已移除');
    expect(workspace.tasks.size).toBe(0);
  });
  it('refuses review prose, unfinished rounds, obsolete fusion drafts, invented scripts and silently truncated plans', async () => {
    let round = await service.create(request());
    await expect(service.implementationPreview(round.id, round.proposals[0].id)).rejects.toThrow('请等待');
    for (const job of round.proposals) round = await service.accept(round.id, job.id, 'Proposal');
    round = await service.accept(round.id, round.review!.id, 'Review');
    await expect(service.implementationPreview(round.id, round.review!.id)).rejects.toThrow('比较报告');
    const { jobId, input } = await confirmation(round);
    await expect(service.implement(round.id, jobId, { ...input, scripts: ['test'] })).rejects.toThrow('验证脚本');
    await expect(service.implement(round.id, jobId, { ...input, plan: 'x'.repeat(16000) })).rejects.toThrow('过长');
    for (let index = 0; index < 2; index++) {
      round = await service.feedback(round.id, { selected: [jobId], feedback: 'Minimal only', executor: 'reviewer' });
      round = await service.accept(round.id, round.revisions.at(-1)!.id, `Draft ${index}`);
    }
    await expect(service.implementationPreview(round.id, round.revisions[0].id)).rejects.toThrow('最新统一草案');
    expect((await service.implementationPreview(round.id, round.revisions[1].id)).plan).toBe('Draft 1');
  });
  it('generates Diff without writing and applies only after separate approval', async () => {
    const round = await decision(), { jobId, input } = await confirmation(round);
    const task = await service.implement(round.id, jobId, input);
    await workspace.acceptResponse(task.id, modelReply(task.conversationId));
    expect(task.status).toBe('review'); expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toContain('value = 1');
    expect((await service.detail(round.id)).implementations[0].status).toBe('review');
    await workspace.apply(task.id); expect((await settled(task.id)).status).toBe('complete');
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toContain('value = 2');
    expect((await service.detail(round.id)).implementations[0].scripts).toEqual([]);
    expect((await service.detail(round.id)).implementations[0].executionRuns[0]).toMatchObject({ changes: 'applied', verification: 'skipped' });
  });
  it('rolls back failed verification and asks for a newly reviewed Diff on limited retries', async () => {
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'node --test' } });
    vi.spyOn(verification, 'runVerificationInSandbox').mockRejectedValue(new Error('Test fixture: assertion failed'));
    const round = await decision(), { jobId, input } = await confirmation(round);
    const task = await service.implement(round.id, jobId, { ...input, scripts: ['test'] });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await workspace.acceptResponse(task.id, modelReply(task.conversationId)); expect(task.status).toBe('review');
      await workspace.apply(task.id); await settled(task.id);
      expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toContain('value = 1');
      if (attempt < 3) { expect(task.status).toBe('awaiting_response'); expect(task.promptMessage).toContain('rolled back'); }
      else expect(task.status).toBe('failed');
    }
    expect(task.attempt).toBe(3); expect((await service.detail(round.id)).implementations[0].status).toBe('failed');
    expect(task.executionRuns).toHaveLength(3);
    expect(task.executionRuns?.every((run) => run.changes === 'rolled_back' && run.verification === 'failed')).toBe(true);
  });
  it('targets exactly the approved browser tab and rejects other tabs or legacy claimers', async () => {
    recordBrowserHeartbeat('selected-instance', 2, ['chatgpt.com'], [{ tabId: 1, host: 'chatgpt.com' }, { tabId: 2, host: 'chatgpt.com' }]);
    const round = await decision(), { jobId, input } = await confirmation(round);
    const task = await service.implement(round.id, jobId, { ...input, delivery: 'browser', browserTargetId: 'selected-instance:2' });
    expect(getSession(task.sessionId!)?.target).toEqual({ clientId: 'selected-instance', tabId: 2 });
    expect(claimPendingSession()).toBeNull();
    expect(tryClaimSession(task.sessionId!, undefined, { clientId: 'selected-instance', tabId: 1 })).toBeNull();
    expect(tryClaimSession(task.sessionId!, undefined, { clientId: 'selected-instance', tabId: 2 })).not.toBeNull();
  });
  it('rejects cross-project adoption and invalid or offline browser selection before creating a task', async () => {
    const round = await decision(), { jobId, input } = await confirmation(round);
    await expect(service.implement(round.id, jobId, { ...input, delivery: 'browser' })).rejects.toThrow('具体执行网页');
    recordBrowserHeartbeat('selected-instance', 1, ['chatgpt.com'], [{ tabId: 1, host: 'chatgpt.com' }]);
    await expect(service.implement(round.id, jobId, { ...input, delivery: 'browser', browserTargetId: 'missing:2' })).rejects.toThrow('离线');
    const other = await fs.mkdtemp(path.join(root, 'other-')); await workspace.selectProject(other);
    await expect(service.implementationPreview(round.id, jobId)).rejects.toThrow('不属于');
    await expect(service.implement(round.id, jobId, input)).rejects.toThrow('不属于');
    expect(workspace.tasks.size).toBe(0);
  });
});
