import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as verification from '../verification/index.js';
import { createBridgeServer } from '../server/index.js';
import { WorkbenchService, taskInput } from './service.js';
import { clearSseHub } from '../server/sse-hub.js';
import { clearSessions, createSession } from '../server/session-store.js';

let app: FastifyInstance;
let root: string;
let token: string;
const origin = 'http://127.0.0.1:5000';
const headers = () => ({ host: '127.0.0.1:5000', origin, 'x-workbench-token': token });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-web-test-'));
  await fs.writeFile(path.join(root, 'hello.ts'), 'export const hello = 1;\n');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=never-send');
  app = await createBridgeServer({ workspaceRoot: root });
  token = (await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: '127.0.0.1:5000' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/ui/project', headers: headers(), payload: { root } });
});

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await app.close(); clearSseHub(); clearSessions(); await fs.remove(root); });

async function createTask() {
  const response = await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Change hello to 2', mode: 'agent', delivery: 'manual', contextPaths: ['hello.ts'], scripts: [] } });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function reply(conversationId: string) {
  return JSON.stringify({ conversationId, operations: [{ action: 'EDIT_FILE', path: 'hello.ts', search: 'hello = 1', replace: 'hello = 2' }] });
}

async function waitForTask(id: string, status: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const task = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${id}`, headers: headers() })).json();
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Task did not reach ${status}`);
}

describe('local workbench API', () => {
  it('requires an explicit page when several are ready, then sends only to the selected page', async () => {
    const clientId = 'page-selector-test';
    await app.inject({ method: 'POST', url: '/browser/heartbeat', payload: { clientId, readyTabs: 2,
      readyPages: [{ tabId: 3, host: 'chatgpt.com' }, { tabId: 9, host: 'chat.deepseek.com' }] } });
    const status = (await app.inject({ method: 'GET', url: '/api/ui/connection', headers: headers() })).json();
    expect(status.targets.map((target: any) => target.name)).toEqual(['ChatGPT', 'DeepSeek']);
    const payload = { prompt: 'Explain hello', mode: 'ask', delivery: 'browser', scripts: [] };
    const ambiguous = await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload });
    expect(ambiguous.statusCode).toBe(400); expect(ambiguous.body).toContain('执行网页');
    expect((await app.inject({ method: 'GET', url: '/api/ui/tasks', headers: headers() })).json()).toEqual([]);
    const task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { ...payload, browserTargetId: `${clientId}:9` } })).json();
    expect(task.browserTargetId).toBe(`${clientId}:9`);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, clientId, tabId: 3 } })).json().claimed).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, clientId, tabId: 9 } })).json().claimed).toBe(true);
    await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: task.sessionId, clientId, tabId: 9, text: 'hello exports 1' } });
    await waitForTask(task.id, 'complete');
    const offline = await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/follow-up`, headers: headers(), payload: { ...payload, browserTargetId: `${clientId}:88` } });
    expect(offline.statusCode).toBe(400); expect(offline.body).toContain('已离线');
    const unchanged = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(unchanged.status).toBe('complete'); expect(unchanged.turns).toEqual([]); expect(unchanged.response).toBe('hello exports 1');
    const followed = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/follow-up`, headers: headers(), payload: { ...payload, browserTargetId: `${clientId}:3` } })).json();
    expect(followed.status).toBe('awaiting_response'); expect(followed.turns).toHaveLength(1); expect(followed.browserTargetId).toBe(`${clientId}:3`);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: followed.sessionId, clientId, tabId: 9 } })).json().claimed).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: followed.sessionId, clientId, tabId: 3 } })).json().claimed).toBe(true);
  });
  it('binds automatic delivery to the sole ready page and keeps the binding when another page opens', async () => {
    const clientId = 'single-page-test';
    await app.inject({ method: 'POST', url: '/browser/heartbeat', payload: { clientId, readyTabs: 1, readyPages: [{ tabId: 3, host: 'chatgpt.com' }] } });
    const task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Explain hello', mode: 'ask', delivery: 'browser' } })).json();
    expect(task.browserTargetId).toBe(`${clientId}:3`);
    await app.inject({ method: 'POST', url: '/browser/heartbeat', payload: { clientId, readyTabs: 2, readyPages: [{ tabId: 3, host: 'chatgpt.com' }, { tabId: 9, host: 'chat.deepseek.com' }] } });
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, clientId, tabId: 9 } })).json().claimed).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, clientId, tabId: 3 } })).json().claimed).toBe(true);
  });
  it('surfaces current reception metadata without treating it as a model reply, retrying or writing files', async () => {
    await app.inject({ method: 'POST', url: '/browser/heartbeat', payload: { clientId: 'reception-test', readyTabs: 1, readyHosts: ['chatgpt.com'] } });
    const task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Explain hello', mode: 'agent', delivery: 'browser', contextPaths: ['hello.ts'] } })).json();
    await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, providerHost: 'chatgpt.com' } });
    const reception = { version: '0.8.13', elapsedMs: 32000, stream: 'pending', streamChars: 53, pageChars: 200,
      users: 1, currentUsers: 1, assistants: 1, matchedBy: 'user', reason: 'awaiting_completion', busy: false, finished: false };
    expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: task.sessionId, reception } })).json().accepted).toBe(true);
    let observed = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(observed.reception).toEqual(reception); expect(observed.status).toBe('awaiting_response');
    expect(observed.response).toBe(''); expect(observed.attempt).toBe(1); expect(observed.plans).toEqual([]);
    expect(observed.logs.some((entry: { text: string }) => entry.text.includes('awaiting_completion'))).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: task.sessionId, reception: { ...reception, elapsedMs: 1000 } } })).json().accepted).toBe(false);
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/cancel`, headers: headers(), payload: {} });
    expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: task.sessionId, reception: { ...reception, elapsedMs: 40000 } } })).json().accepted).toBe(false);
    observed = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(observed.status).toBe('cancelled'); expect(observed.reception.elapsedMs).toBe(32000);
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
  });
  it('rejects wrong-tab, arbitrary-text and malformed reception diagnostics', async () => {
    const target = { clientId: 'selected-instance', tabId: 3 };
    const session = createSession({ mode: 'ask', prompt: 'hello', systemPrompt: '', message: 'hello', composerMessage: 'hello', delivery: 'text', conversationId: 'round', target });
    const reception = { version: '0.8.13', elapsedMs: 1000, stream: 'pending', streamChars: 0, pageChars: 0,
      users: 0, currentUsers: 0, assistants: 0, matchedBy: 'none', reason: 'awaiting_turn', busy: false, finished: false };
    expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: session.id, reception, ...target } })).json().accepted).toBe(false);
    await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: session.id, ...target, providerHost: 'chatgpt.com' } });
    expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: session.id, reception, ...target, tabId: 9 } })).statusCode).toBe(403);
    for (const bad of [{ ...reception, reason: 'chat source' }, { ...reception, pageChars: -1 }, { ...reception, source: 'secret' }]) {
      expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: session.id, reception: bad, ...target } })).statusCode).toBe(400);
    }
  });
  it('shows a complete ChatGPT clarification without format retries and permits follow-up in the same task', async () => {
    let task = await createTask();
    const question = '请说明希望对 README.md 进行哪些具体修改？';
    const text = '<escape>' + JSON.stringify({ conversationId: task.conversationId, error: question, operations: [] });
    const response = await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text } });
    expect(response.statusCode).toBe(200); task = response.json();
    expect(task.status).toBe('needs_input');
    expect(task.error).toBe(question); expect(task.attempt).toBe(1); expect(task.plans).toEqual([]);
    expect(task.logs.some((entry: any) => entry.text.includes('反馈错误并准备下一次方案'))).toBe(false);
    const followed = await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/follow-up`, headers: headers(), payload: {
      prompt: '将 hello 的值从 1 改成 2', mode: 'agent', delivery: 'manual', contextPaths: ['hello.ts'], scripts: [],
    } });
    expect(followed.statusCode).toBe(200); task = followed.json();
    expect(task.turns.at(-1).error).toBe(question);
    const proposal = await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: reply(task.conversationId) } });
    expect(proposal.json().status).toBe('review');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
  });
  it('creates an authenticated linked implementation, deduplicates confirmation and keeps Diff approval separate', async () => {
    const endpoint = { kind: 'manual', label: 'Manual' }, base = '/api/ui/collaboration/rounds';
    let round = (await app.inject({ method: 'POST', url: base, headers: headers(), payload: {
      prompt: 'Change hello to 2', contextPaths: ['hello.ts'], proposers: [endpoint, endpoint], reviewer: endpoint, consent: true,
    } })).json();
    for (const job of round.proposals) round = (await app.inject({ method: 'POST', url: `${base}/${round.id}/replies/${job.id}`, headers: headers(), payload: { text: 'Only change hello.ts' } })).json();
    round = (await app.inject({ method: 'POST', url: `${base}/${round.id}/replies/${round.review.id}`, headers: headers(), payload: { text: 'Use A, tests not run' } })).json();
    const previewUrl = `${base}/${round.id}/implementation-preview/${round.proposals[0].id}`;
    expect((await app.inject({ method: 'GET', url: previewUrl, headers: { host: '127.0.0.1:5000' } })).statusCode).toBe(401);
    const preview = (await app.inject({ method: 'GET', url: previewUrl, headers: headers() })).json();
    const url = `${base}/${round.id}/implement/${round.proposals[0].id}`;
    const payload = { plan: preview.plan, expectedDigest: preview.expectedDigest, requestId: crypto.randomUUID(), delivery: 'manual', consent: true };
    expect((await app.inject({ method: 'POST', url, payload, headers: { host: '127.0.0.1:5000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload, headers: { ...headers(), origin: 'https://evil.test' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, consent: false }, headers: headers() })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url, payload, headers: headers() }); expect(created.statusCode).toBe(200);
    const task = created.json(); expect(task.collaborationSource.roundId).toBe(round.id); expect(task.status).toBe('awaiting_response');
    expect((await app.inject({ method: 'POST', url, payload, headers: headers() })).json().id).toBe(task.id);
    const diff = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, payload: { text: reply(task.conversationId) }, headers: headers() })).json();
    expect(diff.status).toBe('review'); expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 1');
    const detail = (await app.inject({ method: 'GET', url: `${base}/${round.id}`, headers: headers() })).json();
    expect(detail.implementations).toHaveLength(1); expect(detail.implementations[0].status).toBe('review');
  });
  it('serves report/draft modules and protects explicit retry with token, origin and consent checks', async () => {
    for (const url of ['/collaboration-report.js', '/collaboration-drafts.js', '/execution-status.js', '/browser-targets.js', '/task-drafts.js']) {
      const asset = await app.inject({ method: 'GET', url }); expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
    }
    const endpoint = { kind: 'manual', label: 'Manual' };
    const round = (await app.inject({ method: 'POST', url: '/api/ui/collaboration/rounds', headers: headers(), payload: {
      prompt: 'Retry boundary check', proposers: [endpoint, endpoint], reviewer: endpoint, consent: true,
    } })).json();
    const url = `/api/ui/collaboration/rounds/${round.id}/retry/${round.proposals[0].id}`;
    const payload = { endpoint, consent: true, previousRunStopped: true };
    expect((await app.inject({ method: 'POST', url, payload, headers: { host: '127.0.0.1:5000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, payload, headers: { ...headers(), origin: 'https://evil.test' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, payload: { ...payload, consent: false }, headers: headers() })).statusCode).toBe(400);
    const running = await app.inject({ method: 'POST', url, payload, headers: headers() });
    expect(running.statusCode).toBe(400); expect(running.body).toContain('失败');
  });
  it('exposes authenticated read-only collaboration, manual reports and human-directed fusion without applying files', async () => {
    const base = '/api/ui/collaboration/rounds';
    const payload = { prompt: 'Compare hello fixes', contextPaths: ['hello.ts'], consent: true,
      proposers: [{ kind: 'manual', label: 'A' }, { kind: 'manual', label: 'B' }], reviewer: { kind: 'manual', label: 'Judge' } };
    expect((await app.inject({ method: 'GET', url: base, headers: { host: '127.0.0.1:5000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: base, headers: { ...headers(), origin: 'https://untrusted.example' }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: base, headers: headers(), payload: { ...payload, consent: false } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: base, headers: headers(), payload });
    expect(created.statusCode).toBe(200); let round = created.json();
    for (const job of round.proposals) round = (await app.inject({ method: 'POST', url: `${base}/${round.id}/replies/${job.id}`, headers: headers(), payload: { text: `${job.label} has a unique design` } })).json();
    expect(round.review).toBeDefined();
    round = (await app.inject({ method: 'POST', url: `${base}/${round.id}/replies/${round.review.id}`, headers: headers(), payload: { text: 'Comparison report. Tests not run.' } })).json();
    expect(round.phase).toBe('decision');
    round = (await app.inject({ method: 'POST', url: `${base}/${round.id}/feedback`, headers: headers(), payload: { selected: [round.proposals[0].id], feedback: 'Keep A, simplify implementation', executor: 'reviewer' } })).json();
    round = (await app.inject({ method: 'POST', url: `${base}/${round.id}/replies/${round.revisions[0].id}`, headers: headers(), payload: { text: 'Unified read-only draft' } })).json();
    expect(round.phase).toBe('decision');
    await app.close(); app = await createBridgeServer({ workspaceRoot: root });
    token = (await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: '127.0.0.1:5000' } })).json().token;
    const restored = (await app.inject({ method: 'GET', url: `${base}/${round.id}`, headers: headers() })).json();
    expect(restored.revisions[0].response).toBe('Unified read-only draft');
    expect(restored.snapshot.context).not.toContain('SECRET=');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
  });
  it('rejects claims, partials and final replies from the wrong tab for targeted sessions', async () => {
    const target = { clientId: 'selected-instance', tabId: 3 };
    const session = createSession({ mode: 'ask', prompt: 'hello', systemPrompt: '', message: 'hello', composerMessage: 'hello', delivery: 'text', conversationId: 'round', target });
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: session.id } })).json().claimed).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: session.id, ...target, providerHost: 'chat.deepseek.com' } })).json().claimed).toBe(true);
    for (const url of ['/browser/chunk', '/browser/response']) {
      expect((await app.inject({ method: 'POST', url, payload: { sessionId: session.id, text: 'wrong tab', clientId: target.clientId, tabId: 9 } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: session.id, text: 'correct reply', ...target } })).statusCode).toBe(200);
  });
  it('validates and protects conversation metadata edits, while preserving prompt text', async () => {
    const task = await createTask(), url = `/api/ui/tasks/${task.id}`;
    expect((await app.inject({ method: 'PATCH', url, headers: headers(), payload: { archived: true } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `${url}/cancel`, headers: headers(), payload: {} });
    expect((await app.inject({ method: 'PATCH', url, headers: { host: '127.0.0.1:5000' }, payload: { title: 'New' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url, headers: { ...headers(), origin: 'https://untrusted.example' }, payload: { archived: true } })).statusCode).toBe(403);
    for (const payload of [{}, { title: ' ' }, { title: 'x'.repeat(201) }, { pinned: 'true' }, { status: 'complete' }]) {
      expect((await app.inject({ method: 'PATCH', url, headers: headers(), payload })).statusCode).toBe(400);
    }
    const edited = (await app.inject({ method: 'PATCH', url, headers: headers(), payload: { title: '  Friendly title  ', pinned: true, archived: true } })).json();
    expect(edited).toMatchObject({ title: 'Friendly title', prompt: 'Change hello to 2', pinned: true, archived: true });
    const list = (await app.inject({ method: 'GET', url: '/api/ui/tasks', headers: headers() })).json();
    expect(list[0]).toMatchObject({ title: 'Friendly title', pinned: true, archived: true });
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
  });
  it('deletes stopped conversations through the authenticated API and does not restore them on restart', async () => {
    const task = await createTask();
    const url = `/api/ui/tasks/${task.id}`;
    expect((await app.inject({ method: 'DELETE', url, headers: { host: '127.0.0.1:5000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url, headers: { ...headers(), origin: 'https://untrusted.example' } })).statusCode).toBe(403);
    const blocked = await app.inject({ method: 'DELETE', url, headers: headers() });
    expect(blocked.statusCode).toBe(400); expect(blocked.json().error).toContain('请先完成');
    await app.inject({ method: 'POST', url: `${url}/cancel`, headers: headers(), payload: {} });
    expect((await app.inject({ method: 'GET', url: '/api/ui/tasks', headers: headers() })).json()).toHaveLength(1);
    const response = await app.inject({ method: 'DELETE', url, headers: headers(), payload: {} });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ deleted: task.id });
    expect((await app.inject({ method: 'GET', url: '/api/ui/tasks', headers: headers() })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url, headers: headers() })).statusCode).toBe(400);
    await app.close(); app = await createBridgeServer({ workspaceRoot: root });
    token = (await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: '127.0.0.1:5000' } })).json().token;
    expect((await app.inject({ method: 'GET', url: '/api/ui/tasks', headers: headers() })).json()).toEqual([]);
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
  });
  it('confirms the actual claimant rather than guessing from multiple ready providers, and persists it', async () => {
    await app.inject({ method: 'POST', url: '/browser/heartbeat', payload: { clientId: 'identity-test', readyTabs: 2, readyHosts: ['chatgpt.com', 'chat.deepseek.com'] } });
    const connection = (await app.inject({ method: 'GET', url: '/api/ui/connection', headers: headers() })).json();
    expect(connection.providers.map((provider: { name: string }) => provider.name)).toEqual(['ChatGPT', 'DeepSeek']);
    let task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Explain hello', mode: 'ask', delivery: 'browser' } })).json();
    expect(task.ai).toBeUndefined(); expect(task.aiPending).toBe(true);
    const claim = await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, providerHost: 'chat.deepseek.com' } });
    expect(claim.json().claimed).toBe(true);
    task = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(task.ai.name).toBe('DeepSeek'); expect(task.aiPending).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, providerHost: 'chatgpt.com' } })).json().claimed).toBe(false);
    await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: task.sessionId, text: 'AI reply' } });
    task = await waitForTask(task.id, 'complete');
    expect(task.ai.name).toBe('DeepSeek');
    await app.close(); app = await createBridgeServer({ workspaceRoot: root });
    token = (await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: '127.0.0.1:5000' } })).json().token;
    task = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(task.ai.name).toBe('DeepSeek'); expect(task.sessionId).toBeUndefined();
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/follow-up`, headers: headers(), payload: { prompt: 'Continue manually', mode: 'ask', delivery: 'manual' } })).json();
    expect(task.ai).toBeUndefined(); expect(task.turns[0].ai.name).toBe('DeepSeek');
  });
  it('does not attribute manually pasted replies to the browser claimant, and keeps legacy identity unknown', async () => {
    await app.inject({ method: 'POST', url: '/browser/heartbeat', payload: { clientId: 'old-extension', readyTabs: 1 } });
    let task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Question', mode: 'ask', delivery: 'browser' } })).json();
    await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId } });
    task = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(task.ai).toBeUndefined(); expect(task.aiPending).toBe(false);
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/cancel`, headers: headers(), payload: {} });
    task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Another question', mode: 'ask', delivery: 'browser' } })).json();
    await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: task.sessionId, providerHost: 'chatgpt.com' } });
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: 'A manually pasted answer.' } })).json();
    expect(task.manualResponse).toBe(true); expect(task.ai).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json().ai).toBeUndefined();
  });
  it('serves the AI display module even when a bridge token is configured', async () => {
    vi.stubEnv('BRIDGE_TOKEN', 'test-bridge-secret');
    const response = await app.inject({ method: 'GET', url: '/ai-status.js' });
    expect(response.statusCode).toBe(200); expect(response.body).toContain('connectionAiDisplay');
    expect((await app.inject({ method: 'GET', url: '/composer-controls.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/conversation-menu.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/collaboration.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('id="ai-current"');
  });
  it('discovers login code without selected files, then reads, reviews and applies a minimal fix', async () => {
    const source = 'export function login() {\n  return "LOGIN_FAILED";\n}\n';
    await fs.outputFile(path.join(root, 'src/login.ts'), source);
    let task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: '修复登录失败', mode: 'agent', delivery: 'manual', contextPaths: [], scripts: [] } })).json();
    const id = task.id, conversationId = task.conversationId;
    for (const toolRequests of [
      [{ tool: 'list_files', path: '.', depth: 2 }],
      [{ tool: 'search', path: 'src', query: 'LOGIN_FAILED' }],
      [{ tool: 'read_file', path: 'src/login.ts', startLine: 2, endLine: 2 }],
    ]) {
      task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/response`, headers: headers(), payload: { text: JSON.stringify({ conversationId, operations: [], toolRequests }) } })).json();
      expect(task.status).toBe('awaiting_response'); expect(task.attempt).toBe(1); expect(task.plans).toEqual([]);
      expect(await fs.readFile(path.join(root, 'src/login.ts'), 'utf8')).toBe(source);
    }
    expect(task.attachedFiles).toContain('src/login.ts'); expect(task.contextPaths).toEqual([]);
    expect(task.logs.some((entry: { text: string }) => entry.text.includes('搜索代码') && entry.text.includes('1 个命中'))).toBe(true);
    const text = JSON.stringify({ conversationId, operations: [{ action: 'EDIT_FILE', path: 'src/login.ts', search: 'return "LOGIN_FAILED";', replace: 'return "LOGIN_OK";' }] });
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/response`, headers: headers(), payload: { text } })).json();
    expect(task.status).toBe('review');
    expect(await fs.readFile(path.join(root, 'src/login.ts'), 'utf8')).toBe(source);
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/apply`, headers: headers(), payload: {} });
    expect((await waitForTask(id, 'complete')).status).toBe('complete');
    expect(await fs.readFile(path.join(root, 'src/login.ts'), 'utf8')).toBe(source.replace('LOGIN_FAILED', 'LOGIN_OK'));
  });
  it('keeps the read-before-edit boundary even after a rejected discovery proposal triggers retries', async () => {
    let task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Fix hello', mode: 'agent', delivery: 'manual' } })).json();
    const request = JSON.stringify({ conversationId: task.conversationId, operations: [], toolRequests: [{ tool: 'search', query: 'hello' }] });
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: request } });
    for (let n = 0; n < 2; n++) {
      const text = JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'hello.ts', content: 'blind replacement' }] });
      task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text } })).json();
      expect(task.error).toContain('read_file'); expect(task.status).toBe('awaiting_response'); expect(task.plans).toEqual([]);
    }
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
  });
  it('caps discovery at six rounds and resets the allowance only on an explicit follow-up', async () => {
    let task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Inspect project', mode: 'agent', delivery: 'manual' } })).json();
    const text = JSON.stringify({ conversationId: task.conversationId, operations: [], toolRequests: [{ tool: 'list_files', path: '.' }] });
    for (let n = 0; n < 6; n++) {
      task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text } })).json();
      expect(task.status).toBe('awaiting_response'); expect(task.attempt).toBe(1);
    }
    const envelope = JSON.parse(task.promptMessage.split('--- End System Instructions ---\n')[1]);
    expect(envelope.context.toolBudget.remainingRounds).toBe(0);
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text } })).json();
    expect(task.status).toBe('failed'); expect(task.error).toContain('6 轮');
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/follow-up`, headers: headers(), payload: { prompt: 'Inspect only the root', mode: 'agent', delivery: 'manual' } });
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text } })).json();
    expect(task.status).toBe('awaiting_response'); expect(task.attempt).toBe(1);
  });
  it('restores a completed conversation through the API after a service restart', async () => {
    await app.inject({ method: 'POST', url: '/api/ui/project', headers: headers(), payload: { root } });
    const task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Remember this answer', mode: 'ask', delivery: 'manual' } })).json();
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: 'Durable answer.' } });
    const oldToken = token;
    await app.close(); app = await createBridgeServer({ workspaceRoot: root });
    token = (await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: '127.0.0.1:5000' } })).json().token;
    expect(token).not.toBe(oldToken);
    await app.inject({ method: 'POST', url: '/api/ui/project', headers: headers(), payload: { root } });
    const restored = (await app.inject({ method: 'GET', url: `/api/ui/tasks/${task.id}`, headers: headers() })).json();
    expect(restored.status).toBe('complete'); expect(restored.response).toBe('Durable answer.');
    expect(restored.sessionId).toBeUndefined(); expect(restored.plans).toEqual([]);
  });
  it('uses tail context for a small edit and preserves the rest of the file on apply', async () => {
    const content = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join('\n');
    await fs.writeFile(path.join(root, 'README.md'), content);
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: '最后加一个1', mode: 'agent', delivery: 'manual', contextPaths: ['README.md'] }));
    const envelope = JSON.parse(task.promptMessage.split('--- End System Instructions ---\n')[1]);
    expect(envelope.context.contextFiles[0].includedRanges).toEqual([{ startLine: 551, endLine: 600 }]);
    await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'README.md', search: 'line 600', replace: 'line 6001' }] }));
    expect(task.status).toBe('review');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe(content);
    await service.apply(task.id);
    for (let n = 0; n < 100 && task.status === 'applying'; n++) await new Promise((resolve) => setTimeout(resolve, 15));
    expect(task.status).toBe('complete');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe(content + '1');
    await service.close();
  });
  it('blocks snippet overwrite, allows a bounded full read, then requires review again', async () => {
    const content = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
    await fs.writeFile(path.join(root, 'README.md'), content);
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: '最后加一个1', mode: 'agent', delivery: 'manual', contextPaths: ['README.md'] }));
    const proposal = JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'README.md', content: 'only tail' }] });
    await service.acceptResponse(task.id, proposal);
    expect(task.status).toBe('awaiting_response'); expect(task.error).toContain('覆盖整个文件');
    const attempt = task.attempt;
    await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, contextRequests: [{ path: 'README.md' }] }));
    expect(task.attempt).toBe(attempt); expect(task.status).toBe('awaiting_response');
    expect(task.logs.some((entry) => entry.text.includes('按需补读'))).toBe(true);
    expect(task.promptMessage).toContain('   1| line 1');
    await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'README.md', content: content + '1' }] }));
    expect(task.status).toBe('review');
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe(content);
    await service.close();
  });
  it('limits context reads independently of correction attempts and denies secret reads', async () => {
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: 'Fix hello', mode: 'agent', delivery: 'manual' }));
    const read = JSON.stringify({ conversationId: task.conversationId, contextRequests: [{ path: 'hello.ts', startLine: 1, endLine: 1 }] });
    await service.acceptResponse(task.id, read); await service.acceptResponse(task.id, read);
    expect(task.attempt).toBe(1); expect(task.status).toBe('awaiting_response');
    await service.acceptResponse(task.id, read);
    expect(task.status).toBe('failed'); expect(task.error).toContain('补读上限');
    const denied = await service.create(taskInput.parse({ prompt: 'Read file', mode: 'agent', delivery: 'manual' }));
    await service.acceptResponse(denied.id, JSON.stringify({ conversationId: denied.conversationId, contextRequests: [{ path: '.env' }] }));
    expect(denied.status).toBe('failed'); expect(denied.promptMessage).not.toContain('SECRET=never-send');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('export const hello = 1;\n');
    await service.close();
  });
  it('reviews and applies JSON source for Markdown and YAML without rewriting it', async () => {
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: 'Create README and config', mode: 'agent', delivery: 'manual' }));
    const files = { 'README.md': '# Hello\n\n```bash\necho "hi"\n```\n', 'config.yaml': 'app:\n  title: "hello"\n' };
    await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, operations: Object.entries(files).map(([path, content]) => ({ action: 'CREATE_FILE', path, content })) }));
    expect(task.status).toBe('review');
    expect(await fs.pathExists(path.join(root, 'README.md'))).toBe(false);
    await service.apply(task.id);
    for (let n = 0; n < 100 && task.status === 'applying'; n++) await new Promise((resolve) => setTimeout(resolve, 15));
    expect(task.status).toBe('complete');
    for (const [name, content] of Object.entries(files)) expect(await fs.readFile(path.join(root, name), 'utf8')).toBe(content);
    await service.close();
  });
  it('pauses for clarification instead of retrying an unanswerable request', async () => {
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: 'Fix it', mode: 'agent', delivery: 'manual' }));
    await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, error: '需要修改哪个文件？', operations: [] }));
    expect(task.status).toBe('needs_input'); expect(task.attempt).toBe(1);
    expect(task.error).toBe('需要修改哪个文件？'); expect(task.plans).toEqual([]);
    expect(service.hasActiveWork).toBe(false);
    await expect(service.apply(task.id)).rejects.toThrow('不能应用');
    await service.close();
  });
  it('repairs a captured wrapper into review only, and still denies unsafe recovered operations', async () => {
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: 'Fix hello', mode: 'agent', delivery: 'manual', contextPaths: ['hello.ts'] }));
    const captured = JSON.stringify({ operations: JSON.parse(reply(task.conversationId)).operations, conversationId: task.conversationId });
    await service.acceptResponse(task.id, 'Model explanation.' + captured.slice(2));
    expect(task.status).toBe('review'); expect(task.logs.some((entry) => entry.text.includes('JSON 外层开头'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 1');
    service.cancel(task.id);
    const denied = await service.create(taskInput.parse({ prompt: 'Unsafe', mode: 'agent', delivery: 'manual' }));
    await service.acceptResponse(denied.id, JSON.stringify({ operations: [{ action: 'RUN_COMMAND', command: 'echo unsafe' }], conversationId: denied.conversationId }).slice(2));
    expect(denied.status).toBe('awaiting_response'); expect(denied.error).toContain('不允许模型执行命令');
    await service.close();
  });
  it('stops model retries on verification setup failures after restoring the files', async () => {
    const service = new WorkbenchService(root);
    vi.spyOn(verification, 'runVerificationInSandbox').mockRejectedValue(new verification.VerificationSetupError('dependency copy denied'));
    const task = await service.create(taskInput.parse({ prompt: 'Fix hello', mode: 'agent', delivery: 'manual', contextPaths: ['hello.ts'], scripts: ['test'] }));
    await service.acceptResponse(task.id, reply(task.conversationId));
    await service.apply(task.id);
    for (let n = 0; n < 100 && task.status === 'applying'; n++) await new Promise((resolve) => setTimeout(resolve, 15));
    expect(task.status).toBe('failed'); expect(task.attempt).toBe(1);
    expect(task.logs.some((entry) => entry.text.includes('不会重复发给模型'))).toBe(true);
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 1');
    await service.close();
  });

  it('recovers a saved reply into the same conversation for review, without applying it', async () => {
    const task = await createTask();
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/cancel`, headers: headers(), payload: {} });
    const service = new WorkbenchService(root);
    const recovered = await service.recoverTask({ ...taskInput.parse({ prompt: task.prompt, mode: 'agent', delivery: 'browser', contextPaths: ['hello.ts'] }), id: task.id, conversationId: task.conversationId, title: task.title, root: await fs.realpath(root), turns: [], response: reply(task.conversationId) });
    expect(recovered.id).toBe(task.id); expect(recovered.conversationId).toBe(task.conversationId);
    expect(recovered.status).toBe('review'); expect(recovered.delivery).toBe('manual');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 1');
    await expect(service.recoverTask({ ...taskInput.parse({ prompt: 'wrong', mode: 'agent', delivery: 'manual' }), id: task.id, conversationId: task.conversationId, title: 'wrong', root: path.dirname(root), turns: [], response: reply(task.conversationId) })).rejects.toThrow('不属于');
    await service.close();
  });
  it('serves the actual UI and protects workspace routes with a token and same-origin policy', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('项目上下文');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: 'GET', url: '/api/ui/workspace', headers: { host: '127.0.0.1:5000' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: 'evil.test', origin: 'http://evil.test' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/ui/bootstrap', headers: { host: '127.0.0.1:5000', origin: 'https://evil.test' } })).statusCode).toBe(403);
    const workspace = (await app.inject({ method: 'GET', url: '/api/ui/workspace', headers: headers() })).json();
    expect(workspace.files).toEqual(['hello.ts']);
  });

  it('completes a manual proposal → review → approved apply → history workflow', async () => {
    const task = await createTask();
    expect(task.promptMessage).toContain('export const hello = 1');
    const reviewed = await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: reply(task.conversationId) } });
    expect(reviewed.json().status).toBe('review');
    expect(reviewed.json().plans[0].diff).toContain('+export const hello = 2');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 1');
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/apply`, headers: headers(), payload: {} });
    await waitForTask(task.id, 'complete');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 2');
    const history = (await app.inject({ method: 'GET', url: '/api/ui/history', headers: headers() })).json();
    expect(history[0].outcome).toBe('applied');
  });

  it('preserves an external edit made after review and requests a new proposal', async () => {
    const task = await createTask();
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: reply(task.conversationId) } });
    await fs.writeFile(path.join(root, 'hello.ts'), 'external edit');
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/apply`, headers: headers(), payload: {} });
    const retried = await waitForTask(task.id, 'awaiting_response');
    expect(retried.attempt).toBe(2);
    expect(retried.error).toContain('审核后发生变化');
    expect(retried.promptMessage).toContain('external edit');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toBe('external edit');
  });

  it('rejects secret/path traversal access and denies unreviewed application', async () => {
    for (const file of ['.env', '../outside.txt']) {
      expect((await app.inject({ method: 'GET', url: `/api/ui/file?path=${encodeURIComponent(file)}`, headers: headers() })).statusCode).toBe(400);
    }
    const task = await createTask();
    expect((await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/apply`, headers: headers(), payload: {} })).statusCode).toBe(400);
    const stopped = await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/cancel`, headers: headers(), payload: {} });
    expect(stopped.json().status).toBe('cancelled');
    expect((await app.inject({ method: 'POST', url: `/api/ui/tasks/${task.id}/response`, headers: headers(), payload: { text: reply(task.conversationId) } })).statusCode).toBe(400);
  });

  it('returns verification failure to the model only after restoring file changes', async () => {
    await fs.writeJson(path.join(root, 'package.json'), { scripts: { test: 'node -e "process.exit(1)"' } });
    const service = new WorkbenchService(root);
    const task = await service.create(taskInput.parse({ prompt: 'Fix hello', mode: 'agent', delivery: 'manual', contextPaths: ['hello.ts'], scripts: ['test'] }));
    await service.acceptResponse(task.id, reply(task.conversationId));
    await service.apply(task.id);
    for (let n = 0; n < 100 && task.status === 'applying'; n++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(task.status).toBe('awaiting_response');
    expect(task.attempt).toBe(2);
    expect(task.promptMessage).toContain('rolled back');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 1');
    await service.close();
  });

  it('continues the same conversation with prior answers and refreshed files, while preserving review', async () => {
    let task = (await app.inject({ method: 'POST', url: '/api/ui/tasks', headers: headers(), payload: { prompt: 'Explain hello', mode: 'ask', delivery: 'manual', contextPaths: ['hello.ts'] } })).json();
    const id = task.id, conversationId = task.conversationId;
    expect((await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/follow-up`, headers: headers(), payload: { prompt: 'too early', mode: 'ask', delivery: 'manual' } })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/response`, headers: headers(), payload: { text: 'hello currently exports 1.' } });
    await fs.writeFile(path.join(root, 'hello.ts'), 'export const hello = 7;\n');
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/follow-up`, headers: headers(), payload: { prompt: 'Now change it to 8', mode: 'agent', delivery: 'manual', contextPaths: ['hello.ts'] } })).json();
    expect(task.id).toBe(id); expect(task.conversationId).toBe(conversationId);
    expect(task.turns).toHaveLength(1); expect(task.turns[0].response).toContain('exports 1');
    expect(task.promptMessage).toContain('hello currently exports 1');
    expect(task.promptMessage).toContain('hello = 7'); expect(task.attempt).toBe(1);
    const proposal = JSON.stringify({ conversationId, operations: [{ action: 'EDIT_FILE', path: 'hello.ts', search: 'hello = 7', replace: 'hello = 8' }] });
    const reviewed = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/response`, headers: headers(), payload: { text: proposal } })).json();
    expect(reviewed.status).toBe('review');
    expect(await fs.readFile(path.join(root, 'hello.ts'), 'utf8')).toContain('hello = 7');
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/cancel`, headers: headers(), payload: {} });
    task = (await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/follow-up`, headers: headers(), payload: { prompt: 'Do not apply it, explain instead', mode: 'ask', delivery: 'manual' } })).json();
    expect(task.turns[1].status).toBe('rejected'); expect(task.mode).toBe('ask');
    expect(task.promptMessage).toContain('rejected');
    await app.inject({ method: 'POST', url: `/api/ui/tasks/${id}/response`, headers: headers(), payload: { text: 'It was not applied.' } });
    expect((await app.inject({ method: 'GET', url: '/api/ui/tasks', headers: headers() })).json()).toHaveLength(1);
  });

  it('lists navigable directories only, without switching projects or accepting cross-site browsing', async () => {
    await fs.mkdir(path.join(root, 'my-app')); await fs.mkdir(path.join(root, '.private')); await fs.mkdir(path.join(root, 'node_modules'));
    const listing = (await app.inject({ method: 'GET', url: `/api/ui/folders?path=${encodeURIComponent(root)}`, headers: headers() })).json();
    expect(listing.current).toBe(await fs.realpath(root));
    expect(listing.folders.map((folder: { name: string }) => folder.name)).toEqual(['my-app']);
    expect(listing.parent).toBe(path.dirname(await fs.realpath(root)));
    expect((await app.inject({ method: 'GET', url: '/api/ui/workspace', headers: headers() })).json().root).toBe(await fs.realpath(root));
    expect((await app.inject({ method: 'GET', url: '/api/ui/folders?path=relative', headers: headers() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/ui/folders', headers: { ...headers(), origin: 'https://evil.test' } })).statusCode).toBe(403);
  });
});
