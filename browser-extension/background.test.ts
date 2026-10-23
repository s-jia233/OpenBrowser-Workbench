import fs from 'node:fs/promises';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

async function worker(ready = true) {
  vi.useFakeTimers();
  const requests: { url: string; body?: string }[] = [];
  const sent: string[] = [];
  const handlers: Record<string, (...args: any[]) => void> = {};
  const context = vm.createContext({
    console: { info() {}, warn() {} }, crypto, AbortController, AbortSignal, TextDecoder, Date, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: {
      storage: { local: { get: async () => ({ bridgeClientId: 'stable-test-instance' }), set: async () => {} } },
      runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn: any) { handlers.message = fn; } } },
      alarms: { create: vi.fn(), onAlarm: { addListener(fn: any) { handlers.alarm = fn; } } },
      tabs: {
        query: async () => [{ id: 1, url: 'https://chatgpt.com/' }],
        sendMessage: async (_id: number, message: { type: string; job?: { sessionId: string } }) => {
          if (message.type === 'OPENBROWSER_STATUS') return { ready };
          sent.push(message.job!.sessionId); return { ok: true };
        },
      },
    },
    fetch: async (url: string, init: { body?: string; signal?: AbortSignal } = {}) => {
      requests.push({ url, body: init.body });
      if (url.includes('/browser/events')) {
        return { ok: true, body: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('event: connected\ndata: {"ok":true}\n\n'));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        } }) };
      }
      return { ok: true, text: async () => '{}' };
    },
  });
  vm.runInContext(await fs.readFile(new URL('./src/background.js', import.meta.url), 'utf8'), context);
  // Flush boot promises without advancing idle/heartbeat timers.
  for (let n = 0; n < 30; n++) await Promise.resolve();
  return { context, requests, sent, handlers };
}

describe('extension transport (no external model requests)', () => {
  it('bounds local bridge requests and preserves an explicitly supplied timeout signal', async () => {
    const state = await worker();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await vm.runInContext('bridgeRequest("/test-local-timeout", {})', state.context);
      expect(timeout).toHaveBeenCalledWith(10_000);
      timeout.mockClear();
      await vm.runInContext('bridgeRequest("/test-explicit-timeout", {signal:new AbortController().signal})', state.context);
      expect(timeout).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });
  it('uses a persistent instance id, publishes actual page readiness and reconnects a stale stream', async () => {
    const state = await worker();
    expect(state.requests.find((request) => request.url.includes('/browser/events'))?.url).toContain('clientId=stable-test-instance');
    expect(JSON.parse(state.requests.find((request) => request.url.endsWith('/heartbeat'))!.body!)).toEqual({ clientId: 'stable-test-instance', readyTabs: 1, readyHosts: ['chatgpt.com'], readyPages: [{ tabId: 1, host: 'chatgpt.com' }] });
    await vi.advanceTimersByTimeAsync(53_000);
    expect(state.requests.filter((request) => request.url.includes('/browser/events')).length).toBeGreaterThan(1);
  });

  it('does not deliver to an unready page and de-duplicates concurrent job delivery', async () => {
    const offline = await worker(false);
    await vm.runInContext('dispatchJob({sessionId:"not-ready"})', offline.context);
    expect(offline.sent).toEqual([]);
    expect(JSON.parse(offline.requests.find((request) => request.url.endsWith('/heartbeat'))!.body!).readyTabs).toBe(0);
    const online = await worker(true);
    await vm.runInContext('Promise.all([dispatchJob({sessionId:"one-job"}),dispatchJob({sessionId:"one-job"})])', online.context);
    await vm.runInContext('dispatchJob({sessionId:"one-job"})', online.context);
    expect(online.sent).toEqual(['one-job']);
  });
  it('reports the claiming tab hostname, not arbitrary page titles or supplied provider names', async () => {
    const state = await worker();
    await new Promise<void>((resolve) => {
      state.handlers.message({ type: 'BRIDGE_REQUEST', path: '/browser/claim', init: { method: 'POST', body: JSON.stringify({ sessionId: 'test', providerHost: 'chatgpt.com' }) } },
        { tab: { url: 'https://chat.deepseek.com/a/chat/private-conversation' } }, () => resolve());
    });
    const claim = state.requests.find((request) => request.url.endsWith('/browser/claim'))!;
    expect(JSON.parse(claim.body!)).toEqual({ sessionId: 'test', providerHost: 'chat.deepseek.com', clientId: 'stable-test-instance' });
    expect(claim.body).not.toContain('private-conversation');
  });
  it('dispatches only to the selected tab and ignores jobs assigned to other browser instances', async () => {
    const state = await worker();
    await vm.runInContext('dispatchJob({sessionId:"other-client",target:{clientId:"another-instance",tabId:1}})', state.context);
    await vm.runInContext('dispatchJob({sessionId:"other-tab",target:{clientId:"stable-test-instance",tabId:2}})', state.context);
    expect(state.sent).toEqual([]);
    await vm.runInContext('dispatchJob({sessionId:"correct-target",target:{clientId:"stable-test-instance",tabId:1}})', state.context);
    expect(state.sent).toEqual(['correct-target']);
  });
});
