import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchService, taskInput } from '../workbench/service.js';
import { CollaborationService } from './service.js';
import { roundInput, jobs } from './protocol.js';
import { recordBrowserHeartbeat, clearSseHub, addBrowserClient, broadcastBrowserJob, browserTargets } from '../server/sse-hub.js';
import { clearSessions, tryClaimSession, claimPendingSession, completeSession, createSession, failSession } from '../server/session-store.js';

let root: string, workspace: WorkbenchService;
const services: CollaborationService[] = [];
const manual = (label: string) => ({ kind: 'manual' as const, label });
const input = () => roundInput.parse({ prompt: 'Compare safe fixes', proposers: [manual('A'), manual('B')], reviewer: manual('Judge'), contextPaths: ['code.ts'], consent: true });
const create = (fetcher?: typeof fetch) => { const service = new CollaborationService(workspace, fetcher); services.push(service); return service; };
async function waitFor(check: () => Promise<boolean>) {
  for (let index = 0; index < 100; index++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('State did not settle');
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-collaboration-'));
  await fs.writeFile(path.join(root, 'code.ts'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=not-shared');
  workspace = new WorkbenchService(root); await workspace.initialize();
});
afterEach(async () => {
  vi.restoreAllMocks(); for (const service of services.splice(0)) await service.close();
  await workspace.close(); clearSseHub(); clearSessions(); await fs.remove(root);
});

describe('read-only multi-model collaboration', () => {
  it('retries only a failed step with consent, a preserved snapshot and a maximum of three attempts', async () => {
    const fetcher = vi.fn(async () => new Response('unavailable', { status: 429 }));
    const service = create(fetcher as typeof fetch);
    const round = await service.create({ ...input(), proposers: [manual('A'), { kind: 'ollama', label: 'B', model: 'local-b' }] });
    await service.accept(round.id, round.proposals[0].id, 'Preserved A');
    await waitFor(async () => (await service.detail(round.id)).proposals[1].status === 'failed');
    const jobId = round.proposals[1].id;
    const retry = { endpoint: { kind: 'ollama' as const, label: 'Replacement B', model: 'local-c' }, consent: true as const, previousRunStopped: true as const };
    await expect(service.retry(round.id, jobId, { ...retry, consent: false } as never)).rejects.toThrow();
    await expect(service.retry(round.id, jobId, { ...retry, previousRunStopped: false } as never)).rejects.toThrow();
    for (let attempt = 2; attempt <= 3; attempt++) {
      await service.retry(round.id, jobId, retry);
      await waitFor(async () => (await service.detail(round.id)).proposals[1].status === 'failed');
      const current = await service.detail(round.id);
      expect(current.proposals[1].attempt).toBe(attempt); expect(current.snapshot).toEqual(round.snapshot);
      expect(current.proposals[0].response).toBe('Preserved A'); expect(current.proposals[0].attempt).toBe(1);
      expect(current.proposals[1].attemptHistory).toHaveLength(attempt - 1);
    }
    await expect(service.retry(round.id, jobId, retry)).rejects.toThrow('三次'); expect(fetcher).toHaveBeenCalledTimes(3);
    const done = await service.accept(round.id, jobId, 'Manual fallback after limit'); expect(done.review).toBeDefined();
    expect(done.review!.prompt).toContain('"comparisons"');
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('export const value = 1;\n');
  });
  it('requires independent retry targets and never rewrites frozen candidates or completed steps', async () => {
    recordBrowserHeartbeat('browser-instance', 2, ['chatgpt.com'], [{ tabId: 1, host: 'chatgpt.com' }, { tabId: 2, host: 'chatgpt.com' }]);
    const service = create(); const browser = (tabId: number) => ({ kind: 'browser' as const, label: 'Browser', targetId: `browser-instance:${tabId}` });
    let round = await service.create({ ...input(), proposers: [browser(1), manual('B')], reviewer: browser(2) });
    await waitFor(async () => (await service.detail(round.id)).proposals[0].status === 'waiting_browser');
    round = await service.detail(round.id); failSession(round.proposals[0].sessionId!, 'offline'); await service.tick();
    const retry = { endpoint: browser(2), consent: true as const, previousRunStopped: true as const };
    await expect(service.retry(round.id, round.proposals[0].id, retry)).rejects.toThrow('独立标签页');
    await service.retry(round.id, round.proposals[0].id, { ...retry, endpoint: manual('Manual A') });
    await service.accept(round.id, round.proposals[0].id, 'A'); round = await service.accept(round.id, round.proposals[1].id, 'B');
    await expect(service.retry(round.id, round.proposals[0].id, retry)).rejects.toThrow('失败');
    await waitFor(async () => (await service.detail(round.id)).review?.status === 'waiting_browser');
    round = await service.detail(round.id); failSession(round.review!.sessionId!, 'offline'); await service.tick();
    round = await service.retry(round.id, round.review!.id, { ...retry, endpoint: manual('New judge') });
    expect(round.reviewer.label).toBe('New judge');
    round = await service.accept(round.id, round.review!.id, 'Plain report retained');
    round = await service.feedback(round.id, { selected: [round.proposals[0].id], feedback: 'Keep minimal', executor: 'reviewer' });
    expect(round.revisions[0].endpoint.label).toBe('New judge');
  });
  it('ignores a late response from a timed-out attempt after explicit retry', async () => {
    const replies: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => replies.push(resolve)));
    const service = create(fetcher as typeof fetch);
    const round = await service.create({ ...input(), proposers: [{ kind: 'ollama', label: 'A', model: 'local-a' }, manual('B')] });
    await waitFor(async () => replies.length === 1);
    const started = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(started + 241000); await service.tick(); vi.restoreAllMocks();
    expect((await service.detail(round.id)).proposals[0].status).toBe('failed');
    await service.retry(round.id, round.proposals[0].id, { endpoint: manual('Replacement A'), consent: true, previousRunStopped: true });
    replies[0](new Response(JSON.stringify({ done: true, message: { content: 'Stale reply must not win' } })));
    await waitFor(async () => (await service.detail(round.id)).proposals[0].status === 'waiting_manual');
    const current = await service.detail(round.id);
    expect(current.proposals[0].response).toBe(''); expect(current.proposals[0].attempt).toBe(2);
    await service.accept(round.id, round.proposals[0].id, 'Current manual reply');
    expect((await service.detail(round.id)).proposals[0].response).toBe('Current manual reply');
  });
  it('restores old records with default attempts and keeps successful replies across restart and retry', async () => {
    const first = create(); const round = await first.create(input());
    await first.accept(round.id, round.proposals[0].id, 'Saved A'); await first.close();
    const file = path.join(root, '.openbrowser/collaborations.json'), stored = await fs.readJson(file);
    for (const job of stored.rounds[0].proposals) { delete job.attempt; delete job.attemptHistory; }
    await fs.writeJson(file, stored);
    const second = create(); const current = await second.detail(round.id);
    expect(current.proposals[1].attempt).toBe(1); expect(current.proposals[1].attemptHistory).toEqual([]);
    const resumed = await second.retry(round.id, current.proposals[1].id, { endpoint: manual('B2'), consent: true, previousRunStopped: true });
    expect(resumed.proposals[0].response).toBe('Saved A'); expect(resumed.proposals[1].attempt).toBe(2);
  });
  it('keeps single-model execution and project switching separate from active collaboration', async () => {
    const service = create(); const round = await service.create(input());
    const single = taskInput.parse({ prompt: 'Single task', mode: 'ask', delivery: 'manual' });
    await expect(workspace.create(single)).rejects.toThrow('多模型会诊正在进行');
    await expect(workspace.selectProject(root)).rejects.toThrow('多模型会诊正在进行');
    await service.cancel(round.id);
    const task = await workspace.create(single);
    await expect(service.create(input())).rejects.toThrow('先完成或停止单模型');
    workspace.cancel(task.id);
  });
  it('treats operation JSON as inert proposal text rather than executing file writes', async () => {
    const service = create(); const round = await service.create(input());
    const text = JSON.stringify({ operations: [{ action: 'EDIT_FILE', path: 'code.ts', content: 'should never be written' }] });
    await service.accept(round.id, round.proposals[0].id, text);
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('export const value = 1;\n');
    expect((await service.detail(round.id)).proposals[0].response).toBe(text);
  });
  it('lists only local-interface models without accepting arbitrary backend URLs', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'local-a' }, { name: 'remote:cloud' }] })));
    const service = create(fetcher as typeof fetch); const endpoints = await service.endpoints();
    expect(endpoints.models).toEqual(['local-a']);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/tags');
    await expect(service.create({ ...input(), proposers: [{ kind: 'ollama', label: 'Cloud', model: 'remote:cloud' }, manual('B')] })).rejects.toThrow('本机模型');
  });
  it('freezes a common snapshot, collects independent replies, judges anonymously, and supports two human-directed revisions', async () => {
    const service = create(); let round = await service.create(input());
    expect(round.proposals[0].prompt).toBe(round.proposals[1].prompt);
    expect(round.snapshot.context).not.toContain('SECRET=');
    await fs.writeFile(path.join(root, 'code.ts'), 'changed by user after snapshot\n');
    await service.accept(round.id, round.proposals[0].id, 'Unique A proposal');
    round = await service.accept(round.id, round.proposals[1].id, 'Unique B proposal');
    expect(round.review?.prompt).toContain('export const value = 1');
    expect(round.review?.prompt).not.toContain('changed by user');
    expect(round.review?.prompt).toContain('Unique A proposal');
    expect(round.review?.prompt).not.toContain('"label":"Judge"');
    await expect(service.accept(round.id, round.proposals[0].id, 'Overwrite A')).rejects.toThrow('不接受回复');
    round = await service.accept(round.id, round.review!.id, 'A is minimal; B has better error handling. Tests not run.');
    expect(round.phase).toBe('decision');
    const selected = round.proposals.map((job) => job.id);
    for (let index = 0; index < 2; index++) {
      round = await service.feedback(round.id, { selected, feedback: 'Keep A and use B error handling', executor: 'reviewer' });
      expect(round.phase).toBe('refining');
      expect(round.revisions.at(-1)?.prompt).toContain('Keep A and use B error handling');
      round = await service.accept(round.id, round.revisions.at(-1)!.id, `Unified draft ${index + 1}`);
      expect(round.phase).toBe('decision');
    }
    await expect(service.feedback(round.id, { selected, feedback: 'Third round', executor: 'reviewer' })).rejects.toThrow('两轮');
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('changed by user after snapshot\n');
    const stored = JSON.stringify(await fs.readJson(path.join(root, '.openbrowser/collaborations.json')));
    expect(stored).not.toContain('sessionId'); expect(stored).toContain('Unified draft 2');
  });
  it('restores complete reports, pauses interrupted jobs and never replays model calls', async () => {
    const first = create(); const round = await first.create(input());
    await first.accept(round.id, round.proposals[0].id, 'A reply');
    await first.close();
    const fetcher = vi.fn(); const second = create(fetcher); await second.list();
    const restored = await second.detail(round.id);
    expect(restored.phase).toBe('paused'); expect(restored.proposals[0].response).toBe('A reply');
    expect(restored.proposals[1].status).toBe('failed'); expect(fetcher).not.toHaveBeenCalled();
    const resumed = await second.accept(round.id, restored.proposals[1].id, 'Manual B reply');
    expect(resumed.review).toBeDefined();
  });
  it('rejects unconsented sharing, secret context paths, duplicate browser tabs and invalid feedback selections', async () => {
    const service = create();
    await expect(service.create({ ...input(), consent: false } as never)).rejects.toThrow();
    await expect(service.create({ ...input(), contextPaths: ['.env'] })).rejects.toThrow('文件不可用');
    recordBrowserHeartbeat('browser-instance', 2, ['chatgpt.com'], [{ tabId: 1, host: 'chatgpt.com' }, { tabId: 2, host: 'chatgpt.com' }]);
    const endpoint = { kind: 'browser' as const, targetId: 'browser-instance:1', label: 'Browser A' };
    await expect(service.create({ ...input(), proposers: [endpoint, endpoint] })).rejects.toThrow('不同的网页标签页');
    await expect(service.create({ ...input(), proposers: [{ ...endpoint, targetId: 'missing:1' }, manual('B')] })).rejects.toThrow('标签页未就绪');
    let round = await service.create(input());
    await service.accept(round.id, round.proposals[0].id, 'A'); round = await service.accept(round.id, round.proposals[1].id, 'B');
    round = await service.accept(round.id, round.review!.id, 'Report');
    await expect(service.feedback(round.id, { selected: [crypto.randomUUID()], feedback: 'Invalid', executor: 'reviewer' })).rejects.toThrow('本轮');
  });
  it('starts separate Ollama proposal requests and does not fabricate missing results or retry failures', async () => {
    const replies: ((response: Response) => void)[] = [];
    const fetcher = vi.fn((_url: string | URL | Request, _init?: RequestInit) => new Promise<Response>((resolve) => replies.push(resolve)));
    const service = create(fetcher as typeof fetch);
    const round = await service.create({ ...input(), proposers: [{ kind: 'ollama', model: 'local-a', label: 'A' }, { kind: 'ollama', model: 'local-b', label: 'B' }] });
    await waitFor(async () => fetcher.mock.calls.length === 2);
    expect(fetcher.mock.calls.every(([url, init]) => url === 'http://127.0.0.1:11434/api/chat' && init?.redirect === 'error')).toBe(true);
    expect(jobs(await service.detail(round.id)).filter((job) => job.status === 'running')).toHaveLength(2);
    replies[0](new Response(JSON.stringify({ model: 'local-a', done: true, message: { content: 'Local A answer' } })));
    replies[1](new Response('unavailable', { status: 429 }));
    await waitFor(async () => (await service.detail(round.id)).phase === 'needs_attention');
    let detail = await service.detail(round.id);
    expect(detail.review).toBeUndefined(); expect(detail.proposals[1].error).toContain('429');
    expect(fetcher).toHaveBeenCalledTimes(2);
    detail = await service.accept(round.id, detail.proposals[1].id, 'Manual fallback B');
    expect(detail.review?.prompt).toContain('Local A answer'); expect(detail.review?.prompt).toContain('Manual fallback B');
  });
  it('cancels pending jobs, ignores late model replies and allows deleting the last round durably', async () => {
    let resolve!: (response: Response) => void;
    const service = create(vi.fn(() => new Promise<Response>((finish) => { resolve = finish; })) as typeof fetch);
    const round = await service.create({ ...input(), proposers: [{ kind: 'ollama', model: 'local-a', label: 'A' }, manual('B')] });
    await waitFor(async () => Boolean(resolve));
    await expect(service.remove(round.id)).rejects.toThrow('先停止');
    await service.cancel(round.id); resolve(new Response(JSON.stringify({ done: true, message: { content: 'Late answer' } })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await service.detail(round.id)).proposals[0].status).toBe('cancelled');
    await service.remove(round.id); expect(await service.list()).toEqual([]);
    expect((await fs.readJson(path.join(root, '.openbrowser/collaborations.json'))).rounds).toEqual([]);
  });
  it('routes browser proposals to different sessions and rejects other tabs or legacy claimers', async () => {
    recordBrowserHeartbeat('browser-instance', 2, ['chatgpt.com', 'chat.deepseek.com'], [{ tabId: 1, host: 'chatgpt.com' }, { tabId: 2, host: 'chat.deepseek.com' }]);
    const service = create(); const round = await service.create({ ...input(), proposers: [1, 2].map((tabId) => ({ kind: 'browser', targetId: `browser-instance:${tabId}`, label: `Browser ${tabId}` })) });
    await waitFor(async () => (await service.detail(round.id)).proposals.every((job) => job.status === 'waiting_browser'));
    const detail = await service.detail(round.id);
    expect(detail.proposals[0].sessionId).not.toBe(detail.proposals[1].sessionId);
    expect(claimPendingSession()).toBeNull();
    expect(tryClaimSession(detail.proposals[0].sessionId!, undefined, { clientId: 'browser-instance', tabId: 2 })).toBeNull();
    for (const [index, job] of detail.proposals.entries()) {
      expect(tryClaimSession(job.sessionId!, undefined, { clientId: 'browser-instance', tabId: index + 1 })).not.toBeNull();
      completeSession(job.sessionId!, `Browser ${index + 1} reply`);
    }
    await service.tick(); expect((await service.detail(round.id)).review).toBeDefined();
    expect(browserTargets()).toHaveLength(2);
  });
  it('does not leak targeted jobs on other extension streams, including replay', () => {
    const session = createSession({ mode: 'ask', prompt: 'x', systemPrompt: '', message: 'private', composerMessage: 'private', delivery: 'text', conversationId: 'round', target: { clientId: 'selected-instance', tabId: 3 } });
    const a = { write: vi.fn(), close: vi.fn() }, b = { write: vi.fn(), close: vi.fn() };
    addBrowserClient(a, 'selected-instance'); addBrowserClient(b, 'another-instance');
    broadcastBrowserJob({ sessionId: session.id, target: session.target, mode: 'ask', message: 'private', composerMessage: 'private', delivery: 'text', systemPrompt: '', conversationId: 'round' });
    expect(a.write.mock.calls.some(([text]) => text.includes('private'))).toBe(true);
    expect(b.write.mock.calls.some(([text]) => text.includes('private'))).toBe(false);
    const c = { write: vi.fn(), close: vi.fn() }; addBrowserClient(c, 'another-instance');
    expect(c.write.mock.calls.some(([text]) => text.includes('private'))).toBe(false);
  });
  it('preserves corrupt storage and rolls back a failed save without silently dropping prior records', async () => {
    const service = create(); let round = await service.create(input());
    await service.cancel(round.id);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk denied'));
    await expect(service.create(input())).rejects.toThrow('disk denied');
    expect(await service.list()).toHaveLength(1);
    round = await service.detail(round.id); expect(round.phase).toBe('cancelled');
    await service.close();
    const file = path.join(root, '.openbrowser/collaborations.json'); await fs.writeFile(file, '{corrupt');
    await expect(create().list()).rejects.toThrow('原文件未覆盖');
    expect(await fs.readFile(file, 'utf8')).toBe('{corrupt');
  });
});
