import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBridgeServer } from './index.js';
import { addSessionClient, clearSseHub } from './sse-hub.js';
import { clearSessions, completeSession, createSession, failSession, getSession, releaseClaim } from './session-store.js';

let app: FastifyInstance;
let root: string;
const owner = { clientId: 'claiming-browser', tabId: 3 };
const reception = { version: '0.8.14', elapsedMs: 1000, stream: 'pending', streamChars: 0, pageChars: 0,
  users: 0, currentUsers: 0, assistants: 0, matchedBy: 'none', reason: 'awaiting_turn', busy: false, finished: false };

function session() {
  return createSession({ mode: 'ask', prompt: 'hello', systemPrompt: '', message: 'hello', composerMessage: 'hello',
    delivery: 'text', conversationId: 'round' });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-session-test-'));
  app = await createBridgeServer({ workspaceRoot: root });
});
afterEach(async () => { await app.close(); clearSseHub(); clearSessions(); await fs.remove(root); });

describe('browser reply ownership', () => {
  it('binds an untargeted job to its claiming tab for progress, diagnostics and final replies', async () => {
    const job = session();
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: job.id, ...owner } })).json().claimed).toBe(true);
    const other = { ...owner, tabId: 9 };
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: job.id, ...other } })).json().claimed).toBe(false);
    for (const source of [other, { ...owner, clientId: 'other-browser' }, {}]) {
      for (const [url, data] of [['/browser/chunk', { text: 'wrong partial' }], ['/browser/chunk', { reception }],
        ['/browser/response', { text: 'wrong answer' }], ['/browser/response', { error: 'wrong error' }]] as const) {
        expect((await app.inject({ method: 'POST', url, payload: { sessionId: job.id, ...source, ...data } })).statusCode).toBe(403);
      }
    }
    expect(getSession(job.id)).toMatchObject({ status: 'claimed' });
    expect(job.partialText).toBeUndefined(); expect(job.reception).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: job.id, ...owner, text: 'partial', reception } })).json().accepted).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, ...owner, text: 'correct answer' } })).json()).toEqual({ accepted: true, status: 'complete' });
    expect(job.response).toBe('correct answer');
  });

  it('clears previous claim diagnostics and ownership before another tab takes over', async () => {
    const job = session();
    await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: job.id, ...owner, providerHost: 'chatgpt.com' } });
    await app.inject({ method: 'POST', url: '/browser/chunk', payload: { sessionId: job.id, ...owner, text: 'old partial', reception } });
    releaseClaim(job.id);
    expect(job.status).toBe('pending'); expect(job.partialText).toBeUndefined(); expect(job.reception).toBeUndefined(); expect(job.ai).toBeUndefined();
    const nextOwner = { ...owner, tabId: 9 };
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: job.id, ...nextOwner } })).json().claimed).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, ...owner, text: 'old answer' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, ...nextOwner, text: 'new answer' } })).json().accepted).toBe(true);
  });

  it('keeps legacy claims without tab metadata usable', async () => {
    const job = session();
    expect((await app.inject({ method: 'POST', url: '/browser/claim', payload: { sessionId: job.id } })).json().claimed).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, text: 'legacy answer' } })).json().accepted).toBe(true);
  });
});

describe('browser reply transitions', () => {
  it.each([
    ['complete', { text: 'late answer' }], ['complete', { error: 'late failure' }],
    ['error', { text: 'late answer' }], ['error', { error: 'late failure' }],
  ] as const)('does not accept or emit another response after %s: %j', async (status, data) => {
    const job = session();
    if (status === 'complete') completeSession(job.id, 'original answer'); else failSession(job.id, 'Cancelled');
    const original = { ...job };
    const client = { write: vi.fn(), close: vi.fn() };
    addSessionClient(job.id, client);
    const result = await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, ...data } });
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ accepted: false, status });
    expect(job).toEqual(original); expect(client.write).not.toHaveBeenCalled(); expect(client.close).not.toHaveBeenCalled();
  });

  it('notifies a genuine failure once', async () => {
    const job = session(), client = { write: vi.fn(), close: vi.fn() };
    addSessionClient(job.id, client);
    const result = await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, error: 'Page disconnected' } });
    expect(result.json()).toEqual({ accepted: true, status: 'error' });
    expect(job.error).toBe('Page disconnected'); expect(client.write).toHaveBeenCalledOnce(); expect(client.close).toHaveBeenCalledOnce();
  });

  it.each([{ text: { answer: 'invalid' } }, { error: true }, { text: '' }, {}, { text: 'answer', error: 'failure' }])(
    'rejects malformed replies without ending a live job: %j', async (data) => {
      const job = session();
      const result = await app.inject({ method: 'POST', url: '/browser/response', payload: { sessionId: job.id, ...data } });
      expect(result.statusCode).toBe(400); expect(job.status).toBe('pending');
      expect(job.response).toBeUndefined(); expect(job.error).toBeUndefined();
    });
});
