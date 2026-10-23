import { describe, expect, it, vi } from 'vitest';
import { visibleConversations, menuPosition, installConversationMenu } from './conversation-menu.js';

function fixture(task = { id: 'one', pinned: false, archived: false }, allowed = true) {
  const events = new Map(), menuEvents = new Map();
  const document = { documentElement: { clientWidth: 800, clientHeight: 600 }, activeElement: null,
    defaultView: { addEventListener: vi.fn() },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
  };
  const element = (extra = {}) => ({ isConnected: true, attributes: {}, dataset: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { document.activeElement = this; },
    closest(selector) { return selector === '[data-task-more]' && !this.dataset.taskMore ? null : this; }, ...extra });
  const trigger = element({ dataset: { taskMore: task.id }, getBoundingClientRect: () => ({ right: 200, bottom: 580 }) });
  const items = ['rename', 'pin', 'archive', 'delete'].map((action) => element({ menuItem: true, disabled: false, dataset: { conversationAction: action } }));
  const pinLabel = {}, archiveLabel = {}, note = {};
  const menu = { open: false, style: {},
    matches() { return this.open; }, showPopover() { this.open = true; }, hidePopover() { this.open = false; },
    contains: (el) => Boolean(el?.menuItem),
    getBoundingClientRect: () => ({ width: 220, height: 190 }),
    querySelector(selector) {
      return selector === '[data-pin-label]' ? pinLabel : selector === '[data-archive-label]' ? archiveLabel :
        selector === '.menu-note' ? note : items.find((item) => !item.disabled);
    },
    querySelectorAll(selector) { return selector.includes(':not') ? items.filter((item) => !item.disabled) : items; },
    addEventListener(name, fn) { menuEvents.set(name, fn); },
  };
  document.querySelector = (selector) => selector === '#conversation-menu' ? menu : trigger;
  const onAction = vi.fn();
  const controller = installConversationMenu(document, { getTask: () => task, canManage: () => allowed, onAction });
  const emit = (name, event) => { for (const fn of events.get(name) ?? []) fn(event); };
  const click = (target) => emit('click', { target });
  const key = (key, target = document.activeElement) => {
    const event = { key, target, preventDefault: vi.fn() }; emit('keydown', event); return event;
  };
  return { document, menu, items, trigger, onAction, pinLabel, archiveLabel, note, controller, click, key, menuEvents };
}

describe('conversation list and menu', () => {
  it('searches titles with case-insensitive words, retaining archive filtering and pinned order', () => {
    const tasks = [{ id: 'a', title: '修复 README 链接' }, { id: 'b', title: 'README 修复', pinned: true },
      { id: 'c', title: 'readme 修复', archived: true }, { id: 'd', title: '修复登录' }];
    expect(visibleConversations(tasks, false, '  readme 修复  ').map((task) => task.id)).toEqual(['b', 'a']);
    expect(visibleConversations(tasks, true, 'README').map((task) => task.id)).toEqual(['c']);
    expect(visibleConversations(tasks, false, '不存在')).toEqual([]);
  });
  it('separates archives and places pinned items first without mutating source order', () => {
    const tasks = [{ id: 'new' }, { id: 'archived', archived: true }, { id: 'pinned', pinned: true }, { id: 'old' }];
    expect(visibleConversations(tasks).map((task) => task.id)).toEqual(['pinned', 'new', 'old']);
    expect(visibleConversations(tasks, true).map((task) => task.id)).toEqual(['archived']);
    expect(tasks[0].id).toBe('new');
  });
  it('keeps the popover inside the viewport at the bottom and right edges', () => {
    expect(menuPosition({ right: 790, bottom: 590 }, { width: 220, height: 190 }, { width: 800, height: 600 })).toEqual({ left: 572, top: 402 });
    expect(menuPosition({ right: 10, bottom: 10 }, { width: 220, height: 190 }, { width: 800, height: 600 })).toEqual({ left: 8, top: 14 });
  });
  it('opens the menu, updates labels, navigates by keyboard and returns focus on Escape', () => {
    const f = fixture({ id: 'one', pinned: true, archived: true });
    f.click(f.trigger);
    expect(f.menu.open).toBe(true); expect(f.document.activeElement).toBe(f.items[0]);
    expect(f.pinLabel.textContent).toBe('取消置顶'); expect(f.archiveLabel.textContent).toBe('移回最近对话');
    f.key('ArrowDown'); expect(f.document.activeElement).toBe(f.items[1]);
    f.key('End'); expect(f.document.activeElement).toBe(f.items[3]);
    f.key('ArrowDown'); expect(f.document.activeElement).toBe(f.items[0]);
    f.key('ArrowUp'); expect(f.document.activeElement).toBe(f.items[3]);
    f.key('Home'); expect(f.document.activeElement).toBe(f.items[0]);
    f.key('Escape'); expect(f.menu.open).toBe(false); expect(f.document.activeElement).toBe(f.trigger);
    expect(f.trigger.attributes['aria-expanded']).toBe('false'); expect(f.onAction).not.toHaveBeenCalled();
  });
  it('dispatches the chosen operation once with the correct conversation and does not switch tasks', () => {
    const f = fixture(); f.click(f.trigger); f.click(f.items[2]);
    expect(f.onAction).toHaveBeenCalledOnce(); expect(f.onAction).toHaveBeenCalledWith('archive', 'one'); expect(f.menu.open).toBe(false);
  });
  it('disables operations during active tasks and leaves an explanation', () => {
    const f = fixture({ id: 'one' }, false); f.click(f.trigger);
    expect(f.items.every((item) => item.disabled)).toBe(true); expect(f.note.hidden).toBe(false);
    f.click(f.items[3]); expect(f.onAction).not.toHaveBeenCalled();
  });
  it('supports opening from the keyboard, toggling, and native outside-dismiss without taking an action', () => {
    const f = fixture(); f.key('ArrowDown', f.trigger); expect(f.menu.open).toBe(true);
    f.click(f.trigger); expect(f.menu.open).toBe(false);
    f.click(f.trigger); f.menu.open = false; f.menuEvents.get('toggle')();
    expect(f.trigger.attributes['aria-expanded']).toBe('false'); expect(f.onAction).not.toHaveBeenCalled();
  });
});
