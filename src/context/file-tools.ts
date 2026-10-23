import path from 'node:path';
import fs from 'fs-extra';
import { opendir } from 'node:fs/promises';
import type { FileToolRequest } from '../protocol/index.js';
import { isTextContextFile } from './file-context.js';
import { expandAgentContext } from './agent-context.js';

export const MAX_FILE_TOOL_ROUNDS = 6;
const BLOCKED = /(^|\/)(node_modules|dist|build|coverage|__pycache__|\.git|\.openbrowser|\.pnpm-store|\.cache|\.venv|\.next|\.turbo|\.aws|\.ssh|\.azure|\.kube|\.secrets)(\/|$)|(^|\/)(\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|jks|keystore|tsbuildinfo))$/i;
const normalize = (relative: string) => relative.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';

/** Policy is checked on explicit paths and discovered files, never via a shell. */
async function resolveReadOnly(root: string, requested: string, authorize?: (relative: string) => Promise<unknown>): Promise<string> {
  const relative = normalize(requested);
  if (path.isAbsolute(relative) || relative.includes(':') || relative.includes('\0') || relative.split('/').some((part) => part === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) || BLOCKED.test(relative)) throw new Error('路径超出允许读取的项目范围或属于敏感/生成文件');
  await authorize?.(relative);
  let target = path.resolve(root);
  if (relative !== '.') {
    for (const part of relative.split('/')) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('只读工具不允许符号链接');
    }
  }
  return target;
}

interface ToolResult { tool: string; path: string; ok: boolean; [key: string]: unknown }
interface ScanBudget { entries: number; bytes: number; deadline: number }
const exhausted = (budget: ScanBudget) => budget.entries >= 5000 || budget.bytes >= 8_000_000 || Date.now() >= budget.deadline;

async function listFiles(root: string, target: string, relative: string, depth: number, budget: ScanBudget, authorize?: (relative: string) => Promise<unknown>): Promise<ToolResult> {
  if (!(await fs.stat(target)).isDirectory()) throw new Error('列目录需要文件夹路径');
  const entries: { path: string; type: string }[] = [];
  const queue = [{ target, relative: relative === '.' ? '' : relative, depth: 1 }];
  let characters = 0;
  let truncated = false;
  outer: for (let index = 0; index < queue.length; index++) {
    const folder = queue[index];
    await resolveReadOnly(root, folder.relative || '.', authorize);
    const children = await opendir(folder.target);
    for await (const child of children) {
      if (exhausted(budget)) { truncated = true; break outer; }
      budget.entries++;
      const name = folder.relative ? `${folder.relative}/${child.name}` : child.name;
      if (child.isSymbolicLink() || BLOCKED.test(name) || (!child.isFile() && !child.isDirectory())) continue;
      if (entries.length >= 80 || characters + name.length > 4000) { truncated = true; break outer; }
      entries.push({ path: name, type: child.isDirectory() ? 'directory' : 'file' }); characters += name.length;
      if (child.isDirectory() && folder.depth < depth) queue.push({ target: path.join(folder.target, child.name), relative: name, depth: folder.depth + 1 });
    }
  }
  entries.sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
  return { tool: 'list_files', path: relative, ok: true, entries, depth, truncated };
}

async function searchFiles(root: string, target: string, request: Extract<FileToolRequest, { tool: 'search' }>, budget: ScanBudget,
  authorize?: (relative: string) => Promise<unknown>): Promise<ToolResult> {
  const hits: { path: string; line: number; column: number; text: string; clipped: boolean }[] = [];
  const query = request.caseSensitive ? request.query : request.query.toLowerCase();
  let scannedFiles = 0;
  let skippedFiles = 0;
  let resultSize = 0;
  let truncated = false;
  const inspect = async (relative: string) => {
    if (BLOCKED.test(relative) || !isTextContextFile(relative)) { skippedFiles++; return; }
    const file = await resolveReadOnly(root, relative, authorize);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 1_000_000 || budget.bytes + stat.size > 8_000_000) { skippedFiles++; truncated = true; return; }
    budget.bytes += stat.size;
    const content = await fs.readFile(file, 'utf8');
    if (content.includes('\0')) { skippedFiles++; return; }
    scannedFiles++;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (Date.now() >= budget.deadline) { truncated = true; return; }
      const line = lines[index];
      const column = (request.caseSensitive ? line : line.toLowerCase()).indexOf(query);
      if (column < 0) continue;
      const start = Math.max(0, column - 60);
      const text = line.slice(start, start + 240);
      if (hits.length >= 30 || resultSize + relative.length + text.length > 6000) { truncated = true; return; }
      hits.push({ path: relative, line: index + 1, column: column + 1, text, clipped: start > 0 || line.length > start + 240 });
      resultSize += relative.length + text.length;
    }
  };
  if ((await fs.stat(target)).isFile()) { budget.entries++; await inspect(normalize(request.path)); }
  else {
    const queue = [target];
    outer: for (let index = 0; index < queue.length; index++) {
      const folder = queue[index];
      const name = path.relative(root, folder).replace(/\\/g, '/') || '.';
      try {
        await resolveReadOnly(root, name, authorize);
        const directory = await opendir(folder);
        for await (const child of directory) {
          if (exhausted(budget) || hits.length >= 30 || resultSize >= 6000) { truncated = true; break outer; }
          budget.entries++;
          const absolute = path.join(folder, child.name);
          const relative = path.relative(root, absolute).replace(/\\/g, '/');
          if (child.isSymbolicLink() || BLOCKED.test(relative)) continue;
          if (child.isDirectory()) queue.push(absolute);
          else if (child.isFile()) {
            try { await inspect(relative); } catch { skippedFiles++; truncated = true; }
          }
        }
      } catch { skippedFiles++; truncated = true; }
    }
  }
  return { tool: 'search', path: normalize(request.path), query: request.query, caseSensitive: request.caseSensitive, ok: true,
    hits, scannedFiles, skippedFiles, truncated, note: 'Matches are location hints, not complete source. Read the relevant lines before editing.' };
}

export async function runFileTools(root: string, context: string, requests: FileToolRequest[], remainingRounds: number,
  authorize?: (relative: string) => Promise<unknown>): Promise<{ context: string; results: ToolResult[] }> {
  if (!requests.length || requests.length > 4) throw new Error('每轮只允许 1–4 个只读工具请求');
  let updated = context;
  const results: ToolResult[] = [];
  const budget: ScanBudget = { entries: 0, bytes: 0, deadline: Date.now() + 4000 };
  for (const request of requests) {
    const relative = normalize(request.path);
    try {
      if (exhausted(budget)) throw new Error('本轮只读工具扫描预算已用完，请缩小目录后重试');
      const target = await resolveReadOnly(root, relative, authorize);
      if (request.tool === 'list_files') results.push(await listFiles(root, target, relative, request.depth, budget, authorize));
      else if (request.tool === 'search') results.push(await searchFiles(root, target, request, budget, authorize));
      else {
        updated = await expandAgentContext(root, updated, [{ path: relative, startLine: request.startLine, endLine: request.endLine }], authorize);
        const view = JSON.parse(updated).contextFiles.find((file: { path: string }) => file.path === relative);
        results.push({ tool: 'read_file', path: relative, ok: true, includedRanges: view.includedRanges, partial: view.partial, totalLines: view.totalLines });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      results.push({ tool: request.tool, path: relative, ok: false, error: code ? `读取失败（${code}），请检查项目内路径与权限` : (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    }
  }
  const data = JSON.parse(updated);
  // Keep complete recent records, never cut JSON or replay an unbounded transcript.
  const history: ToolResult[] = [...(data.toolResults ?? []), ...results].slice(-8);
  while (history.length && JSON.stringify(history).length > 20000) history.shift();
  data.toolResults = history;
  data.discoveryUsed = true;
  data.toolBudget = { remainingRounds, maxRequestsPerRound: 4 };
  if (JSON.stringify(data).length > 140000) throw new Error('工具结果与上下文超过大小上限，请缩小任务范围');
  return { context: JSON.stringify(data), results };
}
