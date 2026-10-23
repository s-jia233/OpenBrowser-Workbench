import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import fg from 'fast-glob';
import { z } from 'zod';
import { scanProject, loadContextFiles, formatAgentContextJson, formatContextMarkdown, parseAtRefs, CONTEXT_IGNORE, isTextContextFile } from '../context/index.js';
import { parseAIResponse } from '../parser/index.js';
import { expandAgentContext, assertContextEdits } from '../context/agent-context.js';
import { runFileTools, MAX_FILE_TOOL_ROUNDS } from '../context/file-tools.js';
import { planOperations, executeOperations, FileTransactionError, type PlannedOperation } from '../operations/index.js';
import type { FileOperation } from '../core/index.js';
import { buildAgentSystemPrompt, buildAskSystemPrompt, buildFullMessage } from '../prompts/system.js';
import { createSession, getSession, failSession } from '../server/session-store.js';
import { broadcastBrowserJob, browserConnectionCount, browserConnectionStatus, browserTargets } from '../server/sse-hub.js';
import { shouldDeliverPromptAsFile, PROMPT_FILE_COMPOSER_NOTE, PROMPT_FILE_NAME } from '../shared/prompt-delivery.js';
import { writePromptFile } from '../memory/index.js';
import { runVerificationInSandbox, isVerificationSetupError } from '../verification/index.js';
import { WorkbenchSessionStore, collaborationSource } from './session-store.js';
import { aiIdentitySchema, type AiIdentity } from '../shared/ai-identity.js';
import type { ExecutionRun } from './execution.js';
import type { BrowserReception } from '../shared/browser-reception.js';

const PRIVATE_PART = /(^|\/)(\.git|\.openbrowser|node_modules|\.pnpm-store)(\/|$)|(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const MAX_TASKS = 40;
const TERMINAL = new Set(['complete', 'failed', 'cancelled', 'rejected', 'needs_input']);
export const taskInput = z.object({
  prompt: z.string().trim().min(1).max(16_000),
  mode: z.enum(['ask', 'agent']),
  delivery: z.enum(['browser', 'manual']),
  contextPaths: z.array(z.string().max(512)).max(30).default([]),
  scripts: z.array(z.enum(['typecheck', 'test', 'lint', 'build'])).max(4).default([]),
  browserTargetId: z.string().max(150).optional(),
});
type TaskInput = z.infer<typeof taskInput>;

function resolveBrowserInput(input: TaskInput): TaskInput {
  if (input.delivery !== 'browser') return { ...input, browserTargetId: undefined };
  const targets = browserTargets();
  if (input.browserTargetId) {
    if (!targets.some((target) => target.id === input.browserTargetId)) throw new Error('指定执行网页已离线，请重新选择');
    return input;
  }
  if (targets.length > 1) throw new Error('检测到多个 AI 网页，请选择本轮执行网页');
  // Bind even the sole known page: a new tab must not take over later retries.
  return { ...input, browserTargetId: targets[0]?.id };
}

export const taskMetadataInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, '请选择要更新的对话信息');
export interface WorkbenchTurn {
  prompt: string;
  response: string;
  mode: 'ask' | 'agent';
  status: string;
  error?: string;
  changes: string[];
  ai?: AiIdentity;
  manualResponse?: boolean;
  executionRuns?: ExecutionRun[];
}
export const taskRecoveryInput = taskInput.extend({
  id: z.string().uuid(), conversationId: z.string().uuid(), root: z.string().min(1).max(2048), title: z.string().min(1).max(16000),
  response: z.string().min(1).max(700000),
  turns: z.array(z.object({ prompt: z.string().max(16000), response: z.string().max(700000), mode: z.enum(['ask', 'agent']),
    status: z.enum(['complete', 'failed', 'cancelled', 'rejected', 'needs_input']), error: z.string().optional(), changes: z.array(z.string().max(2048)).max(60), ai: aiIdentitySchema.optional(), manualResponse: z.boolean().optional() })).max(30).default([]),
});
export interface WorkbenchTask {
  id: string;
  root: string;
  title: string;
  pinned?: boolean;
  archived?: boolean;
  prompt: string;
  turns: WorkbenchTurn[];
  mode: 'ask' | 'agent';
  delivery: 'browser' | 'manual';
  status: string;
  createdAt: string;
  attempt: number;
  conversationId: string;
  sessionId?: string;
  promptMessage: string;
  response: string;
  error?: string;
  contextPaths: string[];
  attachedFiles: string[];
  scripts: string[];
  plans: PlannedOperation[];
  logs: { time: string; text: string }[];
  savedChanges?: string[];
  ai?: AiIdentity;
  aiPending?: boolean;
  manualResponse?: boolean;
  collaborationSource?: z.infer<typeof collaborationSource>;
  browserTargetId?: string;
  executionRuns?: ExecutionRun[];
  reception?: BrowserReception;
}
interface TaskPrivate {
  input: TaskInput;
  context: string;
  system: string;
  operations: FileOperation[];
  fingerprints: Map<string, string>;
  consumedSession?: string;
  consuming: boolean;
  contextReads: number;
  toolRounds: number;
  receptionLogs?: number;
}

/** Per-server state: requests never change process.cwd() or the CLI workspace. */
export class WorkbenchService {
  root: string;
  otherWorkflowBusy: () => boolean = () => false;
  get hasActiveWork(): boolean { return this.creating || this.locks.size > 0 || [...this.tasks.values()].some((task) => !TERMINAL.has(task.status)); }
  tasks = new Map<string, WorkbenchTask>();
  private data = new Map<string, TaskPrivate>();
  private locks = new Set<string>();
  private creating = false;
  private timer?: ReturnType<typeof setInterval>;
  private ready?: Promise<void>;
  private dirtyRoots = new Set<string>();
  private persistence = Promise.resolve();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private storageError?: string;
  private closed = false;
  private applications = new Set<Promise<void>>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    this.ready ??= (async () => {
      const saved = await new WorkbenchSessionStore(this.root).load();
      for (const item of saved) {
        if (this.tasks.has(item.id)) continue;
        const interrupted = !TERMINAL.has(item.status);
        const task: WorkbenchTask = { ...item, status: interrupted ? 'failed' : item.status,
          promptMessage: '', plans: [], sessionId: undefined,
          error: interrupted ? (item.status === 'applying'
            ? '上次应用或验证被中断，文件状态尚未确认。请先检查文件和操作历史，再继续；不会自动重放或承诺已经回滚。'
            : '服务重启，本轮已暂停。对话和模型回复已恢复，请继续追问生成新方案；旧批准已失效。') : item.error,
        };
        for (const run of task.executionRuns ?? []) if (run.changes === 'in_progress') {
          run.changes = 'unknown'; if (run.verification === 'running') run.verification = 'unknown';
          run.detail = '执行被中断，文件和验证状态未知。请检查源码与日志，不会自动重放或声称已回滚。';
        }
        this.tasks.set(task.id, task);
        this.data.set(task.id, { input: taskInput.parse(task), context: '',
          system: task.mode === 'agent' ? buildAgentSystemPrompt(task.conversationId) : buildAskSystemPrompt(),
          operations: [], fingerprints: new Map(), consuming: false, contextReads: 0, toolRounds: 0 });
        if (interrupted) this.log(task, task.error!);
      }
    })();
    return this.ready;
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    const batches = [...this.dirtyRoots].map((root) => ({ root, tasks: JSON.parse(JSON.stringify(
      [...this.tasks.values()].filter((task) => task.root === root),
    )) as WorkbenchTask[] }));
    this.dirtyRoots.clear();
    this.persistence = this.persistence.catch(() => {}).then(async () => {
      for (const batch of batches) {
        try { await new WorkbenchSessionStore(batch.root).save(batch.tasks); this.storageError = undefined; }
        catch (error) { this.dirtyRoots.add(batch.root); this.storageError = `会话保存失败：${String(error)}`; throw error; }
      }
    });
    await this.persistence;
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick().catch((error) => { this.storageError = String(error); }); }, 650);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.saveTimer);
    await Promise.all(this.applications);
    for (const task of this.tasks.values()) {
      if (task.sessionId && !TERMINAL.has(task.status)) failSession(task.sessionId, 'Workbench closed');
      this.dirtyRoots.add(task.root);
    }
    await this.flush();
  }

  async workspace() {
    await this.initialize();
    const files = await fg('**/*', {
      cwd: this.root, dot: true, onlyFiles: true, followSymbolicLinks: false,
      ignore: [...CONTEXT_IGNORE, '**/.pnpm-store/**', '**/.env*', '**/*.pem', '**/*.key'],
    });
    const safeFiles = files.filter((file) => !PRIVATE_PART.test(file)).sort();
    let pkg: { name?: string; scripts?: Record<string, string> } = {};
    try { pkg = await fs.readJson(path.join(this.root, 'package.json')); } catch { /* non-Node project */ }
    const scripts = ['typecheck', 'test', 'lint', 'build'].filter((key) => pkg.scripts?.[key]);
    return {
      root: this.root, name: pkg.name || path.basename(this.root), files: safeFiles.slice(0, 3000),
      totalFiles: safeFiles.length, scripts, scriptCommands: Object.fromEntries(scripts.map((key) => [key, pkg.scripts![key]])),
      browserConnections: browserConnectionCount(),
      connection: browserConnectionStatus(),
      persistence: { enabled: true, error: this.storageError ?? null },
    };
  }

  async folders(requested = this.root) {
    if (!path.isAbsolute(requested)) throw new Error('文件夹地址必须是绝对路径');
    const current = await fs.realpath(requested);
    if (!(await fs.stat(current)).isDirectory()) throw new Error('请选择文件夹');
    const entries = await fs.readdir(current, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const roots = process.platform === 'win32'
      ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
        const drive = `${letter}:\\`;
        try { return (await fs.stat(drive)).isDirectory() ? drive : null; } catch { return null; }
      }))).filter((drive): drive is string => drive !== null)
      : ['/'];
    return { current, parent: path.dirname(current) === current ? null : path.dirname(current), home: os.homedir(), roots,
      folders: folders.slice(0, 500).map((entry) => ({ name: entry.name, path: path.join(current, entry.name) })), truncated: folders.length > 500 };
  }

  async selectProject(root: string) {
    await this.initialize();
    if (this.otherWorkflowBusy()) throw new Error('多模型会诊正在进行，请先完成或停止，再切换项目');
    if (!path.isAbsolute(root)) throw new Error('请输入项目的绝对路径');
    if (this.creating || this.locks.size || [...this.tasks.values()].some((task) => !TERMINAL.has(task.status))) {
      throw new Error('请先完成、取消或拒绝当前任务，再切换项目');
    }
    this.creating = true;
    try {
      const resolved = await fs.realpath(root);
      if (!(await fs.stat(resolved)).isDirectory()) throw new Error('项目路径必须是文件夹');
      if (resolved === path.parse(resolved).root) throw new Error('请选择具体项目文件夹');
      await this.flush();
      this.root = resolved;
      this.ready = undefined;
      await this.initialize();
      return await this.workspace();
    } finally { this.creating = false; }
  }

  async safePath(root: string, relative: string): Promise<string> {
    const normalized = relative.replace(/\\/g, '/');
    if (!normalized || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || normalized.split('/').some((p) => p === '..' || p.includes(':')) || PRIVATE_PART.test(normalized)) {
      throw new Error(`不允许访问此路径：${relative}`);
    }
    const absolute = path.resolve(root, relative);
    if (path.relative(root, absolute).startsWith('..')) throw new Error('路径超出项目范围');
    let current = root;
    for (const part of path.relative(root, absolute).split(path.sep)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`不允许符号链接：${relative}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    return absolute;
  }

  async readFile(relative: string) {
    const target = await this.safePath(this.root, relative);
    if (!isTextContextFile(relative)) throw new Error('该文件为二进制格式，暂不提供文本预览');
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error('请选择文件');
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 100_000));
      await fs.read(handle, buffer, 0, buffer.length, 0);
      return { path: relative, content: buffer.toString('utf8'), truncated: stat.size > buffer.length };
    } finally { await fs.close(handle); }
  }

  async create(input: TaskInput, source?: z.infer<typeof collaborationSource>, expectedRoot?: string): Promise<WorkbenchTask> {
    if (this.creating) throw new Error('正在准备任务，请稍候');
    this.creating = true;
    try {
      await this.initialize();
      if (expectedRoot && this.root !== expectedRoot) throw new Error('项目已切换，请重新打开实施确认');
      if (this.otherWorkflowBusy()) throw new Error('多模型会诊正在进行，请先完成或停止，再开始单模型任务');
      return await this.createTask(input, undefined, source && collaborationSource.parse(source));
    }
    finally { this.creating = false; }
  }

  private async createTask(input: TaskInput, identity?: { id: string; conversationId: string; title: string; turns: WorkbenchTurn[] }, source?: z.infer<typeof collaborationSource>): Promise<WorkbenchTask> {
    if (identity && this.tasks.has(identity.id)) throw new Error('此会话已存在，请勿重复恢复');
    if ([...this.tasks.values()].filter((task) => task.root === this.root).length >= MAX_TASKS) throw new Error('当前项目已保留40个会话，请先备份并手动删除不需要的会话；归档不释放名额，旧记录不会自动删除');
    if ([...this.tasks.values()].some((task) => !TERMINAL.has(task.status))) throw new Error('已有进行中的任务，请先完成或取消');
    if (input.delivery === 'browser' && browserConnectionCount() === 0) throw new Error('浏览器扩展尚未连接。请打开扩展，或切换为“手动传递”');
    if (input.delivery === 'browser' && browserConnectionStatus().state === 'no_tab') throw new Error('扩展已连接，但 AI 页面尚未就绪，请登录并刷新 AI 网页');
    input = resolveBrowserInput(input);
    // An adopted model proposal is data, not user-authored @file selection.
    const refs = source ? { cleanPrompt: input.prompt, paths: [] } : parseAtRefs(input.prompt);
    const paths = [...new Set([...input.contextPaths, ...refs.paths])];
    const workspace = await this.workspace();
    const allowed = new Set(workspace.files);
    for (const ref of paths) {
      await this.safePath(this.root, ref);
      if (!allowed.has(ref)) throw new Error(`请在左侧选择具体文件：${ref}`);
      if (!isTextContextFile(ref)) throw new Error(`上下文仅支持文本文件：${ref}`);
    }
    const files = await loadContextFiles(this.root, paths);
    const project = await scanProject(this.root);
    const context = input.mode === 'agent' ? formatAgentContextJson(files, project.summary, [], { prompt: refs.cleanPrompt || input.prompt }) : formatContextMarkdown(files);
    const conversationId = identity?.conversationId || crypto.randomUUID();
    const system = input.mode === 'agent' ? buildAgentSystemPrompt(conversationId) : buildAskSystemPrompt();
    const task: WorkbenchTask = {
      id: identity?.id || crypto.randomUUID(), root: this.root, title: identity?.title || (source ? `${source.label} · 实施任务` : refs.cleanPrompt || input.prompt), prompt: refs.cleanPrompt || input.prompt, turns: identity?.turns || [],
      mode: input.mode, delivery: input.delivery, createdAt: new Date().toISOString(),
      status: 'preparing', attempt: 0, conversationId, promptMessage: '', response: '',
      contextPaths: paths, attachedFiles: files.map((file) => file.path), scripts: input.scripts,
      plans: [], logs: [],
      collaborationSource: source, browserTargetId: input.browserTargetId,
    };
    this.tasks.set(task.id, task);
    this.data.set(task.id, { input, context, system, operations: [], fingerprints: new Map(), consuming: false, contextReads: 0, toolRounds: 0 });
    this.log(task, `已读取 ${files.length} 个上下文文件；修改前需要逐次审核。`);
    try { await this.dispatch(task); }
    catch (error) { task.status = 'failed'; task.error = String(error); this.log(task, task.error); }
    return task;
  }

  async followUp(id: string, input: TaskInput): Promise<WorkbenchTask> {
    await this.initialize();
    if (this.otherWorkflowBusy()) throw new Error('多模型会诊正在进行，请先完成或停止，再继续单模型追问');
    if (this.creating) throw new Error('正在准备任务，请稍候');
    this.creating = true;
    try {
      const task = this.get(id);
      if (task.archived) throw new Error('请先将归档对话移回最近对话，再继续追问');
      if (!TERMINAL.has(task.status) || this.locks.has(task.root)) throw new Error('请先完成、停止或拒绝本轮方案，再继续追问');
      if ([...this.tasks.values()].some((other) => other.id !== id && !TERMINAL.has(other.status))) throw new Error('请先完成其他进行中的任务');
      if (task.root !== this.root) throw new Error('请先切换回该会话所属的项目，再继续追问');
      if (task.turns.length >= 30) throw new Error('当前会话已达到 31 轮，请新建任务以控制上下文长度');
      if (input.delivery === 'browser' && browserConnectionCount() === 0) throw new Error('扩展正在重连，请稍后重试或选择手动传递');
      if (input.delivery === 'browser' && browserConnectionStatus().state === 'no_tab') throw new Error('扩展已连接，但 AI 页面尚未就绪，请登录并刷新 AI 网页');
      input = resolveBrowserInput(input);
      const refs = parseAtRefs(input.prompt);
      const paths = [...new Set([...input.contextPaths, ...refs.paths])];
      const allowed = new Set((await this.workspace()).files);
      for (const ref of paths) {
        await this.safePath(task.root, ref);
        if (!allowed.has(ref) || !isTextContextFile(ref)) throw new Error(`请选择可读取的文本文件：${ref}`);
      }
      const files = await loadContextFiles(task.root, paths);
      const project = await scanProject(task.root);
      const data = this.data.get(id)!;
      task.turns.push({ prompt: task.prompt, response: task.response, mode: task.mode, status: task.status, error: task.error,
        ai: task.ai, manualResponse: task.manualResponse,
        executionRuns: task.executionRuns,
        changes: task.plans.length ? task.plans.map((plan) => `${plan.operation.action} ${plan.operation.path || ''}`) : task.savedChanges ?? [] });
      task.savedChanges = undefined;
      task.executionRuns = [];
      task.prompt = refs.cleanPrompt || input.prompt;
      task.mode = input.mode; task.delivery = input.delivery; task.contextPaths = paths;
      task.browserTargetId = input.browserTargetId;
      task.scripts = input.mode === 'ask' ? [] : input.scripts;
      task.attachedFiles = files.map((file) => file.path);
      task.attempt = 0; task.response = ''; task.plans = []; task.error = undefined; task.sessionId = undefined;
      task.status = 'preparing';
      data.input = input; data.operations = []; data.fingerprints.clear(); data.consumedSession = undefined;
      data.contextReads = 0;
      data.toolRounds = 0;
      data.context = input.mode === 'agent' ? formatAgentContextJson(files, project.summary, [], { prompt: task.prompt }) : formatContextMarkdown(files);
      data.system = input.mode === 'agent' ? buildAgentSystemPrompt(task.conversationId) : buildAskSystemPrompt();
      this.log(task, `继续第 ${task.turns.length + 1} 轮，重新读取 ${files.length} 个上下文文件。`);
      try { await this.dispatch(task); }
      catch (error) { task.status = 'failed'; task.error = String(error); this.log(task, task.error); }
      return task;
    } finally { this.creating = false; }
  }

  get(id: string): WorkbenchTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error('任务不存在，请切换到所属项目或新建任务');
    this.syncTaskAi(task);
    return task;
  }

  async deleteTask(id: string): Promise<{ deleted: string }> {
    await this.initialize();
    const task = this.get(id);
    const data = this.data.get(id);
    if (this.creating || data?.consuming || this.locks.has(task.root) || !TERMINAL.has(task.status)) {
      throw new Error('请先完成、停止或拒绝正在进行的任务，再删除对话');
    }
    // Hold the creation lock until the durable snapshot is updated. A failed
    // save must leave the conversation available, not report false success.
    this.creating = true;
    try {
      this.tasks.delete(id);
      this.data.delete(id);
      this.dirtyRoots.add(task.root);
      try { await this.flush(); }
      catch (error) {
        this.tasks.set(id, task);
        if (data) this.data.set(id, data);
        this.dirtyRoots.add(task.root);
        throw error;
      }
      return { deleted: id };
    } finally { this.creating = false; }
  }

  async updateTaskMetadata(id: string, patch: z.infer<typeof taskMetadataInput>): Promise<WorkbenchTask> {
    await this.initialize();
    patch = taskMetadataInput.parse(patch);
    const task = this.get(id);
    if (this.creating || this.data.get(id)?.consuming || this.locks.has(task.root) || !TERMINAL.has(task.status)) {
      throw new Error('请先完成、停止或拒绝正在进行的任务，再管理对话');
    }
    const previous = { title: task.title, pinned: task.pinned, archived: task.archived };
    this.creating = true;
    try {
      Object.assign(task, patch);
      this.dirtyRoots.add(task.root);
      try { await this.flush(); }
      catch (error) { Object.assign(task, previous); this.dirtyRoots.add(task.root); throw error; }
      return task;
    } finally { this.creating = false; }
  }

  private syncTaskAi(task: WorkbenchTask): void {
    if (!task.sessionId || task.delivery !== 'browser' || task.manualResponse) return;
    const session = getSession(task.sessionId);
    if (!session) return;
    if (session.reception && task.reception !== session.reception) {
      const previous = task.reception, next = session.reception, data = this.data.get(task.id);
      task.reception = next;
      this.dirtyRoots.add(task.root);
      if (data && (data.receptionLogs ?? 0) < 12 && (!previous || previous.reason !== next.reason || previous.stream !== next.stream)) {
        data.receptionLogs = (data.receptionLogs ?? 0) + 1;
        this.log(task, `网页接收诊断：扩展 ${next.version}，${Math.round(next.elapsedMs / 1000)} 秒，流 ${next.stream} / ${next.streamChars} 字，页面 ${next.pageChars} 字，用户 ${next.users} / 本轮 ${next.currentUsers} / 助手 ${next.assistants}，定位 ${next.matchedBy}，阶段 ${next.reason}，生成中 ${next.busy} / 完成信号 ${next.finished}。`);
      }
    }
    task.aiPending = session.status === 'pending';
    if (session.ai && session.ai.host !== task.ai?.host) {
      task.ai = session.ai;
      this.log(task, `本轮实际接单 AI：${session.ai.name}（${session.ai.host}）；具体模型版本未识别。`);
    }
  }

  /** Restore a locally exported reply for a fresh Diff, never auto-apply or re-send it. */
  async recoverTask(snapshot: z.infer<typeof taskRecoveryInput>): Promise<WorkbenchTask> {
    await this.initialize();
    if (this.otherWorkflowBusy()) throw new Error('多模型会诊正在进行，请先完成或停止，再恢复旧方案');
    if (this.creating) throw new Error('正在准备任务，请稍候');
    if (path.resolve(snapshot.root) !== this.root) throw new Error('恢复文件不属于当前项目');
    const existing = this.tasks.get(snapshot.id);
    const existingData = this.data.get(snapshot.id);
    if (existing && (!TERMINAL.has(existing.status) || existing.conversationId !== snapshot.conversationId)) throw new Error('已有会话正在进行或会话编号不符');
    this.creating = true;
    try {
      this.tasks.delete(snapshot.id); this.data.delete(snapshot.id);
      const task = await this.createTask({ ...snapshot, delivery: 'manual' }, snapshot, existing?.collaborationSource);
      this.log(task, '已恢复此前的对话与模型回复，重新生成 Diff；不会自动发送或应用修改。');
      await this.acceptResponse(task.id, snapshot.response);
      return task;
    } catch (error) {
      if (existing && existingData) { this.tasks.set(existing.id, existing); this.data.set(existing.id, existingData); this.dirtyRoots.add(existing.root); }
      throw error;
    } finally { this.creating = false; }
  }

  async acceptResponse(id: string, raw: string): Promise<WorkbenchTask> {
    const task = this.get(id);
    const privateData = this.data.get(id)!;
    if (task.status !== 'awaiting_response' || privateData.consuming) throw new Error('当前任务不接受回复');
    task.manualResponse = true; task.ai = undefined; task.aiPending = false;
    if (task.delivery === 'browser') this.log(task, '本轮回复由手动粘贴提供，无法自动确认来源 AI。');
    privateData.consuming = true;
    try {
      if (task.sessionId) {
        privateData.consumedSession = task.sessionId;
        failSession(task.sessionId, 'Reply supplied manually');
      }
      await this.consume(task, raw);
    } finally { privateData.consuming = false; }
    return task;
  }

  cancel(id: string): WorkbenchTask {
    const task = this.get(id);
    if (task.status === 'applying') throw new Error('正在应用和验证，请等待事务完成');
    if (TERMINAL.has(task.status)) return task;
    task.status = task.status === 'review' ? 'rejected' : 'cancelled';
    if (task.sessionId) failSession(task.sessionId, 'Cancelled by user');
    this.log(task, '已停止任务，未应用待审核修改。');
    return task;
  }

  async apply(id: string): Promise<WorkbenchTask> {
    const task = this.get(id);
    const data = this.data.get(id)!;
    if (task.status !== 'review' || this.locks.has(task.root)) throw new Error('任务当前不能应用');
    this.locks.add(task.root);
    const run: ExecutionRun = { attempt: task.attempt, startedAt: new Date().toISOString(), changes: 'in_progress',
      verification: 'not_run', requested: [...task.scripts], passed: [] };
    const previousRuns = task.executionRuns ?? []; task.executionRuns = [...previousRuns, run];
    task.status = 'applying';
    this.log(task, '审核已批准，正在校验文件版本并应用事务。');
    try { await this.flush(); }
    catch (error) {
      task.status = 'review'; task.executionRuns = previousRuns; this.locks.delete(task.root);
      task.error = '批准记录保存失败，尚未写入项目文件。请检查存储后重新批准本份 Diff。'; this.log(task, task.error);
      throw error;
    }
    // Return immediately to let the browser poll real progress while verification runs.
    const application = (async () => {
      let transactionStarted = false;
      try {
        for (const [relative, expected] of data.fingerprints) {
          if (await this.fingerprint(task.root, relative) !== expected) throw new Error(`文件在审核后发生变化，请重新生成方案：${relative}`);
        }
        transactionStarted = true;
        await executeOperations(data.operations, task.root, {
          conversationId: task.conversationId,
          onStep: (step, detail) => this.log(task, `${step}${detail ? ` · ${detail}` : ''}`),
          verify: async () => {
            if (!task.scripts.length) {
              run.verification = 'skipped';
              this.log(task, '用户未选择验证脚本，本轮仅应用文件修改。');
              return { summary: 'Verification skipped by user' };
            }
            this.log(task, `临时副本验证：${task.scripts.join(', ')}。测试具有本机进程权限。`);
            run.verification = 'running';
            try {
              const result = await runVerificationInSandbox(task.root, {
                scripts: task.scripts, onLog: (message) => this.log(task, message),
                onScriptPassed: (script) => { if (!run.passed.includes(script)) run.passed.push(script); this.log(task, `验证项目完成：${script}`); },
              });
              run.passed = [...result.scripts];
              if (task.scripts.some((script) => !result.scripts.includes(script))) throw new Error('验证未完成全部所选项目，不能作为通过结果');
              run.verification = result.scripts.length ? 'passed' : 'skipped';
              this.log(task, result.summary); return result;
            } catch (error) { run.verification = isVerificationSetupError(error) ? 'setup_failed' : 'failed'; throw error; }
          },
        });
        run.changes = 'applied'; run.finishedAt = new Date().toISOString();
        task.status = 'complete'; task.error = undefined;
        this.log(task, '变更已应用，任务完成。');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.changes = error instanceof FileTransactionError ? (error.rolledBack ? 'rolled_back' : 'rollback_failed') : transactionStarted ? 'unknown' : 'not_applied';
        run.detail = message.slice(-6000); run.finishedAt = new Date().toISOString();
        if (error instanceof FileTransactionError && error.historyError !== undefined) this.log(task, `操作历史保存失败：${error.historyError}`);
        this.log(task, message);
        if (run.changes === 'rollback_failed' || run.changes === 'unknown' || isVerificationSetupError(error) || error instanceof FileTransactionError && error.historyError !== undefined) {
          task.status = 'failed'; task.error = message;
          if (isVerificationSetupError(error)) this.log(task, '这是本机验证环境问题，不会重复发给模型。修复环境后可复用本轮回复重新审核。');
        } else {
          await this.retry(task, message);
        }
      } finally { this.locks.delete(task.root); }
    })().catch((error: unknown) => {
      task.status = 'failed'; task.error = String(error); this.log(task, task.error);
    });
    this.applications.add(application);
    void application.finally(() => this.applications.delete(application));
    return task;
  }

  async history() {
    const file = path.join(this.root, '.openbrowser', 'history.json');
    try {
      const history: unknown = await fs.readJson(file);
      return Array.isArray(history) ? history.slice(-100).reverse() : [];
    } catch { return []; }
  }

  private log(task: WorkbenchTask, text: string): void {
    task.logs.push({ time: new Date().toISOString(), text: text.slice(-6000) });
    if (task.logs.length > 180) task.logs.splice(0, task.logs.length - 180);
    this.dirtyRoots.add(task.root);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush().catch(() => {}); }, 25);
  }

  private async dispatch(task: WorkbenchTask, failure?: string, countAttempt = true): Promise<void> {
    const data = this.data.get(task.id)!;
    if (countAttempt) task.attempt += 1;
    task.plans = []; task.error = failure;
    task.ai = undefined; task.aiPending = task.delivery === 'browser'; task.manualResponse = false;
    task.reception = undefined; data.receptionLogs = 0;
    task.promptMessage = buildFullMessage(task.mode, data.system, task.prompt, data.context, {
      history: task.turns, validationError: failure,
    });
    task.status = 'awaiting_response';
    this.log(task, `第 ${task.attempt}/3 次尝试 · ${task.delivery === 'browser' ? '等待浏览器 AI' : '等待粘贴 AI 回复'}`);
    await this.flush();
    if (task.delivery === 'manual') return;
    const delivery = shouldDeliverPromptAsFile(task.promptMessage) ? 'file' : 'text';
    const composerMessage = delivery === 'file' ? PROMPT_FILE_COMPOSER_NOTE : task.promptMessage;
    const selected = data.input.browserTargetId && browserTargets().find((target) => target.id === data.input.browserTargetId);
    if (data.input.browserTargetId && !selected) throw new Error('指定执行网页已离线，不会改发给其他网页');
    const target = selected ? { clientId: selected.clientId, tabId: selected.tabId } : undefined;
    const session = createSession({ mode: task.mode, prompt: task.prompt, systemPrompt: data.system, message: task.promptMessage, composerMessage, delivery, conversationId: task.conversationId, target });
    task.sessionId = session.id;
    if (delivery === 'file') await writePromptFile(process.cwd(), session.id, task.promptMessage);
    broadcastBrowserJob({ sessionId: session.id, target, mode: task.mode, message: composerMessage, composerMessage, delivery, promptFileName: delivery === 'file' ? PROMPT_FILE_NAME : undefined, systemPrompt: data.system, conversationId: task.conversationId });
  }

  private async consume(task: WorkbenchTask, raw: string): Promise<void> {
    task.response = raw;
    if (task.mode === 'ask') {
      task.status = 'complete'; task.error = undefined;
      this.log(task, '已收到回答，问答任务没有修改文件。');
      return;
    }
    try {
      const payload = parseAIResponse(raw, { conversationId: task.conversationId, onRepair: (message) => this.log(task, message) });
      if (payload.toolRequests) {
        const data = this.data.get(task.id)!;
        try {
          if (data.toolRounds + data.contextReads >= MAX_FILE_TOOL_ROUNDS) throw new Error('已达到 6 轮只读工具上限，请缩小任务后在本会话继续');
          const result = await runFileTools(task.root, data.context, payload.toolRequests,
            MAX_FILE_TOOL_ROUNDS - data.toolRounds - data.contextReads - 1, (relative) => this.safePath(task.root, relative));
          data.context = result.context; data.toolRounds++;
          task.attachedFiles = JSON.parse(data.context).contextFiles.map((file: { path: string }) => file.path);
          for (const entry of result.results) {
            const label = entry.tool === 'list_files' ? '列目录' : entry.tool === 'search' ? '搜索代码' : '读取文件';
            const detail = entry.ok ? (entry.tool === 'search' ? ` · ${(entry.hits as unknown[]).length} 个命中`
              : entry.tool === 'list_files' ? ` · ${(entry.entries as unknown[]).length} 项` : ' · 已读取源码') + (entry.truncated ? '（结果有截断，请缩小范围）' : '') : '';
            this.log(task, `只读工具 ${data.toolRounds + data.contextReads}/6 · ${label} ${entry.path}${detail} · ${entry.ok ? '已完成' : entry.error}。没有修改文件。`);
          }
          await this.dispatch(task, undefined, false);
        } catch (error) {
          task.status = 'failed'; task.error = error instanceof Error ? error.message : String(error);
          this.log(task, `文件发现已暂停：${task.error}`);
        }
        return;
      }
      if (payload.contextRequests) {
        const data = this.data.get(task.id)!;
        try {
          if (data.contextReads >= 2) throw new Error('已达到 2 次补读上限，请缩小任务或手动选择所需文件后继续');
          if (data.toolRounds + data.contextReads >= MAX_FILE_TOOL_ROUNDS) throw new Error('已达到 6 轮只读工具上限，请缩小任务');
          data.context = await expandAgentContext(task.root, data.context, payload.contextRequests, (relative) => this.safePath(task.root, relative));
          data.contextReads += 1;
          const expanded = JSON.parse(data.context);
          if (expanded.discoveryUsed) data.context = JSON.stringify({ ...expanded, toolBudget: { remainingRounds: MAX_FILE_TOOL_ROUNDS - data.toolRounds - data.contextReads, maxRequestsPerRound: 4 } });
          task.attachedFiles = JSON.parse(data.context).contextFiles.map((file: { path: string }) => file.path);
          this.log(task, `第 ${data.contextReads}/2 次按需补读：${payload.contextRequests.map((request) => request.path).join('、')}。没有修改文件。`);
          await this.dispatch(task, undefined, false);
        } catch (error) {
          task.status = 'failed'; task.error = error instanceof Error ? error.message : String(error);
          this.log(task, `补读已停止：${task.error}`);
        }
        return;
      }
      if (payload.error) {
        task.status = 'needs_input'; task.error = payload.error;
        this.log(task, `需要补充信息，请在本任务继续回复：${payload.error}`);
        return;
      }
      const operations = payload.operations ?? [];
      if (operations.length > 60) throw new Error('单次最多允许 60 个文件操作，请缩小任务');
      for (const operation of operations) {
        if (operation.action === 'RUN_COMMAND') throw new Error('不允许模型执行命令，请仅返回文件操作');
        if (operation.path) await this.safePath(task.root, operation.path);
        if (operation.action === 'RENAME_FILE' && operation.replace) await this.safePath(task.root, operation.replace);
      }
      await assertContextEdits(operations, this.data.get(task.id)!.context, task.root);
      const data = this.data.get(task.id)!;
      const fingerprints = new Map<string, string>();
      for (const operation of operations) {
        if (operation.path) fingerprints.set(operation.path, await this.fingerprint(task.root, operation.path));
        if (operation.action === 'RENAME_FILE' && operation.replace) fingerprints.set(operation.replace, await this.fingerprint(task.root, operation.replace));
      }
      const plans = await planOperations(operations, task.root);
      for (const [relative, before] of fingerprints) {
        if (await this.fingerprint(task.root, relative) !== before) throw new Error(`文件在生成 Diff 时发生变化：${relative}`);
      }
      data.operations = operations; data.fingerprints = fingerprints;
      task.plans = plans; task.status = 'review'; task.error = undefined;
      this.log(task, `已生成 ${plans.length} 项修改，等待审核。`);
    } catch (error) { await this.retry(task, error instanceof Error ? error.message : String(error)); }
  }

  private async fingerprint(root: string, relative: string): Promise<string> {
    const target = await this.safePath(root, relative);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) return 'directory';
      return crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private async retry(task: WorkbenchTask, reason: string): Promise<void> {
    task.error = reason;
    if (task.attempt >= 3) {
      task.status = 'failed'; this.log(task, '已达到 3 次尝试上限，请调整任务后重新开始。'); return;
    }
    // External edits and rollback may change the workspace between attempts.
    // Re-read context so the next proposal is based on the actual current files.
    const data = this.data.get(task.id)!;
    const previous = task.mode === 'agent' ? JSON.parse(data.context) : null;
    const refs = [...new Set([...task.contextPaths, ...(previous?.discoveryUsed ? previous.contextFiles.map((file: { path: string }) => file.path) : [])])] as string[];
    for (const ref of refs) await this.safePath(task.root, ref);
    const files = await loadContextFiles(task.root, refs);
    const project = await scanProject(task.root);
    data.context = task.mode === 'agent'
      ? formatAgentContextJson(files, project.summary, [], { prompt: task.prompt })
      : formatContextMarkdown(files);
    if (previous?.discoveryUsed) data.context = JSON.stringify({ ...JSON.parse(data.context), discoveryUsed: true,
      toolBudget: { remainingRounds: MAX_FILE_TOOL_ROUNDS - data.toolRounds - data.contextReads, maxRequestsPerRound: 4 } });
    task.attachedFiles = files.map((file) => file.path);
    this.log(task, `反馈错误并准备下一次方案：${reason}`);
    await this.dispatch(task, reason);
  }

  private async tick(): Promise<void> {
    for (const task of this.tasks.values()) {
      this.syncTaskAi(task);
      const data = this.data.get(task.id)!;
      if (task.status !== 'awaiting_response' || !task.sessionId || data.consuming || data.consumedSession === task.sessionId) continue;
      const session = getSession(task.sessionId);
      if (session && ['pending', 'claimed'].includes(session.status) && Date.now() - Date.parse(session.claimedAt || session.createdAt) > 240_000) {
        failSession(session.id, '等待浏览器回复已超时。请检查 AI 网页；为避免重复提交，没有自动重新发送。可以在本会话继续追问，或改用手动传递。');
      }
      if (!session || !['complete', 'error'].includes(session.status)) continue;
      data.consuming = true; data.consumedSession = task.sessionId;
      try {
        if (session.status === 'complete') await this.consume(task, session.response || '');
        else {
          // Provider errors and quota failures require user action, never automatic redispatch.
          task.status = 'failed'; task.error = session.error || '浏览器连接失败'; this.log(task, task.error);
        }
      } catch (error) {
        task.status = 'failed'; task.error = String(error); this.log(task, task.error);
      } finally { data.consuming = false; this.dirtyRoots.add(task.root); await this.flush(); }
    }
  }
}
