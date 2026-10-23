import { describe, expect, it, vi } from 'vitest';
import { installEnterToSend, installNavigationToggle } from './composer-controls.js';

function fakeDocument() {
  const handlers = new Map();
  const classes = new Set();
  const attributes = new Map();
  const buttonHandlers = new Map();
  const button = { setAttribute: (name, value) => attributes.set(name, value), focus: vi.fn(),
    addEventListener: (name, fn) => buttonHandlers.set(name, fn), click: () => buttonHandlers.get('click')?.() };
  const navigation = { setAttribute: vi.fn(), contains: vi.fn(() => false), inert: false };
  const document = {
    body: { classList: { contains: (name) => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } },
    activeElement: null, modal: false,
    querySelector(selector) { return selector === 'dialog[open]' ? (this.modal ? {} : null) : selector === '#toggle-navigation' ? button : navigation; },
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    emit(name, event) { for (const fn of handlers.get(name) ?? []) fn(event); },
  };
  return { document, button, navigation, classes, attributes };
}
function enter(id = 'prompt', options = {}) {
  return { key: 'Enter', target: { id }, preventDefault: vi.fn(), ...options };
}

describe('composer Enter shortcut', () => {
  it('sends Enter from either composer exactly once and retains Ctrl/Command+Enter', () => {
    const { document } = fakeDocument(); const send = vi.fn(); installEnterToSend(document, send);
    for (const event of [enter(), enter('followup-prompt'), enter('prompt', { ctrlKey: true }), enter('followup-prompt', { metaKey: true })]) {
      document.emit('keydown', event); expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(send.mock.calls).toEqual([['prompt'], ['followup-prompt'], ['prompt'], ['followup-prompt']]);
  });
  it('leaves Shift+Enter, repeat keys, modal dialogs and other fields alone', () => {
    const { document } = fakeDocument(); const send = vi.fn(); installEnterToSend(document, send);
    for (const event of [enter('prompt', { shiftKey: true }), enter('followup-prompt', { shiftKey: true }), enter('prompt', { altKey: true }),
      enter('prompt', { repeat: true }), enter('prompt', { defaultPrevented: true }), enter('manual-response'), enter('project-input'), enter('file-search')]) {
      document.emit('keydown', event); expect(event.preventDefault).not.toHaveBeenCalled();
    }
    document.modal = true; document.emit('keydown', enter()); expect(send).not.toHaveBeenCalled();
  });
  it('does not send while confirming Chinese IME candidates or on the composition-end Enter', () => {
    const { document } = fakeDocument(); const send = vi.fn(); let now = 1000;
    installEnterToSend(document, send, () => now);
    document.emit('keydown', enter('prompt', { isComposing: true }));
    document.emit('keydown', enter('prompt', { keyCode: 229 }));
    document.emit('compositionstart', { target: { id: 'prompt' } }); document.emit('keydown', enter());
    document.emit('compositionend', { target: { id: 'prompt' } }); document.emit('keydown', enter());
    expect(send).not.toHaveBeenCalled();
    now += 100; document.emit('keydown', enter()); expect(send).toHaveBeenCalledOnce();
  });
});

describe('navigation collapse', () => {
  it('hides and reopens navigation, updates accessibility and remembers the preference', () => {
    const { document, button, classes, attributes, navigation } = fakeDocument(); const saved = new Map();
    installNavigationToggle(document, { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) });
    expect(attributes.get('aria-expanded')).toBe('true');
    button.click();
    expect(classes.has('navigation-hidden')).toBe(true);
    expect(attributes.get('aria-expanded')).toBe('false');
    expect(saved.get('openbrowser.navigationHidden')).toBe('true');
    expect(navigation.inert).toBe(true);
    button.click();
    expect(navigation.inert).toBe(false);
    expect(classes.has('navigation-hidden')).toBe(false);
    expect(saved.get('openbrowser.navigationHidden')).toBe('false');
  });
  it('restores a collapsed preference and remains usable when storage is unavailable', () => {
    const first = fakeDocument(); installNavigationToggle(first.document, { getItem: () => 'true' });
    expect(first.classes.has('navigation-hidden')).toBe(true);
    expect(first.attributes.get('aria-label')).toBe('显示导航侧栏'); expect(first.navigation.inert).toBe(true);
    const second = fakeDocument(); installNavigationToggle(second.document, { getItem() { throw new Error('blocked'); } });
    expect(second.attributes.get('aria-expanded')).toBe('true');
  });
});
