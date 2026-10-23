import fs from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { connectionAiDisplay, taskAiLabel } from './ai-status.js';
import { targetChoices, validateBrowserTarget } from './browser-targets.js';
import { createTaskDraftStore, followupDraftKey, replyDraftKey } from './task-drafts.js';
import { visibleConversations } from './conversation-menu.js';
import { executionHtml, browserReceptionHtml, clarificationHtml } from './execution-status.js';

function localStorage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key),
    key: (index) => [...entries.keys()][index], get length() { return entries.size; } };
}

async function workbench(storage = localStorage()) {
  const elements = new Map(), handlers = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      const classes = new Set(), listeners = new Map();
      elements.set(selector, { value: '', textContent: '', innerHTML: '', dataset: {}, open: false,
        classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
        replaceChildren() {}, append() {},
        focus: vi.fn(), scrollIntoView: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(),
        addEventListener(name, handler) { listeners.set(name, handler); },
        emit(name) { return listeners.get(name)?.(); }, closest: () => null,
      });
    }
    return elements.get(selector);
  }
  const document = { querySelector: element, querySelectorAll: () => [],
    addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); } };
  document.body = element('body');
  document.createElement = (tag) => element(`created-${tag}`); document.createTextNode = (text) => ({ text });
  const fetch = vi.fn(() => { throw new Error('Unexpected network request'); });
  const context = vm.createContext({ document, fetch, console, AbortSignal, connectionAiDisplay, taskAiLabel,
    targetChoices, validateBrowserTarget, createTaskDraftStore, followupDraftKey, replyDraftKey, visibleConversations,
    executionHtml, browserReceptionHtml, clarificationHtml,
    window: { localStorage: storage, addEventListener() {}, scrollTo() {} },
    installEnterToSend() {}, installNavigationToggle() {}, installConversationMenu() {}, installCollaboration: () => ({ open() {} }),
  });
  // Run the real workbench event wiring, without bootstrapping a server or polling.
  const source = (await fs.readFile(new URL('./workbench.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace('void init();', 'globalThis.testUI = { state, renderDelivery, renderTask, renderRecent, loadProjectDraft, newTask, startTask, sendFollowUp };');
  vm.runInContext(source, context);
  const { state, renderDelivery } = context.testUI;
  state.workspace = { root: 'A', files: [], scripts: [], scriptCommands: {}, browserConnections: 0, connection: { state: 'disconnected' } };
  element('#delivery').value = 'browser'; element('#followup-delivery').value = 'browser';
  const click = async (attribute) => {
    const button = { hasAttribute: (name) => name === attribute, dataset: {} };
    for (const handler of handlers.get('click') ?? []) await handler({ target: { closest: () => button } });
  };
  const input = (selector, value) => {
    const target = element(selector); target.id = selector.slice(1); target.value = value;
    for (const handler of handlers.get('input') ?? []) handler({ target });
    target.emit('input');
  };
  return { ...context.testUI, state, renderDelivery, element, click, fetch, input, storage };
}

describe('workbench manual fallback', () => {
  it('switches a new task to manual without losing its draft or submitting it', async () => {
    const h = await workbench(); h.element('#prompt').value = 'Keep this draft';
    await h.click('data-use-manual');
    expect(h.element('#delivery').value).toBe('manual'); expect(h.element('#prompt').value).toBe('Keep this draft');
    expect(h.element('#prompt').focus).toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it('uses the follow-up delivery and switches the visible composer, not the hidden new-task form', async () => {
    const h = await workbench();
    h.state.task = { status: 'needs_input', delivery: 'browser' };
    h.element('#delivery').value = 'manual'; h.element('#followup-prompt').value = 'Keep my answer';
    h.renderDelivery(); expect(h.element('#delivery-status').classList.contains('hidden')).toBe(false);
    await h.click('data-use-manual');
    expect(h.element('#followup-delivery').value).toBe('manual'); expect(h.element('#followup-prompt').value).toBe('Keep my answer');
    expect(h.element('#followup-prompt').focus).toHaveBeenCalled(); expect(h.element('#prompt').focus).not.toHaveBeenCalled();
    expect(h.element('#delivery-status').classList.contains('hidden')).toBe(true); expect(h.fetch).not.toHaveBeenCalled();
  });
  it('refreshes connection feedback when follow-up delivery changes', async () => {
    const h = await workbench(); h.state.task = { status: 'complete', delivery: 'browser' };
    h.element('#followup-delivery').value = 'manual'; h.renderDelivery();
    expect(h.element('#delivery-status').classList.contains('hidden')).toBe(true);
    h.element('#followup-delivery').value = 'browser'; h.element('#followup-delivery').emit('change');
    expect(h.element('#delivery-status').classList.contains('hidden')).toBe(false);
  });
  it.each(['data-focus-response', 'data-use-manual'])('reveals the waiting task reply input via %s without changing or resending the task', async (action) => {
    const h = await workbench(); const task = { status: 'awaiting_response', delivery: 'browser' }; h.state.task = task;
    const details = { open: false };
    h.element('#manual-response').closest = (selector) => selector === 'details' ? details : null;
    h.element('#manual-response').value = 'Existing reply draft'; h.element('#delivery').value = 'manual';
    h.renderDelivery();
    expect(h.element('#delivery-status').classList.contains('hidden')).toBe(false);
    expect(h.element('#delivery-status').innerHTML).toContain('data-focus-response');
    await h.click(action);
    expect(details.open).toBe(true); expect(h.element('#manual-response').focus).toHaveBeenCalled();
    expect(h.element('#manual-response').value).toBe('Existing reply draft');
    expect(h.state.task).toBe(task); expect(task.delivery).toBe('browser'); expect(h.fetch).not.toHaveBeenCalled();
  });
});

const taskId = '11111111-1111-4111-8111-111111111111';
function task(extra = {}) {
  return { id: taskId, title: 'Explain code', prompt: 'Explain code', promptMessage: 'protocol and context',
    root: 'A', status: 'complete', mode: 'ask', delivery: 'manual', response: 'Answer', attempt: 1,
    contextPaths: [], scripts: [], plans: [], logs: [], turns: [], ...extra };
}

describe('workbench draft workflows', () => {
  it('restores project-scoped new-task text after a reload and when returning from a conversation', async () => {
    const h = await workbench(); h.loadProjectDraft('A'); h.input('#prompt', 'Unsent task');
    h.state.task = task(); h.renderTask(); h.newTask(); expect(h.element('#prompt').value).toBe('Unsent task');
    const reloaded = await workbench(h.storage); reloaded.loadProjectDraft('A'); expect(reloaded.element('#prompt').value).toBe('Unsent task');
    reloaded.loadProjectDraft('B'); expect(reloaded.element('#prompt').value).toBe('');
    reloaded.input('#prompt', 'Other project'); reloaded.loadProjectDraft('A'); expect(reloaded.element('#prompt').value).toBe('Unsent task');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('restores independent follow-up and manual reply drafts without carrying JSON to a new attempt', async () => {
    const h = await workbench(); h.loadProjectDraft('A'); h.state.task = task(); h.renderTask();
    h.input('#followup-prompt', 'Follow-up not sent');
    const waiting = task({ status: 'awaiting_response' }); h.state.task = waiting; h.renderTask(); h.input('#manual-response', '{"draft":"reply"}');
    const reloaded = await workbench(h.storage); reloaded.loadProjectDraft('A'); reloaded.state.task = waiting; reloaded.renderTask();
    expect(reloaded.element('#followup-prompt').value).toBe('Follow-up not sent'); expect(reloaded.state.draft).toBe('{"draft":"reply"}');
    reloaded.state.task = { ...waiting, attempt: 2 }; reloaded.renderTask(); expect(reloaded.state.draft).toBe('');
    reloaded.state.task = { ...waiting, promptMessage: 'New file-tool context' }; reloaded.renderTask(); expect(reloaded.state.draft).toBe('');
    expect(reloaded.fetch).not.toHaveBeenCalled();
  });
  it('retains failed submissions, then clears only the successfully sent new-task draft', async () => {
    const h = await workbench(); h.loadProjectDraft('A'); h.element('#delivery').value = 'manual'; h.input('#prompt', 'Send this');
    h.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Cannot start yet' }) });
    await h.startTask({ preventDefault() {} });
    expect(createTaskDraftStore(h.storage, 'A').load('new')).toBe('Send this'); expect(h.element('#prompt').value).toBe('Send this');
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => task({ status: 'awaiting_response' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [task({ status: 'awaiting_response' })] });
    await h.startTask({ preventDefault() {} });
    expect(createTaskDraftStore(h.storage, 'A').load('new')).toBe(''); expect(h.element('#prompt').value).toBe('');
  });
  it('preserves text typed while sending a follow-up as the next turn draft', async () => {
    const h = await workbench(); h.loadProjectDraft('A'); h.state.task = task(); h.renderTask(); h.input('#followup-prompt', 'Send follow-up');
    const updated = task({ status: 'awaiting_response', turns: [{}] });
    h.fetch.mockImplementationOnce(async () => {
      h.input('#followup-prompt', 'Next thought while waiting'); return { ok: true, json: async () => updated };
    }).mockResolvedValueOnce({ ok: true, json: async () => [updated] });
    await h.sendFollowUp({ preventDefault() {} });
    const store = createTaskDraftStore(h.storage, 'A');
    expect(store.load(followupDraftKey(task()))).toBe(''); expect(store.load(followupDraftKey(updated))).toBe('Next thought while waiting');
    expect(h.element('#followup-prompt').value).toBe('Next thought while waiting');
  });
  it('clears imported reply drafts only after a successful response', async () => {
    const h = await workbench(); h.loadProjectDraft('A'); const waiting = task({ status: 'awaiting_response' });
    h.state.task = waiting; h.renderTask(); h.input('#manual-response', 'Complete answer');
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => task() }).mockResolvedValueOnce({ ok: true, json: async () => [task()] });
    await h.click('data-import-response');
    expect(createTaskDraftStore(h.storage, 'A').load(replyDraftKey(waiting))).toBe(''); expect(h.state.task.status).toBe('complete');
  });
});

describe('workbench everyday controls', () => {
  it('updates conversation search immediately and renders a distinct no-match state', async () => {
    const h = await workbench(); h.state.tasks = [task({ title: 'README docs' }), task({ id: 'two', title: 'Login bug' })];
    h.input('#conversation-search', 'readme'); expect(h.element('#recent-tasks').innerHTML).toContain('README docs'); expect(h.element('#recent-tasks').innerHTML).not.toContain('Login bug');
    h.input('#conversation-search', 'not found'); expect(h.element('#recent-tasks').innerHTML).toContain('没有匹配');
  });
  it('submits the chosen page and hides the page picker for manual delivery', async () => {
    const h = await workbench(); h.loadProjectDraft('A'); h.input('#prompt', 'Explain code');
    const targets = [{ id: 'instance:3', name: 'ChatGPT', tabId: 3 }, { id: 'instance:9', name: 'DeepSeek', tabId: 9 }];
    h.state.workspace.connection = { state: 'ready', browserConnections: 1, targets };
    h.element('#browser-target').value = 'instance:9'; h.renderDelivery();
    expect(h.element('#browser-target').innerHTML).toContain('ChatGPT'); expect(h.element('#browser-target').innerHTML).toContain('DeepSeek');
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => h.state.workspace.connection })
      .mockResolvedValueOnce({ ok: true, json: async () => task({ status: 'awaiting_response', delivery: 'browser', browserTargetId: 'instance:9' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [task({ status: 'awaiting_response' })] });
    await h.startTask({ preventDefault() {} });
    expect(JSON.parse(h.fetch.mock.calls[1][1].body).browserTargetId).toBe('instance:9');
    h.element('#delivery').value = 'manual'; h.renderDelivery(); expect(h.element('#target-picker').classList.contains('hidden')).toBe(true);
  });
});
