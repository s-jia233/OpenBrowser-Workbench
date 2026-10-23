import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTrustedBridgeOrigin, clearSseHub, recordBrowserHeartbeat, browserConnectionStatus, addBrowserClient, removeBrowserClient, broadcastBrowserJob } from './sse-hub.js';
import { clearSessions, createSession, tryClaimSession, failSession, completeSession, getSession } from './session-store.js';

afterEach(() => { clearSseHub(); clearSessions(); vi.useRealTimers(); });

describe('isTrustedBridgeOrigin', () => {
  it('allows local non-browser clients and Chrome extensions', () => {
    expect(isTrustedBridgeOrigin()).toBe(true);
    expect(isTrustedBridgeOrigin('chrome-extension://abcdefghijklmnop')).toBe(true);
  });

  it('rejects ordinary and malformed web origins', () => {
    expect(isTrustedBridgeOrigin('https://example.com')).toBe(false);
    expect(isTrustedBridgeOrigin('null')).toBe(false);
  });
});

describe('extension reconnects', () => {
  it('aggregates known ready providers, expires them and does not guess missing legacy identities', () => {
    vi.useFakeTimers();
    recordBrowserHeartbeat('legacy-instance', 1);
    expect(browserConnectionStatus().providers).toEqual([]);
    expect(browserConnectionStatus().identityReported).toBe(false);
    recordBrowserHeartbeat('new-instance', 2, ['chat.deepseek.com', 'chatgpt.com']);
    expect(browserConnectionStatus().providers.map((provider) => provider.name)).toEqual(['DeepSeek', 'ChatGPT']);
    recordBrowserHeartbeat('new-instance', 0, ['chat.deepseek.com']);
    expect(browserConnectionStatus().providers).toEqual([]);
    recordBrowserHeartbeat('new-instance', 1, ['untrusted.example']);
    expect(browserConnectionStatus().providers).toEqual([]);
    vi.advanceTimersByTime(46000);
    expect(browserConnectionStatus().state).toBe('disconnected');
    expect(browserConnectionStatus().providers).toEqual([]);
  });
  it('does not let a late reply or duplicate failure overwrite a finished session', () => {
    const first = createSession({ mode: 'ask', prompt: 'hello', systemPrompt: '', message: 'hello', composerMessage: 'hello', delivery: 'text', conversationId: 'conversation' });
    failSession(first.id, 'Cancelled');
    expect(completeSession(first.id, 'Late response')).toBeUndefined();
    expect(getSession(first.id)?.status).toBe('error');
    const second = createSession({ mode: 'ask', prompt: 'hello', systemPrompt: '', message: 'hello', composerMessage: 'hello', delivery: 'text', conversationId: 'conversation' });
    completeSession(second.id, 'Correct answer');
    expect(failSession(second.id, 'Other tab could not claim')).toBeUndefined();
    expect(getSession(second.id)?.response).toBe('Correct answer');
  });
  it('keeps a stable instance count during stream reconnects and distinguishes AI readiness', () => {
    vi.useFakeTimers();
    recordBrowserHeartbeat('test-extension-id', 1);
    const first = { write: vi.fn(), close: vi.fn() }, second = { write: vi.fn(), close: vi.fn() };
    addBrowserClient(first, 'test-extension-id'); addBrowserClient(second, 'test-extension-id');
    expect(first.close).toHaveBeenCalledOnce();
    expect(browserConnectionStatus()).toMatchObject({ browserConnections: 1, transportConnections: 1, readyTabs: 1, state: 'ready' });
    removeBrowserClient(second);
    expect(browserConnectionStatus().state).toBe('ready');
    recordBrowserHeartbeat('test-extension-id', 0);
    expect(browserConnectionStatus().state).toBe('no_tab');
    vi.advanceTimersByTime(46_000);
    expect(browserConnectionStatus()).toMatchObject({ browserConnections: 0, state: 'disconnected' });
  });

  it('replays unclaimed jobs after reconnect but never replays a claimed job', () => {
    const session = createSession({ mode: 'ask', prompt: 'hello', systemPrompt: '', message: 'hello', composerMessage: 'hello', delivery: 'text', conversationId: 'conversation' });
    const first = { write: vi.fn(), close: vi.fn() }, second = { write: vi.fn(), close: vi.fn() };
    addBrowserClient(first, 'same-extension');
    broadcastBrowserJob({ sessionId: session.id, mode: 'ask', message: 'hello', composerMessage: 'hello', delivery: 'text', systemPrompt: '', conversationId: 'conversation' });
    removeBrowserClient(first); addBrowserClient(second, 'same-extension');
    expect(second.write.mock.calls.some(([text]) => text.includes('event: job'))).toBe(true);
    expect(tryClaimSession(session.id)).not.toBeNull(); expect(tryClaimSession(session.id)).toBeNull();
    second.write.mockClear(); removeBrowserClient(second); addBrowserClient(second, 'same-extension');
    expect(second.write.mock.calls.some(([text]) => text.includes('event: job'))).toBe(false);
  });
});
