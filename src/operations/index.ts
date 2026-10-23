import { exec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createPatch } from 'diff';
import fs from 'fs-extra';
import type { FileOperation } from '../core/index.js';
import { appendHistory } from '../memory/index.js';
import { expandMkdirOperations, looksLikePowerShellCommand } from './mkdir-normalize.js';
import { sortOperationsByExecutionOrder } from './operation-order.js';

const execAsync = promisify(exec);

export class FileTransactionError extends Error {
  constructor(message: string, readonly rolledBack: boolean, cause: unknown, readonly historyError?: string) {
    super(message, { cause }); this.name = 'FileTransactionError';
  }
}

export interface PlannedOperation {
  operation: FileOperation;
  absolutePath: string;
  diff: string;
}

export interface ExecuteOptions {
  dryRun?: boolean;
  conversationId?: string;
  onStep?: (step: string, detail?: string) => void;
  /** Model-proposed shell commands are denied by default because they cannot be rolled back safely. */
  allowCommands?: boolean;
  /** Runs after file operations, before the transaction is committed. */
  verify?: () => Promise<{ summary: string }>;
}

type PathSnapshot =
  | { absolutePath: string; kind: 'missing' }
  | { absolutePath: string; kind: 'directory' }
  | { absolutePath: string; kind: 'file'; content: Buffer; mode: number };

export async function planOperations(
  operations: FileOperation[],
  projectRoot: string,
): Promise<PlannedOperation[]> {
  const root = path.resolve(projectRoot);
  const plans: PlannedOperation[] = [];
  const normalizedOperations = sortOperationsByExecutionOrder(
    expandMkdirOperations(operations),
  );

  for (const operation of normalizedOperations) {
    if (operation.action === 'RUN_COMMAND') {
      plans.push({
        operation,
        absolutePath: root,
        diff: `RUN_COMMAND ${operation.command ?? ''}`,
      });
      continue;
    }

    if (!operation.path) {
      throw new Error(`${operation.action} requires path`);
    }

    const absolutePath = resolveInsideRoot(root, operation.path);
    await assertNoSymlinkTraversal(root, absolutePath);
    plans.push({
      operation,
      absolutePath,
      diff: await buildDiff(operation, absolutePath, root),
    });
  }

  return plans;
}

export async function executeOperations(
  operations: FileOperation[],
  projectRoot: string,
  options: ExecuteOptions = {},
): Promise<PlannedOperation[]> {
  const plans = await planOperations(operations, projectRoot);

  if (options.dryRun) {
    return plans;
  }

  if (!options.allowCommands && plans.some((plan) => plan.operation.action === 'RUN_COMMAND')) {
    throw new Error(
      'RUN_COMMAND is disabled in the transactional agent loop. Run reviewed commands yourself or configure a separate sandbox policy.',
    );
  }

  const snapshots = await captureSnapshots(plans, projectRoot);

  try {
    for (const plan of plans) {
      await applyOperation(plan, projectRoot, options.onStep);
    }

    const verification = options.verify ? await options.verify() : undefined;

    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      conversationId: options.conversationId,
      mode: 'agent',
      outcome: 'applied',
      summary: `Applied ${plans.length} operation(s)`,
      detail: verification?.summary,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let rollbackError: string | undefined;

    try {
      await restoreSnapshots(snapshots);
    } catch (rollbackFailure) {
      rollbackError = rollbackFailure instanceof Error
        ? rollbackFailure.message
        : String(rollbackFailure);
    }

    let historyError: string | undefined;
    try { await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      conversationId: options.conversationId,
      mode: 'agent',
      outcome: rollbackError ? 'failed' : 'rolled_back',
      summary: rollbackError
        ? `Apply failed and rollback was incomplete: ${reason}`
        : `Rolled back ${plans.length} operation(s): ${reason}`,
      detail: rollbackError,
    }); } catch (failure) { historyError = failure instanceof Error ? failure.message : String(failure); }

    if (rollbackError) {
      throw new FileTransactionError(`${reason}; rollback also failed: ${rollbackError}`, false, error, historyError);
    }
    throw new FileTransactionError(`${reason}; all file changes were rolled back`, true, error, historyError);
  }

  return plans;
}

function resolveInsideRoot(projectRoot: string, relativePath: string): string {
  const absolutePath = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, absolutePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${relativePath}`);
  }

  return absolutePath;
}

async function captureSnapshots(
  plans: PlannedOperation[],
  projectRoot: string,
): Promise<PathSnapshot[]> {
  const paths = new Set<string>();
  const root = path.resolve(projectRoot);

  const addPathAndMissingParents = async (absolutePath: string): Promise<void> => {
    paths.add(absolutePath);
    let parent = path.dirname(absolutePath);
    while (parent !== root && path.relative(root, parent) && !(await fs.pathExists(parent))) {
      paths.add(parent);
      parent = path.dirname(parent);
    }
  };

  for (const plan of plans) {
    if (plan.operation.action === 'RUN_COMMAND') {
      continue;
    }

    await addPathAndMissingParents(plan.absolutePath);
    if (plan.operation.action === 'RENAME_FILE' && plan.operation.replace) {
      await addPathAndMissingParents(resolveInsideRoot(projectRoot, plan.operation.replace));
    }
  }

  const snapshots: PathSnapshot[] = [];
  for (const absolutePath of paths) {
    await assertNoSymlinkTraversal(projectRoot, absolutePath);

    const stat = await lstatIfExists(absolutePath);
    if (!stat) {
      snapshots.push({ absolutePath, kind: 'missing' });
      continue;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic-link targets are not allowed: ${path.relative(projectRoot, absolutePath)}`);
    }
    if (stat.isDirectory()) {
      snapshots.push({ absolutePath, kind: 'directory' });
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported filesystem entry: ${path.relative(projectRoot, absolutePath)}`);
    }

    snapshots.push({
      absolutePath,
      kind: 'file',
      content: await fs.readFile(absolutePath),
      mode: stat.mode,
    });
  }

  return snapshots;
}

async function assertNoSymlinkTraversal(projectRoot: string, absolutePath: string): Promise<void> {
  const root = path.resolve(projectRoot);
  if ((await lstatIfExists(root))?.isSymbolicLink()) {
    throw new Error('Project root must not be a symbolic link');
  }
  const relative = path.relative(root, absolutePath);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (!stat) {
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Path crosses a symbolic link: ${path.relative(root, current)}`);
    }
  }
}

async function lstatIfExists(targetPath: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function restoreSnapshots(snapshots: PathSnapshot[]): Promise<void> {
  const deepestFirst = [...snapshots].sort(
    (left, right) => right.absolutePath.split(path.sep).length - left.absolutePath.split(path.sep).length,
  );

  for (const snapshot of deepestFirst) {
    if (snapshot.kind === 'missing') {
      await fs.remove(snapshot.absolutePath);
    }
  }

  const shallowestFirst = [...snapshots].sort(
    (left, right) => left.absolutePath.split(path.sep).length - right.absolutePath.split(path.sep).length,
  );

  for (const snapshot of shallowestFirst) {
    if (snapshot.kind === 'missing') {
      continue;
    }
    if (snapshot.kind === 'directory') {
      await fs.ensureDir(snapshot.absolutePath);
      continue;
    }

    await fs.ensureDir(path.dirname(snapshot.absolutePath));
    await fs.writeFile(snapshot.absolutePath, snapshot.content, { mode: snapshot.mode });
  }
}

async function buildDiff(
  operation: FileOperation,
  absolutePath: string,
  projectRoot: string,
): Promise<string> {
  const relativePath = path.relative(projectRoot, absolutePath);

  if (operation.action === 'CREATE_FOLDER') {
    return `CREATE_FOLDER ${relativePath}`;
  }

  if (operation.action === 'RENAME_FILE') {
    if (!operation.replace) {
      throw new Error('RENAME_FILE requires replace as destination path');
    }
    resolveInsideRoot(projectRoot, operation.replace);
    return `RENAME_FILE ${relativePath} -> ${operation.replace}`;
  }

  const before = (await fs.pathExists(absolutePath))
    ? await fs.readFile(absolutePath, 'utf8')
    : '';

  if (operation.action === 'DELETE_FILE') {
    return createPatch(relativePath, before, '', 'before', 'after');
  }

  const after = nextContent(operation, before);
  return createPatch(relativePath, before, after, 'before', 'after');
}

async function applyOperation(
  plan: PlannedOperation,
  projectRoot: string,
  onStep?: (step: string, detail?: string) => void,
): Promise<void> {
  const { operation, absolutePath } = plan;

  switch (operation.action) {
    case 'RUN_COMMAND': {
      const cwd = operation.path
        ? resolveInsideRoot(projectRoot, operation.path)
        : projectRoot;
      onStep?.('running command', operation.command);
      await runShellCommand(operation.command ?? '', cwd);
      break;
    }
    case 'CREATE_FOLDER': {
      const relativePath = path.relative(projectRoot, absolutePath);
      onStep?.('creating folder', relativePath);
      await fs.ensureDir(absolutePath);
      break;
    }
    case 'CREATE_FILE': {
      const relativePath = path.relative(projectRoot, absolutePath);
      if (await fs.pathExists(absolutePath)) {
        throw new Error(`CREATE_FILE refuses to overwrite existing path: ${relativePath}`);
      }
      onStep?.('creating file', relativePath);
      await fs.ensureDir(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, operation.content ?? '');
      break;
    }
    case 'EDIT_FILE': {
      const relativePath = path.relative(projectRoot, absolutePath);
      const exists = await fs.pathExists(absolutePath);
      if (!exists) {
        if (!operation.content?.trim()) {
          throw new Error(
            `EDIT_FILE on missing file ${relativePath} requires full content (file will be created)`,
          );
        }
        onStep?.('creating file', `${relativePath} (via EDIT_FILE)`);
        await fs.ensureDir(path.dirname(absolutePath));
        await fs.writeFile(absolutePath, operation.content ?? '');
        break;
      }

      onStep?.('editing file', relativePath);
      const before = await fs.readFile(absolutePath, 'utf8');
      await fs.writeFile(absolutePath, nextContent(operation, before));
      break;
    }
    case 'DELETE_FILE': {
      const relativePath = path.relative(projectRoot, absolutePath);
      if (!(await fs.pathExists(absolutePath))) {
        throw new Error(`DELETE_FILE target does not exist: ${relativePath}`);
      }
      if (!(await fs.lstat(absolutePath)).isFile()) {
        throw new Error(`DELETE_FILE only accepts regular files: ${relativePath}`);
      }
      onStep?.('deleting file', relativePath);
      await fs.remove(absolutePath);
      break;
    }
    case 'RENAME_FILE': {
      const relativePath = path.relative(projectRoot, absolutePath);
      onStep?.('renaming file', relativePath);
      if (!operation.replace) {
        throw new Error('RENAME_FILE requires replace as destination path');
      }
      const destination = resolveInsideRoot(projectRoot, operation.replace);
      if (!(await fs.pathExists(absolutePath))) {
        throw new Error(`RENAME_FILE source does not exist: ${relativePath}`);
      }
      if (!(await fs.lstat(absolutePath)).isFile()) {
        throw new Error(`RENAME_FILE only accepts regular files: ${relativePath}`);
      }
      if (await fs.pathExists(destination)) {
        throw new Error(`RENAME_FILE destination already exists: ${operation.replace}`);
      }
      await fs.ensureDir(path.dirname(destination));
      await fs.move(absolutePath, destination, { overwrite: false });
      break;
    }
    default:
      assertNever(operation.action);
  }
}

async function runShellCommand(command: string, cwd: string): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('RUN_COMMAND is empty');
  }

  const shell = resolveShell(trimmed);

  try {
    const { stdout, stderr } = await execAsync(trimmed, {
      cwd,
      shell,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    if (stdout.trim()) {
      process.stdout.write(`${stdout.trim()}\n`);
    }
    if (stderr.trim()) {
      process.stderr.write(`${stderr.trim()}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Command failed: ${message}`);
  }
}

function resolveShell(command: string): string {
  if (process.platform !== 'win32') {
    return '/bin/sh';
  }

  if (looksLikePowerShellCommand(command)) {
    return 'powershell.exe';
  }

  return process.env.COMSPEC ?? 'cmd.exe';
}

function nextContent(operation: FileOperation, before: string): string {
  if (
    operation.startLine !== undefined &&
    operation.endLine !== undefined &&
    operation.replace !== undefined
  ) {
    return applyLineEdit(
      before,
      operation.startLine,
      operation.endLine,
      operation.replace,
    );
  }

  if (operation.search !== undefined && operation.replace !== undefined) {
    const search = operation.search;
    const replace = operation.replace;
    if (!search || before.indexOf(search) !== before.lastIndexOf(search)) {
      throw new Error(`Search text must be nonempty and unique in ${operation.path}`);
    }
    if (!before.includes(search)) {
      throw new Error(`Search text not found in ${operation.path}`);
    }
    return before.replace(search, replace);
  }

  if (operation.content !== undefined) {
    return operation.content;
  }

  throw new Error(`${operation.action} requires content, line edit, or search/replace`);
}

function applyLineEdit(
  before: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  if (startLine < 1 || endLine < startLine) {
    throw new Error(`Invalid line range ${startLine}-${endLine} for edit`);
  }

  const lines = before.split('\n');
  if (startLine > lines.length + 1) {
    throw new Error(`startLine ${startLine} is beyond end of file (${lines.length} lines)`);
  }

  const startIndex = startLine - 1;
  const endIndex = Math.min(endLine, lines.length);
  const replacementLines = replacement.split('\n');

  return [
    ...lines.slice(0, startIndex),
    ...replacementLines,
    ...lines.slice(endIndex),
  ].join('\n');
}

function assertNever(value: never): never {
  throw new Error(`Unsupported operation: ${value}`);
}
