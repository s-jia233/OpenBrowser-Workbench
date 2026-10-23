import fs from 'node:fs/promises';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Runs the actual isolated content script with deterministic editor/DOM doubles.
// These tests never contact an AI provider or click a real browser tab.
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function composer() {
  vi.useFakeTimers();
  class TestEvent {
    type: string;
    constructor(type: string, init = {}) { this.type = type; Object.assign(this, init); }
  }
  class Element {
    visible = true;
    disabled = false;
    readOnly = false;
    isContentEditable = true;
    textContent = '';
    innerText = '';
    style = { visibility: 'visible', display: 'block', opacity: '1', pointerEvents: 'auto' };
    attrs: Record<string, string> = {};
    selectors = new Set<string>();
    form: any = null;
    shadowRoot: any = null;
    onEvent = (_event: any) => {};
    onClick = () => {};
    events: any[] = [];
    classList = { contains: () => false };
    clicks = 0;
    htmlWrites = 0;
    focus() { active = this; }
    closest() { return this.form; }
    getAttribute(key: string) { return this.attrs[key] ?? null; }
    matches(selector: string) { return selector === ':disabled' ? this.disabled : this.selectors.has(selector); }
    getBoundingClientRect() { return { width: this.visible ? 100 : 0, height: this.visible ? 40 : 0 }; }
    dispatchEvent(event: any) { this.events.push(event); this.onEvent(event); return true; }
    click() { this.clicks++; this.onClick(); }
    set innerHTML(_value: string) { this.htmlWrites++; }
  }
  class Textarea extends Element {
    isContentEditable = false;
    nativeValue = '';
    selection: number[] = [];
    get value() { return this.nativeValue; }
    set value(value: string) { this.nativeValue = value; }
    setSelectionRange(start: number, end: number) { this.selection = [start, end]; }
  }
  class Input extends Textarea {}
  class Transfer {
    text = '';
    setData(_type: string, text: string) { this.text = text; }
    getData() { return this.text; }
  }
  const input = new Textarea();
  const button = new Element(); button.isContentEditable = false;
  const stop = new Element();
  const nodes = new Map<string, any[]>([['#prompt-textarea', [input]], ['#composer-submit-button', [button]]]);
  const state = { stopped: false, users: [] as any[], assistants: [] as any[], acceptInsert: true, acceptPaste: false, nativeChanges: 0 };
  let active: Element = input;
  let selected = false;
  const document = {
    addEventListener() {},
    querySelectorAll(selector: string): any[] {
      if (selector === '*') return [...new Set([...nodes.values()].flat())];
      if (selector.includes('[data-message-author-role="user"]')) return state.users;
      if (selector === '[data-message-author-role="assistant"]') return state.assistants;
      if (selector === '[data-testid="stop-button"]') return state.stopped ? [stop] : [];
      return nodes.get(selector) ?? [];
    },
    querySelector(selector: string) { return document.querySelectorAll(selector)[0] ?? null; },
    createRange() { return { selectNodeContents() { selected = true; }, collapse() { selected = false; } }; },
    execCommand(command: string, _ui: boolean, text: string) {
      if (!state.acceptInsert) return false;
      if (command === 'delete' && selected) { active.innerText = ''; active.textContent = ''; }
      if (command === 'insertText') {
        active.innerText = selected ? text : active.innerText + text;
        active.textContent = active.innerText;
        state.nativeChanges++;
      }
      selected = false;
      return true;
    },
  };
  const context = vm.createContext({
    console, Date, setTimeout, clearTimeout, setInterval: () => 0,
    location: { hostname: 'chatgpt.com' },
    HTMLTextAreaElement: Textarea, HTMLInputElement: Input,
    InputEvent: TestEvent, Event: TestEvent, ClipboardEvent: TestEvent, DataTransfer: Transfer,
    window: { HTMLTextAreaElement: Textarea, addEventListener() {}, getComputedStyle: (node: Element) => node.style,
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }) }, document,
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } },
  });
  vm.runInContext(await fs.readFile(new URL('./src/providers.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await fs.readFile(new URL('./src/content-script.js', import.meta.url), 'utf8'), context);
  context.input = input;
  context.button = button;
  context.state = state;
  const run = (source: string) => vm.runInContext(source, context);
  const rich = () => {
    const editor = new Element();
    editor.onEvent = (event) => {
      if (event.type === 'paste' && state.acceptPaste) {
        editor.innerText = selected ? event.clipboardData.text : editor.innerText + event.clipboardData.text;
        editor.textContent = editor.innerText;
        selected = false;
      }
    };
    nodes.set('div.ProseMirror#prompt-textarea[contenteditable="true"]', [editor]);
    context.editor = editor;
    return editor;
  };
  async function settle(source: string) {
    // Attach rejection handlers before advancing fake timers.
    const pending = Promise.resolve(run(source)).then((value) => ({ value, error: undefined }), (error) => ({ value: undefined, error }));
    await vi.runAllTimersAsync();
    return pending;
  }
  return { run, settle, context, input, button, nodes, state, rich, Element, Textarea };
}

describe('visible, editable composer selection', () => {
  it('prefers the real ChatGPT editor over a hidden textarea proxy', async () => {
    const h = await composer(); h.input.visible = false;
    const editor = h.rich();
    expect(h.run('findPromptInput()')).toBe(editor);
  });
  it('continues past hidden or read-only matches of the same selector', async () => {
    const h = await composer(); h.input.readOnly = true;
    const visible = new h.Textarea();
    h.nodes.set('#prompt-textarea', [h.input, visible]);
    expect(h.run('findPromptInput()')).toBe(visible);
    visible.disabled = true;
    expect(h.run('findPromptInput()')).toBeNull();
  });
  it('still finds editors in open shadow roots', async () => {
    const h = await composer(); h.input.visible = false;
    const host = new h.Element(), editor = new h.Textarea();
    host.shadowRoot = { querySelectorAll: (selector: string) => selector === '#prompt-textarea' ? [editor] : [] };
    h.nodes.set('host', [host]);
    expect(h.run('findPromptInput()')).toBe(editor);
  });
  it('never selects a send control from another form or a stop control', async () => {
    const h = await composer();
    const wrong = h.button, correct = new h.Element();
    h.input.form = { contains: (node: any) => node === correct };
    h.nodes.set('#composer-submit-button', [wrong, correct]);
    expect(h.run('findSendButton()')).toBe(correct);
    correct.selectors.add('[data-testid="stop-button"]');
    expect(h.run('findSendButton()')).toBeNull();
  });
});

describe('editor-aware prompt injection', () => {
  it('notifies controlled textareas without updating their tracker first', async () => {
    const h = await composer(); let tracked = '', accepted = '';
    Object.defineProperty(h.input, 'value', {
      get: () => h.input.nativeValue,
      set: (value) => { h.input.nativeValue = value; tracked = value; },
    });
    h.input.onEvent = (event) => {
      if (event.type === 'input' && h.input.value !== tracked) { accepted = h.input.value; tracked = accepted; }
    };
    expect((await h.settle('injectPrompt("完整提示词\\n第二行")')).error).toBeUndefined();
    expect(accepted).toBe('完整提示词\n第二行');
    expect(h.input.events.filter((event) => event.type === 'input')).toMatchObject([
      { data: '完整提示词\n第二行', composed: true, bubbles: true },
    ]);
  });
  it('checks exact text rather than similar length, truncation, or duplication', async () => {
    const h = await composer();
    for (const actual of ['abcdefghij', '123456789', '12345678901234567890']) {
      h.input.value = actual;
      expect(h.run('hasInjectedContent(input, "1234567890")')).toBe(false);
    }
    h.input.value = '第一行\r\n第二行';
    expect(h.run('hasInjectedContent(input, "第一行\\n第二行")')).toBe(true);
  });
  it('reads rendered line breaks in rich editors rather than concatenated textContent', async () => {
    const h = await composer(), editor = h.rich();
    editor.innerText = '第一行\n第二行'; editor.textContent = '第一行第二行';
    expect(h.run('hasInjectedContent(editor, "第一行\\n第二行")')).toBe(true);
  });
  it('does not confuse CSS paragraph spacing with real editor line breaks', async () => {
    const h = await composer(), editor: any = h.rich();
    const text = (value: string) => ({ nodeType: 3, textContent: value });
    const node = (tagName: string, childNodes: any[] = [], trailing = false) => ({
      nodeType: 1, tagName, childNodes, classList: { contains: () => trailing },
    });
    editor.childNodes = [node('P', [text('第一行')]), node('P', [node('BR')]), node('P', [text('第二行'), node('BR', [], true)])];
    editor.innerText = '第一行\n\n\n\n第二行';
    editor.textContent = '第一行第二行';
    expect(h.run('hasInjectedContent(editor, "第一行\\n\\n第二行")')).toBe(true);
    expect(h.run('hasInjectedContent(editor, "第一行\\n第二行")')).toBe(false);
    editor.childNodes = [node('P', [text('一'), node('BR'), text('二')])];
    expect(h.run('hasInjectedContent(editor, "一\\n二")')).toBe(true);
  });
  it('uses accepted native insertion in ProseMirror', async () => {
    const h = await composer(), editor = h.rich();
    expect((await h.settle('injectPrompt("一行\\n另一行")')).error).toBeUndefined();
    expect(editor.innerText).toBe('一行\n另一行');
    expect(h.state.nativeChanges).toBe(1);
    expect(editor.htmlWrites).toBe(0);
  });
  it('uses paste if native insertion is rejected, without DOM-only fallback', async () => {
    const h = await composer(), editor = h.rich();
    h.state.acceptInsert = false; h.state.acceptPaste = true;
    expect((await h.settle('injectPrompt("完整方案")')).error).toBeUndefined();
    expect(editor.innerText).toBe('完整方案');
    expect(editor.htmlWrites).toBe(0);
  });
  it('fails without sending if the editor accepts neither insertion nor paste', async () => {
    const h = await composer(), editor = h.rich(); h.state.acceptInsert = false;
    expect((await h.settle('injectPrompt("完整方案")')).error?.message).toContain('未完整接收');
    expect(editor.innerText).toBe('');
    expect(editor.htmlWrites).toBe(0);
    expect(h.button.clicks).toBe(0);
  });
  it('does not append the same file companion text on retry', async () => {
    const h = await composer(), editor = h.rich();
    editor.innerText = '请读取附件';
    expect((await h.settle('injectPrompt("请读取附件", {preserveAttachments:true})')).error).toBeUndefined();
    expect(editor.innerText).toBe('请读取附件');
    expect(h.state.nativeChanges).toBe(0);
  });
  it('protects existing user drafts before attaching files or injecting text', async () => {
    const h = await composer(); h.input.value = '不要删除我的草稿';
    expect(() => h.run('assertComposerAvailable()')).toThrow('已有草稿');
    expect((await h.settle('injectPrompt("新任务")')).error?.message).toContain('未覆盖');
    expect(h.input.value).toBe('不要删除我的草稿');
    expect(h.button.clicks).toBe(0);
  });
  it('does not interfere with an existing generation', async () => {
    const h = await composer(); h.state.stopped = true;
    expect(() => h.run('assertComposerAvailable()')).toThrow('仍在生成');
    expect((await h.settle('injectPrompt("新任务")')).error?.message).toContain('仍在生成');
    expect(h.input.value).toBe('');
  });
  it('protects drafts typed while focusing the page editor', async () => {
    const h = await composer();
    setTimeout(() => { h.input.value = '刚输入的新草稿'; }, 50);
    expect((await h.settle('injectPrompt("新任务")')).error?.message).toContain('发生变化');
    expect(h.input.value).toBe('刚输入的新草稿');
  });
  it('uses native replacement after a partial Lexical paste, not duplicate appending', async () => {
    const h = await composer(), editor = h.rich();
    editor.attrs['data-lexical-editor'] = 'true';
    editor.onEvent = (event) => { if (event.type === 'paste') editor.innerText = '完整'; };
    expect((await h.settle('injectPrompt("完整方案")')).error).toBeUndefined();
    expect(editor.innerText).toBe('完整方案');
    expect(editor.htmlWrites).toBe(0);
  });
});

describe('bounded submission with positive acknowledgement', () => {
  it('waits briefly for the previous reply UI to release the composer before starting a new turn', async () => {
    const h = await composer(); h.state.stopped = true;
    setTimeout(() => { h.state.stopped = false; }, 500);
    expect((await h.settle('waitForComposerReady()')).error).toBeUndefined();
    expect(h.button.clicks).toBe(0);
  });
  it('does not bypass generation or wipe drafts when waiting for the next turn', async () => {
    const h = await composer(); h.state.stopped = true; h.input.value = '保留草稿';
    expect((await h.settle('waitForComposerReady()')).error?.message).toContain('仍在生成');
    expect(h.input.value).toBe('保留草稿');
    expect(h.button.clicks).toBe(0);
  });
  it('submits the Chinese ChatGPT button from the reported DOM without requiring an ID or test ID', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.nodes.delete('#composer-submit-button');
    h.button.attrs = { type: 'submit', 'aria-label': '发送' };
    h.nodes.set('button[type="submit"][aria-label="发送"]', [h.button]);
    h.input.form = { contains: (node: any) => node === h.button };
    h.button.onClick = () => { h.state.users.push({}); };
    expect((await h.settle('clickSendWhenReady("prompt")')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
    expect(h.input.events).toEqual([]);
  });
  it('does not confuse the Chinese send control in another form with the chat composer', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.nodes.delete('#composer-submit-button');
    h.nodes.set('button[type="submit"][aria-label="发送"]', [h.button]);
    h.input.form = { contains: () => false };
    expect((await h.settle('clickSendWhenReady("prompt")')).error?.message).toContain('未找到');
    expect(h.button.clicks).toBe(0);
  });
  it('supports a submit button associated with the current form but located outside it', async () => {
    const h = await composer(); h.input.value = 'prompt';
    const form = { contains: () => false };
    h.input.form = form; h.button.form = form;
    h.button.onClick = () => { h.state.users.push({}); };
    expect((await h.settle('clickSendWhenReady("prompt")')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
  });
  it('restricts selection to the known composer container if no form exists', async () => {
    const h = await composer(); h.input.value = 'prompt';
    const other = new h.Element();
    const scope = { contains: (node: any) => node === h.button };
    h.input.closest = (selector = '') => selector === 'form' ? null : scope;
    h.nodes.set('#composer-submit-button', [other, h.button]);
    expect(h.run('findSendButton()')).toBe(h.button);
    expect(other.clicks).toBe(0);
  });
  it('does not guess between several matching buttons without a composer boundary', async () => {
    const h = await composer(); h.input.value = 'prompt';
    const other = new h.Element();
    h.nodes.set('button[type="submit"][aria-label="发送"]', [other]);
    expect((await h.settle('clickSendWhenReady("prompt")')).error?.message).toContain('未找到');
    expect(h.button.clicks).toBe(0);
    expect(other.clicks).toBe(0);
  });
  it('does not treat arbitrary submit buttons or file candidates as Send', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.nodes.delete('#composer-submit-button');
    h.nodes.set('button[type="submit"]', [h.button]);
    h.nodes.set('[role="option"]', [h.button]);
    expect(h.run('findSendButton()')).toBeNull();
    expect(h.button.clicks).toBe(0);
  });
  it.each(['button[type="submit"][aria-label="發送"]', 'button[aria-label="Send message"]'])('recognizes the explicit label variant %s', async (selector) => {
    const h = await composer(); h.input.value = 'prompt';
    h.nodes.delete('#composer-submit-button'); h.nodes.set(selector, [h.button]);
    h.button.onClick = () => { h.state.users.push({}); };
    expect((await h.settle('clickSendWhenReady("prompt")')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
  });
  it('keeps a localized disabled send control disabled without falling back to Enter', async () => {
    const h = await composer(); h.input.value = 'prompt'; h.button.disabled = true;
    h.nodes.delete('#composer-submit-button');
    h.nodes.set('button[type="submit"][aria-label="发送"]', [h.button]);
    expect((await h.settle('clickSendWhenReady("prompt")')).error?.message).toContain('已找到');
    expect(h.button.clicks).toBe(0);
    expect(h.input.events).toEqual([]);
  });
  it('reports a missing button as a compatibility problem, not as disabled or quota exhausted', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.nodes.delete('#composer-submit-button');
    const result = await h.settle('clickSendWhenReady("prompt")');
    expect(result.error?.message).toContain('未找到');
    expect(result.error?.message).not.toContain('额度');
    expect(h.button.clicks).toBe(0);
  });
  it('never clicks or presses Enter while Send is disabled', async () => {
    const h = await composer(); h.input.value = 'prompt'; h.button.disabled = true;
    expect((await h.settle('clickSendWhenReady("prompt")')).error?.message).toContain('持续不可用');
    expect(h.button.clicks).toBe(0);
    expect(h.input.events).toEqual([]);
  });
  it('does not submit attachment messages while disabled either', async () => {
    const h = await composer(); h.input.value = 'prompt'; h.button.attrs['aria-disabled'] = 'true';
    expect(await h.run('trySubmitSend("prompt")')).toBe(false);
    expect(h.button.clicks).toBe(0);
    expect(h.input.events).toEqual([]);
  });
  it('waits for an enabled button, then submits exactly once', async () => {
    const h = await composer(); h.input.value = 'prompt'; h.button.disabled = true;
    setTimeout(() => { h.button.disabled = false; }, 500);
    h.button.onClick = () => { h.state.stopped = true; };
    expect((await h.settle('clickSendWhenReady("prompt")')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
  });
  it('does not resend when disabled or empty input is the only acknowledgement', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.button.onClick = () => { h.button.disabled = true; h.input.value = ''; };
    expect((await h.settle('clickSendWhenReady("prompt")')).error?.message).toContain('未再次发送');
    expect(h.button.clicks).toBe(1);
  });
  it('does not repeat an attachment submission with uncertain acknowledgement', async () => {
    const h = await composer();
    expect((await h.settle('clickSendAfterFileAttach("请读取附件")')).error?.message).toContain('未再次发送');
    expect(h.button.clicks).toBe(1);
  });
  it('accepts a new user message as a submission receipt', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.button.onClick = () => { h.state.users.push({}); };
    expect((await h.settle('clickSendWhenReady("prompt")')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
  });
  it('accepts a captured provider response even if Stop is not rendered', async () => {
    const h = await composer(); h.input.value = 'prompt';
    h.run('beginApiCapture("agent", "test-session")');
    h.button.onClick = () => { h.run('handleApiCaptureMessage({type:"capture-begin",captureId:"new",at:Date.now()})'); };
    expect((await h.settle('clickSendWhenReady("prompt")')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
  });
  it('stops instead of sending if the user changes the draft while waiting', async () => {
    const h = await composer(); h.input.value = 'prompt'; h.button.disabled = true;
    setTimeout(() => { h.input.value = '我的新草稿'; h.button.disabled = false; }, 500);
    expect((await h.settle('clickSendWhenReady("prompt")')).error?.message).toContain('内容发生变化');
    expect(h.input.value).toBe('我的新草稿');
    expect(h.button.clicks).toBe(0);
  });
  it('also protects edits made before the send waiter starts', async () => {
    const h = await composer(); h.input.value = '网页中的新草稿';
    expect((await h.settle('clickSendWhenReady("原任务提示词")')).error?.message).toContain('内容发生变化');
    expect(h.button.clicks).toBe(0);
  });
});

describe('two-turn ChatGPT editor-to-reply pipeline (simulated page and bridge)', () => {
  it('detects unclosed captures without mistaking valid clarification or literal braces for truncation', async () => {
    const h = await composer(); h.context.damaged = '<escape>{"';
    expect(h.run('chatGptCaptureIsIncomplete(damaged)')).toBe(true);
    expect(h.run('chatGptCaptureIsIncomplete("{\\\"operations\\\":[]}")')).toBe(false);
    h.context.full = JSON.stringify({ conversationId: 'task', error: 'Which section?', operations: [] });
    expect(h.run('chatGptCaptureIsIncomplete(full)')).toBe(false);
    h.context.full = JSON.stringify({ operations: [{ content: 'literal } { " braces' }] });
    expect(h.run('chatGptCaptureIsIncomplete(full)')).toBe(false);
  });
  it('reports the observed capture fragment once as an error, never as a successful proposal', async () => {
    const h = await composer(), replies: any[] = [];
    h.context.chrome.runtime.sendMessage = async (message: any) => {
      if (message.type !== 'BRIDGE_REQUEST') return { ok: true };
      const body = JSON.parse(message.init?.body ?? '{}');
      if (message.path === '/browser/claim') return { ok: true, data: { claimed: true, job: {
        sessionId: 'damaged', mode: 'agent', delivery: 'text', message: '修改 readme', systemPrompt: '',
      } } };
      if (message.path === '/browser/response') replies.push(body);
      return { ok: true, data: {} };
    };
    h.context.damaged = '<escape>{"';
    h.button.onClick = () => {
      h.input.value = ''; h.state.users.push({});
      h.run('handleApiCaptureMessage({type:"capture-begin",captureId:"bad",at:Date.now()});handleApiCaptureMessage({type:"capture-done",captureId:"bad",text:damaged});');
    };
    expect((await h.settle('handleIncomingJob({sessionId:"damaged"})')).error).toBeUndefined();
    expect(h.button.clicks).toBe(1);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBeUndefined();
    expect(replies[0].error).toContain('回复捕获不完整');
    expect(h.run('running')).toBe(false);
  });
  it('inputs both turns, waits out a UI completion lag, and reports only the matching answers', async () => {
    const h = await composer();
    const jobs: Record<string, any> = {
      first: { sessionId: 'first', mode: 'ask', delivery: 'text', message: '第一个问题', systemPrompt: '' },
      second: { sessionId: 'second', mode: 'ask', delivery: 'text', message: '接着回答第二个问题', systemPrompt: '' },
    };
    const statuses: Record<string, string> = { first: 'pending', second: 'pending' };
    const submitted: string[] = [], replies: any[] = [];
    h.context.chrome.runtime.sendMessage = async (message: any) => {
      if (message.type !== 'BRIDGE_REQUEST') return { ok: true };
      const body = JSON.parse(message.init?.body ?? '{}');
      if (message.path === '/browser/claim') {
        const claimed = statuses[body.sessionId] === 'pending';
        if (claimed) statuses[body.sessionId] = 'claimed';
        return { ok: true, data: { claimed, job: jobs[body.sessionId] } };
      }
      if (message.path.startsWith('/session/')) return { ok: true, data: { status: statuses[message.path.split('/')[2]] } };
      if (message.path === '/browser/response') { replies.push(body); statuses[body.sessionId] = 'complete'; }
      return { ok: true, data: { accepted: true } };
    };
    h.button.onClick = () => {
      submitted.push(h.input.value); h.input.value = ''; h.state.users.push({}); h.state.assistants.push({});
      h.state.stopped = true; setTimeout(() => { h.state.stopped = false; }, 500);
      h.context.answer = `回答 ${submitted.length}`;
      h.run('handleApiCaptureMessage({type:"capture-begin",captureId:"reply-"+state.users.length,at:Date.now()}); handleApiCaptureMessage({type:"capture-done",captureId:"reply-"+state.users.length,text:answer});');
    };
    const outcome = await h.settle('Promise.all([handleIncomingJob({sessionId:"first"}), handleIncomingJob({sessionId:"second"})])');
    expect(outcome.error).toBeUndefined();
    expect(submitted).toEqual(['第一个问题', '接着回答第二个问题']);
    expect(replies).toEqual([{ sessionId: 'first', text: '回答 1' }, { sessionId: 'second', text: '回答 2' }]);
    expect(h.run('running')).toBe(false);
    expect(h.run('jobQueue.length')).toBe(0);
  });
});
