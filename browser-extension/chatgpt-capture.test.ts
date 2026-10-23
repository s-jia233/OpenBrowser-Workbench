import fs from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseAIResponse } from '../src/parser/index.js';

// Only synthetic SSE data is used; no provider requests or page interaction.
async function captureHarness() {
  const messages: any[] = [], queue: { wire: string; interrupted?: boolean }[] = [];
  const context = vm.createContext({
    URL, Response, TextDecoder, crypto, console,
    window: {
      location: { hostname: 'chatgpt.com', origin: 'https://chatgpt.com' },
      fetch: async () => {
        const next = queue.shift()!;
        const bytes = new TextEncoder().encode(next.wire);
        let offset = 0;
        const stream = new ReadableStream({ pull(controller) {
          if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + 7)); offset += 7; }
          else if (next.interrupted) controller.error(new Error('network interrupted'));
          else controller.close();
        } });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
      postMessage: (message: any) => { messages.push(message); },
    },
  });
  vm.runInContext(await fs.readFile(new URL('./src/chatgpt-api.js', import.meta.url), 'utf8'), context);
  async function request(wire: string, path = '/backend-api/f/conversation', interrupted = false) {
    queue.push({ wire, interrupted });
    const start = messages.length;
    const response = await context.window.fetch(`https://chatgpt.com${path}`, { method: 'POST' });
    await response.text().catch(() => {});
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    const current = messages.slice(start);
    return { messages: current, final: current.findLast((message) => ['capture-done', 'capture-error'].includes(message.type)) };
  }
  return { request };
}

const frame = (data: unknown, event = 'delta') => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const snapshot = (text: string, extra = {}) => ({ message: {
  id: 'answer', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, ...extra,
} });
const done = 'data: [DONE]\n\n';

describe('ChatGPT passive reply capture', () => {
  it('does not stop reading at a per-message completion marker before a later final snapshot', async () => {
    const h = await captureHarness();
    const conversationId = 'a8560f99-77db-4639-82d9-1bf61eb12d45';
    const reply = JSON.stringify({ conversationId, operations: [], error: '请明确 README.md 的具体修改要求。' });
    const prefix = reply.slice(0, 76);
    const result = await h.request(frame({ v: snapshot(prefix) })
      + frame({ type: 'message_stream_complete' }) + frame({ v: snapshot(reply) }) + done);
    expect(result.final?.text).toBe(reply);
    expect(parseAIResponse(result.final!.text, { conversationId }).error).toContain('具体修改');
  });
  it('does not stop after a finished snapshot if the same response transport still supplies a final authoritative snapshot', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('prefix', { status: 'finished_successfully', end_turn: true }) })
      + frame({ v: snapshot('complete final', { status: 'finished_successfully', end_turn: true }) }) + done);
    expect(result.final?.text).toBe('complete final');
  });
  it('does not inherit an old completion after a new unfinished message snapshot', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('previous message') }) + frame({ type: 'message_stream_complete' })
      + frame({ v: snapshot('new incomplete message', { id: 'new-answer' }) }));
    expect(result.final?.type).toBe('capture-error');
  });
  it('does not inherit an old completion if text continues but no later end signal arrives', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('prefix') }) + frame({ type: 'message_stream_complete' })
      + frame({ p: '/message/content/parts/0', o: 'append', v: ' unfinished suffix' }));
    expect(result.final?.type).toBe('capture-error');
    const withMetadata = await h.request(frame({ v: snapshot('prefix', { status: 'finished_successfully', end_turn: true }) })
      + frame({ p: '/message/content/parts/0', o: 'append', v: ' unfinished suffix' })
      + frame({ p: '/message/metadata', o: 'replace', v: { note: 'not a completion signal' } }));
    expect(withMetadata.final?.type).toBe('capture-error');
  });
  it('honors the global DONE sentinel instead of reading content beyond the completed response', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('actual answer') }) + done + frame({ v: snapshot('not part of this answer') }));
    expect(result.final?.text).toBe('actual answer');
  });
  it('recognizes typed completion metadata even when the SSE event is delta', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('final answer') }) + frame({ type: 'message_stream_complete' }));
    expect(result.final?.type).toBe('capture-done'); expect(result.final?.text).toBe('final answer');
  });
  it('recognizes an explicit completion event without requiring DONE or a final full snapshot', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('final answer') }) + frame({}, 'message_stream_complete'));
    expect(result.final?.type).toBe('capture-done'); expect(result.final?.text).toBe('final answer');
  });
  it('recognizes separate final status and end_turn patches only when both confirm completion', async () => {
    const h = await captureHarness();
    const initial = frame({ v: snapshot('final answer') });
    const status = frame({ p: '/message/status', o: 'replace', v: 'finished_successfully' });
    const end = frame({ p: '/message/end_turn', o: 'replace', v: true });
    expect((await h.request(initial + status)).final?.type).toBe('capture-error');
    expect((await h.request(initial + end)).final?.type).toBe('capture-error');
    expect((await h.request(initial + status + end)).final?.text).toBe('final answer');
    expect((await h.request(initial + end + status)).final?.text).toBe('final answer');
  });
  it('does not append a nested parts metadata path to final source text', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('final answer') })
      + frame({ p: '/message/content/parts/0/metadata', o: 'append', v: 'not source' }) + done);
    expect(result.final?.text).toBe('final answer');
  });
  it('preserves the final assistant message ID for exact current-turn DOM correlation', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('reasoning', { id: 'analysis-id', channel: 'analysis' }) })
      + frame({ v: snapshot('{"conversationId":"example"', { id: 'final-id', channel: 'final' }) }) + done);
    expect(result.final?.messageId).toBe('final-id');
    expect(result.final?.text).toBe('{"conversationId":"example"');
    expect(result.messages.some((message) => message.messageId === 'analysis-id')).toBe(false);
  });
  it('carries a completed final message ID even when the stream text is empty', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('', { id: 'empty-final', channel: 'final' }) }) + done);
    expect(result.final?.messageId).toBe('empty-final');
    expect(result.final?.text).toBe('');
  });
  it('reassembles the reported initial escape fragment plus unlabeled compact data frames into a clarification', async () => {
    const h = await captureHarness();
    const conversationId = 'aafa3c58-e443-4c2c-82eb-c6dd8c657f88';
    const reply = JSON.stringify({ conversationId, error: '请说明希望对 README.md 进行哪些具体修改？例如更新项目介绍、功能特性、安装运行步骤、使用教程或项目架构。', operations: [] });
    let wire = frame({ v: snapshot('<escape>{"') });
    for (let index = 2; index < reply.length; index += 5) wire += `data: ${JSON.stringify({ v: reply.slice(index, index + 5) })}\n\n`;
    const result = await h.request(wire + done);
    expect(result.final?.text).toBe('<escape>' + reply);
    const parsed = parseAIResponse(result.final!.text, { conversationId });
    expect(parsed.operations).toEqual([]);
    expect(parsed.error).toContain('请说明希望');
  });
  it('does not append unrelated typed metadata while accepting unlabeled compact patches', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('answer') }) + 'data: {"type":"heartbeat","v":"not answer text"}\n\n'
      + 'data: {"o":"append","p":"/message/content/parts/0","v":" continued"}\n\n' + done);
    expect(result.final?.text).toBe('answer continued');
  });
  it('handles two consecutive requests independently without retaining the first answer', async () => {
    const h = await captureHarness();
    const first = await h.request(frame({ v: snapshot('first answer') }) + done);
    const second = await h.request(frame({ v: snapshot('second answer') }) + done);
    expect(first.final?.text).toBe('first answer');
    expect(second.final?.text).toBe('second answer');
    expect(first.final?.captureId).not.toBe(second.final?.captureId);
  });
  it('handles CRLF frame separators split between transport chunks', async () => {
    const h = await captureHarness();
    const result = await h.request((frame({ v: snapshot('第一行\n第二行') }) + done).replaceAll('\n', '\r\n'));
    expect(result.final?.text).toBe('第一行\n第二行');
  });
  it('accepts standard message snapshots on the alternate conversation path', async () => {
    const h = await captureHarness();
    const result = await h.request(frame(snapshot('standard answer'), 'message') + done, '/backend-api/conversation');
    expect(result.final?.text).toBe('standard answer');
  });
  it('assembles a batch of patches and handles replacement, not duplicate appending', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('obsolete') }) + frame({ p: '', o: 'patch', v: [
      { p: '/message/content/parts/0', o: 'replace', v: 'new' },
      { p: '/message/content/parts/0', o: 'append', v: ' answer' },
    ] }) + done);
    expect(result.final?.text).toBe('new answer');
  });
  it('uses the final full snapshot even if it is shorter than previous partial text', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('very long intermediate answer') }) + frame({ v: snapshot('final') }) + done);
    expect(result.final?.text).toBe('final');
  });
  it('does not include analysis, tool output or user messages in the final answer', async () => {
    const h = await captureHarness();
    const result = await h.request(
      frame({ v: snapshot('private reasoning', { channel: 'analysis' }) })
      + frame({ p: '/message/content/parts/0', o: 'append', v: ' more reasoning' })
      + frame({ v: snapshot('tool data', { author: { role: 'tool' } }) })
      + frame({ v: snapshot('quoted user prompt', { author: { role: 'user' } }) })
      + frame({ v: snapshot('answer', { id: 'final-answer', channel: 'final' }) }) + done,
    );
    expect(result.final?.text).toBe('answer');
    expect(result.messages.some((message) => /reasoning|tool data|quoted user/.test(message.text || ''))).toBe(false);
  });
  it('reports an interrupted partial response as an error, not a completed answer', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('{"operations":[') }), undefined, true);
    expect(result.final?.type).toBe('capture-error');
    expect(result.messages.some((message) => message.type === 'capture-done')).toBe(false);
  });
  it('supports a channel switch to final in the same message without leaking analysis', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('hidden', { channel: 'analysis' }) }) + frame({ p: '/message/channel', o: 'replace', v: 'final' })
      + frame({ p: '/message/content/parts/0', o: 'replace', v: 'visible final answer' }) + done);
    expect(result.final?.text).toBe('visible final answer');
    expect(result.messages.some((message) => message.text?.includes('hidden'))).toBe(false);
  });
  it('does not promote an unterminated partial stream to a completed answer', async () => {
    const h = await captureHarness();
    const result = await h.request(frame({ v: snapshot('unfinished answer') }));
    expect(result.final?.type).toBe('capture-error');
  });
});
