import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import type { WorkbenchTask } from './service.js';
import { aiIdentitySchema } from '../shared/ai-identity.js';
import { executionRunSchema } from './execution.js';
import { browserReceptionSchema } from '../shared/browser-reception.js';

export const collaborationSource = z.object({
  roundId: z.string().uuid(), jobId: z.string().uuid(), label: z.string().max(80),
  taskSummary: z.string().max(8000).default(''),
  snapshotDigest: z.string().length(64), currentDigest: z.string().length(64),
  requestId: z.string().uuid(), requestDigest: z.string().length(64),
});

const turn = z.object({
  prompt: z.string().max(16000), response: z.string().max(700000), mode: z.enum(['ask', 'agent']),
  status: z.string().max(40), error: z.string().max(100000).optional(), changes: z.array(z.string().max(2048)).max(60),
  ai: aiIdentitySchema.optional(), manualResponse: z.boolean().optional(),
  executionRuns: z.array(executionRunSchema).max(3).default([]),
});
const record = z.object({
  id: z.string().uuid(), conversationId: z.string().uuid(), root: z.string().min(1).max(2048),
  title: z.string().max(16000), prompt: z.string().max(16000), response: z.string().max(700000),
  pinned: z.boolean().optional(), archived: z.boolean().optional(),
  mode: z.enum(['ask', 'agent']), delivery: z.enum(['manual', 'browser']),
  status: z.enum(['preparing', 'awaiting_response', 'review', 'applying', 'complete', 'failed', 'cancelled', 'rejected', 'needs_input']),
  createdAt: z.string().datetime(), attempt: z.number().int().min(0).max(3),
  contextPaths: z.array(z.string().max(512)).max(30), attachedFiles: z.array(z.string().max(2048)).max(100),
  scripts: z.array(z.enum(['typecheck', 'test', 'lint', 'build'])).max(4),
  turns: z.array(turn).max(30), error: z.string().max(100000).optional(),
  logs: z.array(z.object({ time: z.string(), text: z.string().max(6000) })).max(180),
  savedChanges: z.array(z.string().max(2048)).max(60).default([]),
  ai: aiIdentitySchema.optional(), manualResponse: z.boolean().optional(),
  collaborationSource: collaborationSource.optional(), browserTargetId: z.string().max(150).optional(),
  executionRuns: z.array(executionRunSchema).max(3).default([]),
  reception: browserReceptionSchema.optional(),
});
const envelope = z.object({ version: z.literal(1), tasks: z.array(record).max(40) });
export type SavedTask = z.infer<typeof record>;

/** Local transcripts only. Never persist executable plans, approvals or live sessions. */
export class WorkbenchSessionStore {
  private readonly directory: string;
  readonly file: string;
  constructor(private readonly root: string) {
    this.directory = path.join(root, '.openbrowser');
    this.file = path.join(this.directory, 'workbench-sessions.json');
  }

  private async checkPaths(): Promise<void> {
    for (const target of [this.directory, this.file]) {
      try {
        if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('会话存储不允许符号链接');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  async load(): Promise<SavedTask[]> {
    await this.checkPaths();
    try {
      if ((await fs.stat(this.file)).size > 64 * 1024 * 1024) throw new Error('会话文件超过 64 MB 上限');
      const data = envelope.parse(await fs.readJson(this.file));
      const ids = new Set<string>();
      for (const task of data.tasks) {
        if (path.resolve(task.root) !== path.resolve(this.root) || ids.has(task.id)) throw new Error('会话所属项目不符或编号重复');
        ids.add(task.id);
      }
      return data.tasks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`无法恢复会话文件，原文件已保留，请备份并检查：${this.file}`, { cause: error });
    }
  }

  async save(tasks: WorkbenchTask[]): Promise<void> {
    await this.checkPaths();
    // Validation strips transient state and constrains every restored field.
    const data = envelope.parse({ version: 1, tasks: tasks.map((task) => ({
      ...task, savedChanges: task.plans.length ? task.plans.map((plan) => `${plan.operation.action} ${plan.operation.path ?? ''}`) : task.savedChanges ?? [],
    })) });
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new Error('会话存储超过 64 MB，未覆盖已有记录');
    await fs.ensureDir(this.directory);
    const temporary = path.join(this.directory, `workbench-${crypto.randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(json, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.file);
    }
    catch (error) { await fs.remove(temporary); throw error; }
  }
}
