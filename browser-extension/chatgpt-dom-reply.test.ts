import fs from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAIResponse } from '../src/parser/index.js';
import { WorkbenchService, taskInput } from '../src/workbench/service.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const conversationId = '555412f2-d53c-4ae4-9872-80f9090ab2e5';
const toolReply = JSON.stringify({ conversationId, operations: [], toolRequests: [{ tool: 'read_file', path: 'README.md' }] });

async function page() {
  // Keep filesystem scheduling (setImmediate) real for workbench integration.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const sent: any[] = [];
  const state = { users: [] as any[], assistants: [] as any[], articleUsers: [] as any[], articleAssistants: [] as any[], dilAssistants: [] as any[], busy: false, hiddenStop: false, complete: false };
  function node(id: string, order: number, text = ''): any {
    return {
      id, order, innerText: text, textContent: text,
      getAttribute(key: string) { return key === 'data-message-id' ? this.id : null; },
      getBoundingClientRect: () => ({ width: 100, height: 40 }),
      compareDocumentPosition: (other: any) => other.order > order ? 4 : 2,
      closest(selector: string) { return selector === 'article' ? this : null; },
      querySelectorAll(selector: string) {
        if (selector.includes('copy-turn-action-button')) return state.complete ? [node('copy', order + 0.1)] : [];
        return [];
      },
      querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; },
    };
  }
  const stop = node('stop', 100);
  const document = {
    addEventListener() {},
    querySelectorAll(selector: string) {
      if (selector === '[data-message-author-role="assistant"]') return state.assistants;
      if (selector === '[data-message-author-role="user"]') return state.users;
      if (selector === 'article[data-turn="user"]') return state.articleUsers;
      if (selector === 'article[data-turn="assistant"]') return state.articleAssistants;
      if (selector === '[data-markdown-text-style="assistant-message"]') return state.dilAssistants;
      if (selector === '[data-testid="stop-button"]') return state.busy || state.hiddenStop ? [stop] : [];
      return [];
    },
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; },
  };
  const context = vm.createContext({
    console: { info() {}, warn() {} }, Date, setTimeout, clearTimeout, setInterval: () => 0,
    location: { hostname: 'chatgpt.com' }, document,
    window: { addEventListener() {}, getComputedStyle: (element: any) => ({
      display: element === stop && state.hiddenStop && !state.busy ? 'none' : 'block', visibility: 'visible', opacity: '1',
    }) },
    chrome: { runtime: { getManifest: () => ({ version: '0.8.13' }), onMessage: { addListener() {} }, sendMessage: async (message: any) => { sent.push(message); return { ok: true }; } } },
    job: { sessionId: 'test-current-turn', conversationId, mode: 'agent' },
  });
  vm.runInContext(await fs.readFile(new URL('./src/providers.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await fs.readFile(new URL('./src/content-script.js', import.meta.url), 'utf8'), context);
  const run = (code: string) => vm.runInContext(code, context);
  function start() { run('baseline = snapshotChatGptTurn(); beginApiCapture(job.mode, job.sessionId);'); }
  function capture(text: string | null, messageId?: string) {
    context.captureText = text;
    context.messageId = messageId;
    run('handleApiCaptureMessage({type:"capture-begin",captureId:"one",at:Date.now()});handleApiCaptureMessage(captureText === null ? {type:"capture-error",captureId:"one"} : {type:"capture-done",captureId:"one",text:captureText,messageId});');
  }
  async function receive() {
    const pending = Promise.resolve(run('receiveChatGptReply(job, baseline, {timeoutMs:6000})'))
      .then((value) => ({ value, error: undefined }), (error) => ({ value: undefined, error }));
    await vi.runAllTimersAsync();
    return pending;
  }
  return { state, node, run, start, capture, receive, context, sent };
}

// Match the user's inspected markup: a semantic assistant markdown root,
// selection owner, DIL renderer/source ID and multiple inline word spans.
function dilAnswer(p: Awaited<ReturnType<typeof page>>, id: string, order: number, words: string[]) {
  const root = p.node('', order), owner = p.node('', order), renderer = p.node('', order);
  root.innerText = words.join(''); root.textContent = words.join('');
  root.getAttribute = (key: string) => key === 'data-markdown-text-style' ? 'assistant-message' : null;
  owner.getAttribute = (key: string) => key === 'data-chatgpt-selection-message-id' ? id : null;
  renderer.getAttribute = (key: string) => ['data-dil-message-id', 'data-dil-source-message-id'].includes(key) ? id : null;
  root.closest = (selector: string) => selector === '[data-chatgpt-selection-message-id]' ? owner : null;
  root.querySelectorAll = (selector: string) => selector === '[data-dil-message-id], [data-dil-source-message-id]' ? [renderer] : [];
  root.querySelector = (selector: string) => root.querySelectorAll(selector)[0] ?? null;
  return { root, owner, renderer };
}

describe('current-turn ChatGPT DOM reply recovery (simulated DOM; no real provider requests)', () => {
  it('receives a DIL clarification then a second-turn edit in the actual workbench, without resending or applying files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-dil-recovery-'));
    const original = '# Example\n\nDocument body.\n';
    await fs.writeFile(path.join(root, 'README.md'), original);
    const service = new WorkbenchService(root);
    try {
      const task = await service.create(taskInput.parse({ prompt: '修改这个文件', mode: 'agent', delivery: 'manual', contextPaths: ['README.md'] }));
      const p = await page(); p.context.job.conversationId = task.conversationId; p.start();
      const question = '已识别目标文件 README.md。请明确具体修改要求。';
      const clarification = JSON.stringify({ conversationId: task.conversationId, operations: [], error: question });
      p.state.dilAssistants.push(dilAnswer(p, 'dil-turn-one', 1, [clarification.slice(0, 76), clarification.slice(76)]).root);
      p.capture(clarification.slice(0, 76), 'dil-turn-one');
      const first = await p.receive(); expect(first.error).toBeUndefined();
      await service.acceptResponse(task.id, first.value!);
      expect(task.error).toBe(question); expect(task.attempt).toBe(1); expect(task.plans).toEqual([]);
      await service.followUp(task.id, taskInput.parse({ prompt: '把 Document body. 改为 Updated body.', mode: 'agent', delivery: 'manual', contextPaths: ['README.md'] }));
      p.start();
      const proposal = JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'README.md', search: 'Document body.', replace: 'Updated body.' }] });
      p.state.dilAssistants.push(dilAnswer(p, 'dil-turn-two', 3, [proposal.slice(0, 76), proposal.slice(76)]).root);
      p.capture(proposal.slice(0, 76), 'dil-turn-two');
      const second = await p.receive(); expect(second.error).toBeUndefined(); expect(second.value).toBe(proposal);
      await service.acceptResponse(task.id, second.value!);
      expect(task.status).toBe('review'); expect(task.plans).toHaveLength(1);
      expect(task.turns[0].error).toBe(question);
      expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe(original);
    } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('recovers the supplied split-word DIL clarification without any legacy user or assistant nodes', async () => {
    const p = await page(); p.start();
    const reply = JSON.stringify({ conversationId, operations: [], error: '已识别目标文件 README.md。请明确具体修改要求：是修复 Markdown 格式与链接错误、优化项目介绍、更新功能说明，还是重新组织文档结构？' });
    const answer = dilAnswer(p, 'bb082af1-398f-4783-9c1d-1d2720e47ae3', 3, [reply.slice(0, 76), reply.slice(76, 101), reply.slice(101)]);
    p.state.dilAssistants.push(answer.root); p.capture(reply.slice(0, 76), 'bb082af1-398f-4783-9c1d-1d2720e47ae3');
    const result = await p.receive(); expect(result.error).toBeUndefined(); expect(result.value).toBe(reply);
    expect(parseAIResponse(result.value!, { conversationId }).error).toContain('重新组织文档结构');
  });
  it('uses the source/renderer message ID when no selection owner is available', async () => {
    const p = await page(); p.start(); const answer = dilAnswer(p, 'dil-current', 3, [toolReply]);
    answer.root.closest = () => null; p.state.dilAssistants.push(answer.root); p.capture(toolReply.slice(0, 76), 'dil-current');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('rejects a DIL answer with a different captured message ID even if its conversation ID matches', async () => {
    const p = await page(); p.start(); p.state.dilAssistants.push(dilAnswer(p, 'different-answer', 3, [toolReply]).root);
    p.capture(toolReply.slice(0, 76), 'dil-current'); expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('does not recover a remounted old DIL answer from a follow-up with the same conversation ID', async () => {
    const p = await page(); p.state.dilAssistants.push(dilAnswer(p, 'old-answer', 1, [toolReply]).root); p.start();
    p.state.dilAssistants = [dilAnswer(p, 'old-answer', 3, [toolReply]).root]; p.capture(toolReply.slice(0, 76), 'old-answer');
    expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('does not guess between contradictory DIL source and selection IDs', async () => {
    const p = await page(); p.start(); const answer = dilAnswer(p, 'current-answer', 3, [toolReply]);
    answer.renderer.getAttribute = (key: string) => key === 'data-dil-message-id' ? 'conflicting-answer' : null;
    p.state.dilAssistants.push(answer.root); p.capture(toolReply.slice(0, 76), 'current-answer');
    expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('accepts an explicit non-streaming final DOM state without SSE or test-id footer controls', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
    const answer = p.node('current-answer', 3, toolReply), attr = answer.getAttribute.bind(answer);
    answer.getAttribute = (key: string) => key === 'data-is-streaming' ? 'false' : attr(key);
    p.state.assistants.push(answer);
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('does not treat explicit non-streaming metadata as finished while a visible Stop control remains', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2)); p.state.busy = true;
    const answer = p.node('current-answer', 3, toolReply), attr = answer.getAttribute.bind(answer);
    answer.getAttribute = (key: string) => key === 'data-is-streaming' ? 'false' : attr(key);
    p.state.assistants.push(answer);
    expect((await p.receive()).error?.message).toContain('捕获不完整');
  });
  for (const label of ['复制', 'Copy response', '複製回覆']) {
    it(`recognizes an enabled ${label} footer outside the body without clicking it`, async () => {
      const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
      const answer = p.node('current-answer', 3, toolReply), owner = p.node('article', 3), copy = p.node('copy', 4);
      copy.getAttribute = (key: string) => key === 'aria-label' ? label : null;
      copy.click = () => { throw new Error('Do not click copy'); };
      owner.querySelectorAll = (selector: string) => selector === 'button[aria-label], button[title]' ? [copy] : [];
      answer.closest = (selector: string) => selector === 'article' ? owner : null;
      p.state.assistants.push(answer);
      expect((await p.receive()).value).toBe(toolReply);
    });
  }
  it('never treats a code Copy button within the reply body as generation completion', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
    const answer = p.node('current-answer', 3, toolReply), owner = p.node('article', 3), copy = p.node('copy', 4);
    copy.getAttribute = (key: string) => key === 'aria-label' ? '复制' : null;
    owner.querySelectorAll = (selector: string) => selector === 'button[aria-label], button[title]' ? [copy] : [];
    answer.closest = (selector: string) => selector === 'article' ? owner : null;
    answer.contains = (other: unknown) => other === copy; p.state.assistants.push(answer);
    expect((await p.receive()).error?.message).toContain('捕获不完整');
  });
  it('reports bounded metadata while stuck without leaking prompt, reply, message ID or sending requests to a model', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
    p.state.assistants.push(p.node('current-answer', 3, toolReply));
    expect((await p.receive()).error?.message).toContain('捕获不完整');
    const reports = p.sent.filter((entry) => entry.path === '/browser/chunk').map((entry) => JSON.parse(entry.init.body));
    expect(reports.length).toBeGreaterThan(0); expect(reports.length).toBeLessThanOrEqual(3);
    expect(reports[0].reception).toMatchObject({ version: '0.8.13', stream: 'pending', reason: 'awaiting_completion', currentUsers: 1, assistants: 1 });
    expect(JSON.stringify(reports)).not.toContain(conversationId); expect(JSON.stringify(reports)).not.toContain('README.md');
    expect(JSON.stringify(reports)).not.toContain('current-answer'); expect(reports[0].text).toBeUndefined();
  });
  it('collects mixed old role markup and new article markup instead of stopping at the first selector', async () => {
    const p = await page();
    p.state.users.push(p.node('old-user', 0)); p.state.assistants.push(p.node('old-answer', 1, toolReply)); p.start();
    p.state.articleUsers.push(p.node('current-user', 2)); p.state.articleAssistants.push(p.node('current-answer', 3, toolReply));
    p.capture('{"conversationId":"' + conversationId + '"');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('recovers the exact assistant message identified by this completed capture when the user node is not available', async () => {
    const p = await page(); p.start();
    p.state.assistants.push(p.node('current-answer', 3, toolReply));
    p.capture('{"conversationId":"' + conversationId + '"', 'current-answer');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('can correlate a completed empty capture by message ID without a user node', async () => {
    const p = await page(); p.start();
    p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('', 'current-answer');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('does not bind a message ID from a request begun before the local turn', async () => {
    const p = await page(); p.start(); p.state.complete = true;
    p.state.assistants.push(p.node('old-capture-answer', 3, toolReply));
    p.run('handleApiCaptureMessage({type:"capture-begin",captureId:"old",at:Date.now()-1000});handleApiCaptureMessage({type:"capture-done",captureId:"old",text:"partial",messageId:"old-capture-answer"});');
    expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('does not bind an analysis message even when its ID is present in capture metadata', async () => {
    const p = await page(); p.start();
    const analysis = p.node('analysis', 3, toolReply), original = analysis.getAttribute.bind(analysis);
    analysis.getAttribute = (key: string) => key === 'data-channel' ? 'analysis' : original(key);
    p.state.assistants.push(analysis); p.capture('<escape>{"', 'analysis');
    expect((await p.receive()).error?.message).toContain('最终正文');
  });
  it('deduplicates a user wrapper and its nested role element in the same turn', async () => {
    const p = await page(); p.start();
    const user = p.node('current-user', 2), wrapper = p.node('user-wrapper', 1.9);
    wrapper.contains = (other: unknown) => other === user;
    p.state.users.push(user); p.state.articleUsers.push(wrapper);
    p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('<escape>{"');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('accepts a new message ID when React reuses the same assistant element', async () => {
    const p = await page(); const answer = p.node('old-answer', 3, toolReply);
    p.state.assistants.push(answer); p.start(); answer.id = 'current-answer';
    p.state.users.push(p.node('current-user', 2)); p.capture('<escape>{"');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('never falls back to an arbitrary new assistant with the same conversation ID and no user anchor', async () => {
    const p = await page(); p.start(); p.state.complete = true;
    p.state.assistants.push(p.node('unrelated-answer', 3, toolReply)); p.capture('<escape>{"', 'current-answer');
    expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('does not use a remounted old answer even when the capture provides that old message ID', async () => {
    const p = await page(); p.state.assistants.push(p.node('old-answer', 1, toolReply)); p.start();
    p.state.assistants = [p.node('old-answer', 3, toolReply)]; p.capture('<escape>{"', 'old-answer');
    expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('binds a reused user DOM node only when its changed text matches the actual outgoing prompt', async () => {
    const p = await page(); const user = p.node('old-user', 2, 'previous prompt'); p.state.users.push(user); p.start();
    p.run('baseline.expectedPrompt = "new prompt"'); user.innerText = 'new prompt';
    p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('<escape>{"');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('does not bind an edited old user node whose text is unrelated to the outgoing prompt', async () => {
    const p = await page(); const user = p.node('old-user', 2, 'previous prompt'); p.state.users.push(user); p.start();
    p.run('baseline.expectedPrompt = "new prompt"'); user.innerText = 'unrelated edited prompt';
    p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('<escape>{"');
    expect((await p.receive()).error?.message).toContain('未定位到本轮提问');
  });
  it('waits for a delayed current user and final answer beyond the former 15-second DOM grace', async () => {
    const p = await page(); p.start(); p.capture('<escape>{"');
    setTimeout(() => {
      p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.state.complete = true;
    }, 58_000);
    const pending = Promise.resolve(p.run('receiveChatGptReply(job, baseline, {timeoutMs:90000})'))
      .then((value) => ({ value, error: undefined }), (error) => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(57_000);
    expect(p.run('apiCapture === null')).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).value).toBe(toolReply);
  });
  it('hands a recovered tool request to the actual workbench, reads README, and waits for the next reply without changing files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-dom-recovery-'));
    const original = '# Example\n\nDocument body.\n';
    await fs.writeFile(path.join(root, 'README.md'), original);
    const service = new WorkbenchService(root);
    try {
      const task = await service.create(taskInput.parse({ prompt: '总结readme文件内容', mode: 'agent', delivery: 'manual' }));
      const p = await page(); p.context.job.conversationId = task.conversationId; p.start();
      const reply = toolReply.replace(conversationId, task.conversationId);
      p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, reply)); p.capture('<escape>{"');
      const received = await p.receive(); expect(received.error).toBeUndefined();
      await service.acceptResponse(task.id, received.value!);
      expect(task.status).toBe('awaiting_response');
      expect(task.attachedFiles).toContain('README.md');
      expect(task.attempt).toBe(1); expect(task.plans).toEqual([]);
      expect(task.logs.some((entry) => entry.text.includes('读取文件 README.md'))).toBe(true);
      expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe(original);
    } finally { await service.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it('recovers the supplied read_file response instead of rejecting an incomplete stream fragment', async () => {
    const p = await page(); p.start();
    p.state.users.push(p.node('current-user', 2));
    p.state.assistants.push(p.node('current-answer', 3, toolReply));
    p.capture('<escape>{"');
    const result = await p.receive();
    expect(result.error).toBeUndefined();
    expect(parseAIResponse(result.value!, { conversationId }).toolRequests?.[0]).toEqual({ tool: 'read_file', path: 'README.md' });
  });
  it('recovers a completed current page response if no stream capture arrives at all', async () => {
    const p = await page(); p.start();
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.state.complete = true;
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('recovers from a completed but empty capture without requiring a specific footer layout', async () => {
    const p = await page(); p.start();
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('');
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('does not treat a network interruption as a completion receipt', async () => {
    const p = await page(); p.start();
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture(null);
    expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('requires the page completion UI if recovering after an interrupted stream', async () => {
    const p = await page(); p.start(); p.state.complete = true;
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture(null);
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('does not guess which response belongs to the job after two new user messages', async () => {
    const p = await page(); p.start(); p.state.complete = true;
    p.state.users.push(p.node('current-user', 2), p.node('another-user', 4));
    p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('<escape>{"');
    expect((await p.receive()).error?.message).toContain('不唯一');
  });
  it('preserves complete source strings exactly, including literal braces, quotes and backslashes', async () => {
    const p = await page(); p.start();
    const content = 'const text = "literal { } \\\\";\n';
    const reply = JSON.stringify({ conversationId, operations: [{ action: 'CREATE_FILE', path: 'example.ts', content }] });
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, reply)); p.capture('<escape>{"');
    const result = await p.receive();
    expect(parseAIResponse(result.value!, { conversationId }).operations?.[0].content).toBe(content);
  });
  it('does not return a stable partial reply while the page is still generating', async () => {
    const p = await page(); p.start();
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.state.busy = true;
    p.capture('<escape>{"');
    expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('does not use the first turn answer for the second turn even when the conversation ID is the same', async () => {
    const p = await page();
    p.state.users.push(p.node('old-user', 0)); p.state.assistants.push(p.node('old-answer', 1, toolReply)); p.start();
    p.state.users.push(p.node('current-user', 2)); p.capture('<escape>{"');
    expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('rejects a remounted old message with the same stable ID', async () => {
    const p = await page(); p.state.assistants.push(p.node('old-answer', 1, toolReply)); p.start();
    p.state.users.push(p.node('current-user', 2)); p.state.assistants = [p.node('old-answer', 3, toolReply)]; p.capture('<escape>{"');
    expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('does not recover an answer from another conversation ID', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
    p.state.assistants.push(p.node('current-answer', 3, toolReply.replace(conversationId, 'aafa3c58-e443-4c2c-82eb-c6dd8c657f88')));
    p.capture('<escape>{"'); expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('does not choose one of two different valid current-task JSON envelopes', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
    p.state.assistants.push(p.node('current-answer', 3, toolReply + '\n' + JSON.stringify({ conversationId, error: 'Which section?', operations: [] })));
    p.capture('<escape>{"'); expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('does not recover a matching JSON example from an explicit analysis message', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2));
    const analysis = p.node('thinking', 3, toolReply);
    const getAttribute = analysis.getAttribute.bind(analysis);
    analysis.getAttribute = (key: string) => key === 'data-channel' ? 'analysis' : getAttribute(key);
    p.state.assistants.push(analysis); p.capture('<escape>{"');
    expect((await p.receive()).error?.message).toContain('最终正文');
  });
  it('does not infer completion just because a complete JSON object stopped changing', async () => {
    const p = await page(); p.start(); p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply));
    expect((await p.receive()).error?.message).toContain('回复捕获不完整');
  });
  it('returns a valid stream envelope without depending on page layout', async () => {
    const p = await page(); p.start(); p.capture(toolReply);
    expect((await p.receive()).value).toBe(toolReply);
  });
  it('does not revive a locally cancelled request from a late page answer', async () => {
    const p = await page(); p.start();
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.state.complete = true;
    p.run('activeJob = {sessionId:job.sessionId,cancelled:true,reason:new Error("本地任务已取消"),waiters:new Set()};');
    expect((await p.receive()).error?.message).toContain('已取消');
  });
  it('ignores a hidden leftover Stop button', async () => {
    const p = await page(); p.start(); p.state.hiddenStop = true;
    p.state.users.push(p.node('current-user', 2)); p.state.assistants.push(p.node('current-answer', 3, toolReply)); p.capture('<escape>{"');
    expect((await p.receive()).value).toBe(toolReply);
  });
});
