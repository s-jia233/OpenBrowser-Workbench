import fs from 'node:fs/promises';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const finalText = '{"operations":[{"action":"EDIT_FILE","path":"README.md","startLine":576,"endLine":577,"replace":""}],"conversationId":"36dea616-9ff2-40b5-9228-bbcfa05683f4"}';

async function deepSeekCapture(frames: unknown[], interrupted = false) {
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''));
  const messages: any[] = [];
  let finish!: (value: any) => void;
  const completed = new Promise<any>((resolve) => { finish = resolve; });
  const stream = new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    if (!interrupted) controller.close();
  }, pull(controller) { if (interrupted) controller.error(new Error('network interrupted')); } });
  const context = vm.createContext({
    URL, Response, TextDecoder, crypto, console,
    XMLHttpRequest: class { open() {} send() {} },
    window: {
      location: { hostname: 'chat.deepseek.com', origin: 'https://chat.deepseek.com' },
      fetch: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      postMessage(message: any) { messages.push(message); if (['capture-done', 'capture-error'].includes(message.type)) finish(message); },
    },
  });
  vm.runInContext(await fs.readFile(new URL('./src/deepseek-api.js', import.meta.url), 'utf8'), context);
  const response = await context.window.fetch('https://chat.deepseek.com/api/v0/chat/completion', { method: 'POST' });
  await response.text().catch(() => {});
  return { final: await completed, messages };
}

async function contentCapture() {
  vi.useFakeTimers();
  const context = vm.createContext({
    console, Date, setTimeout, clearTimeout, setInterval: () => 0,
    location: { hostname: 'chat.deepseek.com' },
    getProviderForHost: () => ({ name: 'DeepSeek' }),
    window: { addEventListener() {} }, document: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } },
  });
  vm.runInContext(await fs.readFile(new URL('./src/content-script.js', import.meta.url), 'utf8'), context);
  vm.runInContext('beginApiCapture("agent","test-session");handleApiCaptureMessage({type:"capture-begin",captureId:"one",at:Date.now()});', context);
  return context;
}

describe('DeepSeek stream assembly (simulated streams; no external requests)', () => {
  it('keeps the first answer token from BATCH and excludes THINK/THINKING fragments', async () => {
    const result = await deepSeekCapture([
      { v: { response: { fragments: [{ type: 'THINK', content: 'private analysis' }] } } },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: ' more thinking' },
      { v: ' and more' },
      { p: 'response', o: 'BATCH', v: [
        { p: 'fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: finalText.slice(0, 2) }] },
        { p: 'fragments/-1/content', o: 'APPEND', v: finalText.slice(2) },
        { p: 'status', o: 'SET', v: 'FINISHED' },
      ] },
    ]);
    expect(result.final.text).toBe(finalText);
    expect(result.messages.some((message) => message.text?.includes('thinking'))).toBe(false);
  });
  it('supports complete snapshots, indexed SET, compact APPEND, and ignores metadata', async () => {
    const result = await deepSeekCapture([
      { v: { response: { fragments: [{ type: 'THINKING', content: 'analysis' }, { type: 'RESPONSE', content: 'obsolete' }] } } },
      { p: 'response/fragments/1/content', o: 'SET', v: finalText.slice(0, 5) },
      { o: 'APPEND', v: finalText.slice(5, 50) },
      { v: finalText.slice(50) },
      { p: 'response/token_usage', o: 'APPEND', v: 'metadata is not answer text' },
      { p: 'response/status', o: 'SET', v: 'FINISHED' },
    ]);
    expect(result.final.text).toBe(finalText);
  });
  it('does not report interrupted partial text as a completed answer', async () => {
    const result = await deepSeekCapture([{ v: { response: { fragments: [{ type: 'RESPONSE', content: '{"operations":[' }] } } }], true);
    expect(result.final.type).toBe('capture-error');
    expect(result.messages.some((message) => message.type === 'capture-done')).toBe(false);
  });
});

describe('final response selection', () => {
  it('ignores captures initiated before the current turn and late replies from the previous turn', async () => {
    const context = await contentCapture();
    vm.runInContext('endApiCapture();beginApiCapture("ask","second-session");handleApiCaptureMessage({type:"capture-begin",captureId:"late-old",at:Date.now()-1000});handleApiCaptureMessage({type:"capture-done",captureId:"one",text:"old answer"});', context);
    expect(vm.runInContext('apiCapture.candidates.size', context)).toBe(0);
    const pending = vm.runInContext('waitForApiCapturedResponse()', context);
    vm.runInContext('handleApiCaptureMessage({type:"capture-begin",captureId:"new",at:Date.now()});handleApiCaptureMessage({type:"capture-done",captureId:"new",text:"second answer"});', context);
    expect(await pending).toBe('second answer');
  });
  it('fails an empty completed capture promptly instead of holding the tab busy until timeout', async () => {
    const context = await contentCapture();
    vm.runInContext('handleApiCaptureMessage({type:"capture-done",captureId:"one",text:""})', context);
    const outcome = Promise.resolve(vm.runInContext('waitForApiCapturedResponse()', context))
      .then(() => 'resolved', (error) => error.message);
    await vi.advanceTimersByTimeAsync(1);
    const result = await Promise.race([outcome, Promise.resolve('still waiting')]);
    expect(result).toContain('未识别到');
  });
  it('uses a shorter final answer instead of retaining the longer intermediate snapshot', async () => {
    const context = await contentCapture();
    const pending = vm.runInContext('waitForApiCapturedResponse()', context);
    context.answer = finalText;
    vm.runInContext('handleApiCaptureMessage({type:"capture-chunk",captureId:"one",text:"old intermediate text".repeat(100)});handleApiCaptureMessage({type:"capture-done",captureId:"one",text:answer});', context);
    expect(await pending).toBe(finalText);
  });
  it('preserves a completed answer received before the response waiter is registered', async () => {
    const context = await contentCapture(); context.answer = finalText;
    vm.runInContext('handleApiCaptureMessage({type:"capture-done",captureId:"one",text:answer})', context);
    expect(await vm.runInContext('waitForApiCapturedResponse()', context)).toBe(finalText);
  });
  it('rejects an interrupted stream even when interruption precedes waiter registration', async () => {
    const context = await contentCapture();
    vm.runInContext('handleApiCaptureMessage({type:"capture-error",captureId:"one"})', context);
    await expect(vm.runInContext('waitForApiCapturedResponse()', context)).rejects.toThrow('中断');
  });
});
