import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchService, taskInput } from './service.js';
import { WorkbenchSessionStore } from './session-store.js';

let root: string;
const services: WorkbenchService[] = [];
const createService = (folder = root) => { const service = new WorkbenchService(folder); services.push(service); return service; };
const input = (prompt: string, mode: 'ask' | 'agent' = 'ask') => taskInput.parse({ prompt, mode, delivery: 'manual', contextPaths: ['code.ts'] });
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-persistence-'));
  await fs.writeFile(path.join(root, 'code.ts'), 'original\n');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close().catch(() => {});
  await fs.remove(root);
});

describe('durable local conversations', () => {
  it('preserves a clarification and its last reception diagnostic across restart, then requires a fresh Diff', async () => {
    const first = createService(); const task = await first.create(input('修改这个文件', 'agent'));
    await first.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, error: '请说明具体修改要求。', operations: [] }));
    task.reception = { version: '0.8.14', elapsedMs: 32000, stream: 'done', streamChars: 76, pageChars: 240,
      users: 0, currentUsers: 0, assistants: 1, matchedBy: 'stream_id', reason: 'returning', busy: false, finished: true };
    expect(task.status).toBe('needs_input'); expect(first.hasActiveWork).toBe(false);
    await first.close();
    const second = createService(); await second.initialize(); const restored = second.get(task.id);
    expect(restored.status).toBe('needs_input'); expect(restored.error).toBe('请说明具体修改要求。');
    expect(restored.reception).toEqual(task.reception); expect(restored.sessionId).toBeUndefined();
    await expect(second.apply(task.id)).rejects.toThrow('不能应用');
    const continued = await second.followUp(task.id, input('把 original 改为 updated', 'agent'));
    expect(continued.conversationId).toBe(task.conversationId); expect(continued.turns[0].status).toBe('needs_input');
    expect(continued.reception).toBeUndefined();
    await second.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId,
      operations: [{ action: 'EDIT_FILE', path: 'code.ts', search: 'original', replace: 'updated' }] }));
    expect(continued.status).toBe('review'); expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('original\n');
  });
  it('allows archiving, unarchiving and deleting a clarification without pretending it is still running', async () => {
    const service = createService(); const task = await service.create(input('Need specifics', 'agent'));
    await service.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, error: 'What should change?', operations: [] }));
    await service.updateTaskMetadata(task.id, { archived: true });
    await expect(service.followUp(task.id, input('Answer'))).rejects.toThrow('归档');
    await service.updateTaskMetadata(task.id, { archived: false }); await service.deleteTask(task.id);
    expect(service.tasks.has(task.id)).toBe(false);
  });
  it('blocks the 41st project conversation without evicting old or pinned records, and counts other projects separately', async () => {
    const first = createService(); const template = await first.create(input('seed')); await first.acceptResponse(template.id, 'Saved answer'); await first.close();
    const records = Array.from({ length: 40 }, (_, index) => ({ ...template, id: crypto.randomUUID(), conversationId: crypto.randomUUID(), title: `Saved ${index}`, pinned: index === 0 }));
    await new WorkbenchSessionStore(root).save(records);
    const service = createService(); await service.initialize();
    await expect(service.create(input('41st'))).rejects.toThrow('不会自动删除');
    expect(service.tasks.size).toBe(40); expect(service.get(records[0].id).pinned).toBe(true);
    const other = path.join(root, 'other'); await fs.mkdir(other); await service.selectProject(other);
    const task = await service.create(taskInput.parse({ prompt: 'New project', mode: 'ask', delivery: 'manual' })); await service.acceptResponse(task.id, 'Answer');
    expect(service.tasks.size).toBe(41); expect(service.get(records[0].id).response).toBe('Saved answer');
    await service.flush(); expect(await new WorkbenchSessionStore(root).load()).toHaveLength(40);
    expect(await new WorkbenchSessionStore(other).load()).toHaveLength(1);
  });
  it('persists names, pins and archives, and restores archives without losing the original conversation', async () => {
    const first = createService(); const task = await first.create(input('Original question'));
    await first.acceptResponse(task.id, 'Original answer');
    await first.updateTaskMetadata(task.id, { title: 'My title', pinned: true, archived: true });
    expect(task.prompt).toBe('Original question'); expect(task.response).toBe('Original answer');
    await expect(first.followUp(task.id, input('Cannot follow archived'))).rejects.toThrow('归档对话');
    await first.close();
    const second = createService(); await second.initialize();
    expect(second.get(task.id)).toMatchObject({ title: 'My title', pinned: true, archived: true, prompt: 'Original question', response: 'Original answer' });
    await second.updateTaskMetadata(task.id, { pinned: false, archived: false });
    const continued = await second.followUp(task.id, input('Continue original'));
    expect(continued.title).toBe('My title'); expect(continued.turns[0].response).toBe('Original answer');
    expect(continued.pinned).toBe(false); expect(continued.archived).toBe(false);
  });
  it('rolls back metadata when storage fails, then allows retry', async () => {
    const service = createService(); const task = await service.create(input('Original title'));
    await service.acceptResponse(task.id, 'answer'); await service.flush();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk denied'));
    await expect(service.updateTaskMetadata(task.id, { title: 'New title', pinned: true })).rejects.toThrow('disk denied');
    expect(service.get(task.id).title).toBe('Original title'); expect(service.get(task.id).pinned).toBeUndefined();
    expect((await new WorkbenchSessionStore(root).load())[0].title).toBe('Original title');
    await service.updateTaskMetadata(task.id, { title: 'New title', pinned: true });
    expect((await new WorkbenchSessionStore(root).load())[0]).toMatchObject({ title: 'New title', pinned: true });
  });
  it('deletes a complete multi-turn conversation durably without touching other conversations or project files', async () => {
    const first = createService();
    const task = await first.create(input('First question'));
    await first.acceptResponse(task.id, 'First answer');
    await first.followUp(task.id, input('Follow-up'));
    await first.acceptResponse(task.id, 'Second answer');
    const kept = await first.create(input('Keep this question'));
    await first.acceptResponse(kept.id, 'Keep this answer');
    const history = path.join(root, '.openbrowser', 'history.json');
    await fs.writeJson(history, [{ summary: 'Keep file operation history' }]);
    expect(await first.deleteTask(task.id)).toEqual({ deleted: task.id });
    expect(() => first.get(task.id)).toThrow('任务不存在');
    expect((await new WorkbenchSessionStore(root).load()).map((item) => item.id)).toEqual([kept.id]);
    await first.close();
    const second = createService(); await second.initialize();
    expect(second.tasks.has(task.id)).toBe(false);
    expect(second.get(kept.id).response).toBe('Keep this answer');
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('original\n');
    expect(await fs.readJson(history)).toEqual([{ summary: 'Keep file operation history' }]);
  });
  it('refuses to delete pending, review and applying tasks until explicitly stopped', async () => {
    const service = createService(); const task = await service.create(input('Edit', 'agent'));
    for (const status of ['preparing', 'awaiting_response', 'review', 'applying']) {
      task.status = status;
      await expect(service.deleteTask(task.id)).rejects.toThrow('请先完成');
      expect(service.tasks.has(task.id)).toBe(true);
    }
    task.status = 'review'; service.cancel(task.id);
    await service.deleteTask(task.id);
    expect(service.tasks.size).toBe(0);
    expect(await new WorkbenchSessionStore(root).load()).toEqual([]);
  });
  it('retains the conversation if saving a deletion fails and allows retry', async () => {
    const service = createService(); const task = await service.create(input('Keep on failure'));
    await service.acceptResponse(task.id, 'Answer'); await service.flush();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk denied'));
    await expect(service.deleteTask(task.id)).rejects.toThrow('disk denied');
    expect(service.get(task.id).response).toBe('Answer');
    expect((await new WorkbenchSessionStore(root).load())[0].id).toBe(task.id);
    await service.deleteTask(task.id);
    expect(await new WorkbenchSessionStore(root).load()).toEqual([]);
  });
  it('persists deletion in the conversation owner project rather than the currently selected project', async () => {
    const service = createService(); const task = await service.create(input('Project A'));
    await service.acceptResponse(task.id, 'A');
    const other = path.join(root, 'other'); await fs.mkdir(other);
    await service.selectProject(other);
    const kept = await service.create(taskInput.parse({ prompt: 'Project B', mode: 'ask', delivery: 'manual' }));
    await service.acceptResponse(kept.id, 'B');
    await service.deleteTask(task.id);
    expect(await new WorkbenchSessionStore(root).load()).toEqual([]);
    expect((await new WorkbenchSessionStore(other).load()).map((item) => item.id)).toEqual([kept.id]);
  });
  it('restores completed answers and continues the same ID with freshly read files', async () => {
    const first = createService();
    const task = await first.create(input('Explain code'));
    await first.acceptResponse(task.id, 'The file says original.');
    await first.close();
    const second = createService(); await second.initialize();
    expect(second.get(task.id).status).toBe('complete');
    expect(second.get(task.id).response).toBe('The file says original.');
    await fs.writeFile(path.join(root, 'code.ts'), 'changed after restart\n');
    const continued = await second.followUp(task.id, input('What changed?'));
    expect(continued.conversationId).toBe(task.conversationId);
    expect(continued.turns[0].response).toContain('says original');
    expect(continued.promptMessage).toContain('changed after restart');
  });
  it('restores pending and review tasks as paused without replay or inherited approval', async () => {
    const first = createService();
    const pending = await first.create(input('Waiting'));
    await first.close();
    const second = createService(); await second.initialize();
    expect(second.get(pending.id).status).toBe('failed');
    expect(second.get(pending.id).sessionId).toBeUndefined();
    const task = await second.followUp(pending.id, input('Edit code', 'agent'));
    await second.acceptResponse(task.id, JSON.stringify({ conversationId: task.conversationId, operations: [{ action: 'EDIT_FILE', path: 'code.ts', content: 'proposed\n' }] }));
    expect(task.status).toBe('review'); await second.close();
    const third = createService(); await third.initialize();
    expect(third.get(task.id).status).toBe('failed');
    expect(third.get(task.id).response).toContain('proposed');
    expect(third.get(task.id).plans).toEqual([]);
    await expect(third.apply(task.id)).rejects.toThrow('不能应用');
    expect(await fs.readFile(path.join(root, 'code.ts'), 'utf8')).toBe('original\n');
  });
  it('never claims an interrupted application was rolled back', async () => {
    const first = createService(); const task = await first.create(input('Interrupted', 'agent'));
    task.status = 'applying'; await first.close();
    const second = createService(); await second.initialize();
    expect(second.get(task.id).status).toBe('failed');
    expect(second.get(task.id).error).toContain('文件状态尚未确认');
    expect(second.get(task.id).error).toContain('不会自动重放');
  });
  it('does not persist source context, transient connections or executable plans', async () => {
    const first = createService(); const task = await first.create(input('Private transcript'));
    task.sessionId = 'do-not-save-session'; await first.close();
    const data = await fs.readJson(new WorkbenchSessionStore(root).file);
    expect(data.version).toBe(1);
    expect(data.tasks[0]).not.toHaveProperty('sessionId');
    expect(data.tasks[0]).not.toHaveProperty('plans');
    expect(data.tasks[0]).not.toHaveProperty('promptMessage');
    expect(data.tasks[0]).not.toHaveProperty('fingerprints');
  });
  it('loads project records only after explicitly selecting that project', async () => {
    const other = path.join(root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'code.ts'), 'other');
    const first = createService(); const task = await first.create(input('Project A')); await first.acceptResponse(task.id, 'A');
    await first.selectProject(other); const taskB = await first.create(input('Project B')); await first.acceptResponse(taskB.id, 'B'); await first.close();
    const second = createService(); await second.initialize();
    expect(second.tasks.has(task.id)).toBe(true); expect(second.tasks.has(taskB.id)).toBe(false);
    await second.selectProject(other);
    expect(second.get(taskB.id).response).toBe('B');
    await expect(second.followUp(task.id, input('wrong project'))).rejects.toThrow('所属的项目');
  });
  it('preserves corrupt or wrong-project records without silently overwriting them', async () => {
    const first = createService(); await first.create(input('saved')); await first.close();
    const store = new WorkbenchSessionStore(root);
    const valid = await fs.readJson(store.file);
    await fs.writeFile(store.file, '{corrupt');
    await expect(new WorkbenchSessionStore(root).load()).rejects.toThrow('原文件已保留');
    expect(await fs.readFile(store.file, 'utf8')).toBe('{corrupt');
    valid.tasks[0].root = path.dirname(root); await fs.writeJson(store.file, valid);
    await expect(new WorkbenchSessionStore(root).load()).rejects.toThrow('无法恢复');
  });
  it('keeps the previous snapshot intact if atomic replacement fails', async () => {
    const service = createService(); const task = await service.create(input('saved')); await service.close();
    const store = new WorkbenchSessionStore(root); const previous = await fs.readFile(store.file, 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk denied'));
    await expect(store.save([{ ...task, response: 'new text' }])).rejects.toThrow('disk denied');
    expect(await fs.readFile(store.file, 'utf8')).toBe(previous);
    expect((await fs.readdir(path.dirname(store.file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
