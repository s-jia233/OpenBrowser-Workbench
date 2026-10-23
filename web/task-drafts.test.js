import { describe, expect, it } from 'vitest';
import { createTaskDraftStore, followupDraftKey, replyDraftKey } from './task-drafts.js';
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const task = { id, turns: [], attempt: 1, promptMessage: 'Current prompt' };
function storage() {
  const entries = new Map();
  return { entries, getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key), key: (index) => [...entries.keys()][index], get length() { return entries.size; } };
}

describe('local task text drafts', () => {
  it('restores new-task, follow-up and reply text after a reload without interpreting content', () => {
    const disk = storage(), first = createTaskDraftStore(disk, 'C:\\Project A');
    const values = { new: '修复登录\n<script>data</script>', [followupDraftKey(task)]: '继续问', [replyDraftKey(task)]: '{"answer":"待导入"}' };
    for (const [key, text] of Object.entries(values)) expect(first.save(key, text)).toBe(true);
    const restored = createTaskDraftStore(disk, 'C:\\Project A');
    for (const [key, text] of Object.entries(values)) expect(restored.load(key)).toBe(text);
  });
  it('isolates projects, tasks, turns, attempts and context/tool rounds', () => {
    const disk = storage(), a = createTaskDraftStore(disk, 'A'), b = createTaskDraftStore(disk, 'B');
    a.save('new', 'project A'); a.save(followupDraftKey(task), 'first conversation'); a.save(replyDraftKey(task), 'first JSON');
    expect(b.load('new')).toBe(''); expect(a.load(followupDraftKey({ ...task, id: otherId }))).toBe('');
    expect(a.load(followupDraftKey({ ...task, turns: [{}] }))).toBe('');
    expect(a.load(replyDraftKey({ ...task, attempt: 2 }))).toBe('');
    expect(a.load(replyDraftKey({ ...task, promptMessage: 'New tool result' }))).toBe('');
  });
  it('removes only the deleted conversation drafts in the current project', () => {
    const disk = storage(), a = createTaskDraftStore(disk, 'A'), b = createTaskDraftStore(disk, 'B');
    for (const store of [a, b]) { store.save('new', 'new draft'); store.save(followupDraftKey(task), 'follow-up'); store.save(replyDraftKey(task), 'reply'); }
    a.save(followupDraftKey({ ...task, id: otherId }), 'keep');
    expect(a.clearTask(id)).toBe(true);
    expect(a.load(followupDraftKey(task))).toBe(''); expect(createTaskDraftStore(disk, 'A').load(replyDraftKey(task))).toBe('');
    expect(a.load('new')).toBe('new draft'); expect(a.load(followupDraftKey({ ...task, id: otherId }))).toBe('keep');
    expect(b.load(replyDraftKey(task))).toBe('reply');
  });
  it('clears successfully sent or emptied drafts without clearing other inputs', () => {
    const disk = storage(), store = createTaskDraftStore(disk, 'A');
    store.save('new', 'sent'); store.save(followupDraftKey(task), 'unsent'); expect(store.save('new', '')).toBe(true);
    expect(createTaskDraftStore(disk, 'A').load('new')).toBe(''); expect(store.load(followupDraftKey(task))).toBe('unsent');
  });
  it('keeps an in-tab copy and reports failure when browser storage is unavailable', () => {
    const store = createTaskDraftStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } }, 'A');
    expect(store.load('new')).toBe(''); expect(store.save('new', 'keep input')).toBe(false); expect(store.load('new')).toBe('keep input');
    expect(store.save('new', '')).toBe(false); expect(store.load('new')).toBe('');
  });
  it('ignores malformed records and rejects oversized text without truncating a saved draft', () => {
    const disk = storage(), store = createTaskDraftStore(disk, 'A');
    store.save('new', 'keep'); expect(store.save('new', 'x'.repeat(16001))).toBe(false); expect(store.load('new')).toBe('keep');
    const key = [...disk.entries.keys()][0];
    for (const bad of ['{broken', '{"version":2,"text":"wrong"}', '{"version":1,"text":42}', JSON.stringify({ version: 1, text: 'x'.repeat(16001) })]) {
      disk.setItem(key, bad); expect(createTaskDraftStore(disk, 'A').load('new')).toBe('');
    }
    expect(store.save('__proto__', 'bad slot')).toBe(false);
  });
});
