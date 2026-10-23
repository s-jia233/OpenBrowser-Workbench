import fs from 'node:fs/promises';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function lifecycle() {
  vi.useFakeTimers();
  const runs: string[] = [], replies: any[] = [], requests: string[] = [];
  const sessions = new Map<string, string>([['first', 'pending'], ['second', 'pending']]);
  let releaseReport!: () => void;
  const reportGate = new Promise<void>((resolve) => { releaseReport = resolve; });
  const control = { rejectFirstReport: false };
  const context = vm.createContext({
    console: { warn() {} }, Date, setTimeout, clearTimeout, setInterval: () => 0,
    location: { hostname: 'chatgpt.com' },
    getProviderForHost: () => ({ name: 'ChatGPT' }),
    window: { addEventListener() {} }, document: { addEventListener() {} },
    runs,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async (message: any) => {
      if (message.type !== 'BRIDGE_REQUEST') return { ok: true };
      const { path } = message; requests.push(path);
      const body = JSON.parse(message.init?.body ?? '{}');
      if (path === '/browser/claim') {
        if (sessions.get(body.sessionId) !== 'pending') return { ok: true, data: { claimed: false } };
        sessions.set(body.sessionId, 'claimed');
        return { ok: true, data: { claimed: true, job: { sessionId: body.sessionId, mode: 'ask' } } };
      }
      if (path.startsWith('/session/')) return { ok: true, data: { status: sessions.get(path.split('/')[2]) } };
      if (path === '/browser/response') {
        if (body.sessionId === 'first' && control.rejectFirstReport) {
          await reportGate; return { ok: false, error: 'local bridge unavailable' };
        }
        replies.push(body); sessions.set(body.sessionId, body.error ? 'error' : 'complete');
        return { ok: true, data: { accepted: true } };
      }
      return { ok: true, data: {} };
    } } },
  });
  vm.runInContext(await fs.readFile(new URL('./src/content-script.js', import.meta.url), 'utf8'), context);
  const run = (source: string) => vm.runInContext(source, context);
  const start = (id: string) => Promise.resolve(run(`handleIncomingJob({sessionId:${JSON.stringify(id)}})`)).catch((error) => error);
  return { run, start, sessions, runs, replies, requests, control, releaseReport };
}

describe('browser turn lifecycle (no real AI calls)', () => {
  it('releases a cancelled first capture and runs the queued follow-up without refreshing the page', async () => {
    const h = await lifecycle();
    h.run('processJob = async (job) => { runs.push(job.sessionId); if (job.sessionId === "first") { beginApiCapture("ask", job.sessionId); await waitForApiCapturedResponse(); } };');
    const first = h.start('first'); await vi.advanceTimersByTimeAsync(0);
    h.sessions.set('first', 'error');
    const second = h.start('second'); await vi.advanceTimersByTimeAsync(0);
    expect(h.runs).toEqual(['first', 'second']);
    await Promise.all([first, second]);
    expect(h.replies.some((reply) => reply.sessionId === 'first')).toBe(false);
    expect(h.run('running')).toBe(false);
  });
  it('does not replace a genuinely active first request or submit a duplicate queued turn', async () => {
    const h = await lifecycle();
    h.run('processJob = async (job) => { runs.push(job.sessionId); if (job.sessionId === "first") { beginApiCapture("ask", job.sessionId); await waitForApiCapturedResponse(); } };');
    const first = h.start('first'); await vi.advanceTimersByTimeAsync(0);
    await Promise.all([h.start('second'), h.start('second')]);
    expect(h.runs).toEqual(['first']);
    h.run('handleApiCaptureMessage({type:"capture-begin",captureId:"one",at:Date.now()}); handleApiCaptureMessage({type:"capture-done",captureId:"one",text:"first answer"});');
    await first;
    expect(h.runs).toEqual(['first', 'second']);
    expect(h.run('running')).toBe(false);
  });
  it('does not strand the next turn when reporting the previous result fails', async () => {
    const h = await lifecycle(); h.control.rejectFirstReport = true;
    h.run('processJob = async (job) => { runs.push(job.sessionId); await postBrowserResponse({sessionId:job.sessionId,text:"answer"}); };');
    const first = h.start('first'); await vi.advanceTimersByTimeAsync(0);
    await h.start('second');
    h.releaseReport(); await vi.advanceTimersByTimeAsync(0); await first;
    expect(h.runs).toEqual(['first', 'second']);
    expect(h.run('running')).toBe(false);
  });
  it('stops a locally cancelled job before its delayed input step', async () => {
    const h = await lifecycle();
    h.run('processJob = async (job) => { if (job.sessionId === "first") await sleep(500); runs.push(job.sessionId); };');
    const first = h.start('first'); await vi.advanceTimersByTimeAsync(0);
    h.sessions.set('first', 'error');
    const second = h.start('second'); await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(h.runs).toEqual(['second']);
  });
});
