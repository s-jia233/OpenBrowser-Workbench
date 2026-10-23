import path from 'node:path';
import fs from 'fs-extra';
import { createHash } from 'node:crypto';
import type { AIResponsePayload, Operation } from '../protocol/index.js';
import { isTextContextFile, makeContextView } from './file-context.js';

type ContextView = ReturnType<typeof makeContextView>;
interface AgentContext { contextFiles: ContextView[]; [key: string]: unknown }
const PRIVATE_PATH = /(^|\/)(\.git|\.openbrowser|node_modules|\.pnpm-store|\.cache|\.venv|\.aws|\.ssh|\.azure|\.kube)(\/|$)|(^|\/)(\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;

/** Read-only bounded tool. No directory, shell, secret, traversal or symlink access. */
export async function expandAgentContext(
  root: string, context: string, requests: NonNullable<AIResponsePayload['contextRequests']>,
  authorize?: (relative: string) => Promise<unknown>,
): Promise<string> {
  const data = JSON.parse(context) as AgentContext;
  const seen = new Set<string>();
  for (const request of requests) {
    const relative = request.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!relative || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\0') ||
      relative.split('/').includes('..') || PRIVATE_PATH.test(relative) || !isTextContextFile(relative) || seen.has(relative)) {
      throw new Error(`补读路径被拒绝或重复：${relative}`);
    }
    seen.add(relative);
    await authorize?.(relative);
    let current = path.resolve(root);
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`补读不允许符号链接：${relative}`);
    }
    const stat = await fs.stat(current);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error(`补读只支持不超过 1 MB 的文本文件：${relative}`);
    const content = await fs.readFile(current, 'utf8');
    if (content.includes('\0')) throw new Error(`不能补读二进制文件：${relative}`);
    const total = content.split('\n').length;
    const start = request.startLine ?? 1;
    const end = Math.min(request.endLine ?? total, total);
    if (start > end) throw new Error(`补读行号超出文件范围：${relative}，共 ${total} 行`);
    const view = makeContextView({ path: relative, language: path.extname(relative).slice(1), content, truncated: false }, start, end);
    data.contextFiles = data.contextFiles.filter((file) => file.path !== relative);
    data.contextFiles.push(view);
    if (JSON.stringify(data).length > 140_000) throw new Error('补读内容过长，请缩小文件范围或按行补读');
  }
  return JSON.stringify(data);
}

/** Enforce the partial-context boundary locally, not just in model instructions. */
export async function assertContextEdits(operations: Operation[], context: string, root: string): Promise<void> {
  const data = JSON.parse(context) as AgentContext;
  const changed = new Set<string>();
  for (const operation of operations) {
    const relative = operation.path?.replace(/\\/g, '/').replace(/^\.\//, '');
    const file = data.contextFiles.find((candidate) => candidate.path === relative);
    if (data.discoveryUsed && operation.action === 'EDIT_FILE') {
      if (!file) throw new Error(`搜索结果不是完整源码，请先使用 read_file 读取待修改文件：${relative}`);
      if (file.sourceHash && createHash('sha256').update(await fs.readFile(path.resolve(root, file.path), 'utf8')).digest('hex') !== file.sourceHash) {
        throw new Error(`文件自工具读取后发生变化，请重新读取：${file.path}`);
      }
    }
    if (!file || !(file.partial || file.truncated)) continue;
    if (operation.action !== 'EDIT_FILE' && operation.action !== 'CREATE_FILE') continue;
    if (changed.has(file.path)) throw new Error(`片段文件每轮只允许一次修改，请合并补丁：${file.path}`);
    changed.add(file.path);
    if (operation.action === 'CREATE_FILE' || operation.content !== undefined) throw new Error(`不能用局部片段覆盖整个文件：${file.path}。请使用局部补丁，或通过 contextRequests 补读全文。`);
    if (operation.search !== undefined && (operation.startLine !== undefined || operation.endLine !== undefined)) throw new Error(`不能混用 search 和行号补丁：${file.path}`);
    const actual = await fs.readFile(path.resolve(root, file.path), 'utf8');
    if (file.sourceHash && createHash('sha256').update(actual).digest('hex') !== file.sourceHash) {
      throw new Error(`文件自读取后发生变化：${file.path}，请重新读取上下文`);
    }
    const numbered = file.numberedContent.split('\n');
    const visible = numbered.map((line) => line.replace(/^\s*\d+\| /, '')).join('\n');
    if (operation.search !== undefined) {
      if (!operation.search || !visible.includes(operation.search)) throw new Error(`search 必须来自已读取的片段：${file.path}`);
    } else if (operation.startLine !== undefined && operation.endLine !== undefined) {
      if (!file.includedRanges.some((range) => operation.startLine! >= range.startLine && operation.endLine! <= range.endLine) || operation.endLine < operation.startLine) {
        throw new Error(`修改超出已读取的行号范围：${file.path}，请先补读对应行`);
      }
      const actualLines = actual.split('\n');
      const first = file.includedRanges[0].startLine;
      for (let line = operation.startLine; line <= operation.endLine; line++) {
        if (actualLines[line - 1] !== numbered[line - first]?.replace(/^\s*\d+\| /, '')) {
          throw new Error(`修改涉及未完整读取或已变化的行：${file.path}:${line}，请先补读`);
        }
      }
    } else {
      throw new Error(`片段修改必须使用 search/replace 或原始行号补丁：${file.path}`);
    }
  }
}
