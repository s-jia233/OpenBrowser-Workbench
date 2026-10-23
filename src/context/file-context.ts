import path from 'node:path';
import { createHash } from 'node:crypto';
import fg from 'fast-glob';
import fs from 'fs-extra';
import { collectProjectDirectories, scanDirectoryTree, type ContextDirectory } from './directory-tree.js';

export const CONTEXT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/.openbrowser/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.pnpm-store/**',
  '**/.cache/**',
  '**/.venv/**',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.azure/**',
  '**/.kube/**',
  '**/__pycache__/**',
  '**/build/**',
  '**/*.tsbuildinfo',
  '**/.env*',
  '**/*.{pem,key,p12,pfx}',
];

/** Binary assets are listed in folder trees but never embedded as text context. */
export const BINARY_CONTEXT_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.mp3',
  '.mp4',
  '.wav',
  '.mov',
  '.avi',
  '.exe',
  '.dll',
  '.bin',
  '.dat',
]);

export function isTextContextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext.length === 0 || !BINARY_CONTEXT_EXTENSIONS.has(ext);
}

const MAX_FILES = 30;
const MAX_FILE_BYTES = 32_000;
const MAX_TOTAL_BYTES = 120_000;

export interface ContextFile {
  path: string;
  language: string;
  content: string;
  truncated: boolean;
}

export interface ContextAttachment {
  files: ContextFile[];
  directories: ContextDirectory[];
}

export type { ContextDirectory } from './directory-tree.js';

export async function listContextChoices(projectRoot: string): Promise<string[]> {
  const files = await fg('**/*', {
    cwd: projectRoot,
    dot: false,
    onlyFiles: true,
    ignore: CONTEXT_IGNORE,
  });

  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(`${parts.slice(0, i).join('/')}/`);
    }
  }

  for (const dir of await collectProjectDirectories(projectRoot)) {
    dirs.add(dir);
  }

  const topLevel = await fs.readdir(projectRoot);
  for (const entry of topLevel) {
    const fullPath = path.join(projectRoot, entry);
    if ((await fs.stat(fullPath)).isDirectory()) {
      dirs.add(`${entry}/`);
    }
  }

  return [...[...dirs].sort(), ...files.sort()];
}

export async function loadContextAttachments(
  projectRoot: string,
  refs: string[],
): Promise<ContextAttachment> {
  const files = await loadContextFiles(projectRoot, refs);
  const directories: ContextDirectory[] = [];
  const uniqueRefs = [...new Set(refs.map((ref) => ref.replace(/\\/g, '/').replace(/\/$/, '')))];

  for (const ref of uniqueRefs) {
    const resolved = path.resolve(projectRoot, ref);
    if (!(await fs.pathExists(resolved))) {
      continue;
    }

    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      continue;
    }

    const tree = await scanDirectoryTree(projectRoot, ref);
    if (tree) {
      directories.push(tree);
    }
  }

  return { files, directories };
}

export async function loadContextFiles(
  projectRoot: string,
  refs: string[],
): Promise<ContextFile[]> {
  const uniqueRefs = [...new Set(refs.map((ref) => ref.replace(/\\/g, '/').replace(/\/$/, '')))];
  const filePaths = new Set<string>();

  for (const ref of uniqueRefs) {
    const resolved = path.resolve(projectRoot, ref);
    if (!resolved.startsWith(path.resolve(projectRoot))) {
      continue;
    }

    if (!(await fs.pathExists(resolved))) {
      continue;
    }

    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const nested = await fg('**/*', {
        cwd: resolved,
        dot: false,
        onlyFiles: true,
        ignore: CONTEXT_IGNORE,
      });
      const relativeDir = path.relative(projectRoot, resolved).replace(/\\/g, '/');
      for (const nestedFile of nested) {
        const relativePath = path.posix.join(relativeDir, nestedFile);
        if (isTextContextFile(relativePath)) {
          filePaths.add(relativePath);
        }
      }
      continue;
    }

    const relativePath = path.relative(projectRoot, resolved).replace(/\\/g, '/');
    if (isTextContextFile(relativePath)) {
      filePaths.add(relativePath);
    }
  }

  const sortedPaths = [...filePaths].sort().slice(0, MAX_FILES);
  const loaded: ContextFile[] = [];
  let totalBytes = 0;

  for (const relativePath of sortedPaths) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      break;
    }

    const fullPath = path.join(projectRoot, relativePath);
    if (!(await fs.pathExists(fullPath))) {
      continue;
    }

    const buffer = await fs.readFile(fullPath);
    const remaining = MAX_TOTAL_BYTES - totalBytes;
    const maxForFile = Math.min(MAX_FILE_BYTES, remaining);
    const truncated = buffer.byteLength > maxForFile;
    const content = buffer.subarray(0, maxForFile).toString('utf8');

    loaded.push({
      path: relativePath.replace(/\\/g, '/'),
      language: detectLanguage(relativePath),
      content,
      truncated,
    });
    totalBytes += Buffer.byteLength(content, 'utf8');
  }

  return loaded;
}

export function formatContextMarkdown(
  files: ContextFile[],
  directories: ContextDirectory[] = [],
): string {
  if (files.length === 0 && directories.length === 0) {
    return '';
  }

  const sections: string[] = [];

  for (const directory of directories) {
    sections.push(
      `### ${directory.relativePath}/`,
      '',
      '```text',
      directory.treeText,
      '```',
      '',
      directory.empty
        ? '*(empty directory — no files yet)*'
        : `*${directory.fileCount} file(s), ${directory.directories.length} subfolder(s). Binary images (png, jpg, etc.) appear in the tree only — not embedded.*`,
      '',
    );
  }

  for (const file of files) {
    const truncatedNote = file.truncated ? '\n\n*(truncated)*' : '';
    sections.push(
      `### ${file.path}`,
      '',
      '```' + file.language,
      file.content,
      '```',
      truncatedNote,
      '',
    );
  }

  return ['--- Context Files ---', '', ...sections, '--- End Context Files ---'].join('\n');
}

export function formatContextJson(
  files: ContextFile[],
  projectSummary?: string,
  directories: ContextDirectory[] = [],
): string {
  const payload = {
    projectSummary: projectSummary ?? null,
    contextDirectories: directories.map((directory) => ({
      path: directory.relativePath,
      empty: directory.empty,
      fileCount: directory.fileCount,
      directories: directory.directories,
      files: directory.files,
      treeText: directory.treeText,
    })),
    contextFiles: files.map((file) => ({
      path: file.path,
      language: file.language,
      truncated: file.truncated,
      content: file.content,
    })),
  };

  return JSON.stringify(payload, null, 2);
}

export function formatAgentContextJson(
  files: ContextFile[],
  projectSummary?: string,
  directories: ContextDirectory[] = [],
  options: { prompt?: string } = {},
): string {
  const payload = {
    projectSummary: projectSummary ?? null,
    runtime: {
      platform: process.platform,
      shell: process.platform === 'win32' ? process.env.COMSPEC ?? 'cmd.exe' : '/bin/sh',
    },
    contentFormat: '1-based numbered text: lineNumber| source. includedRanges are visible lines; partial/truncated files must not be fully replaced. Request more context if needed.',
    contextDirectories: directories.map((directory) => ({
      path: directory.relativePath,
      empty: directory.empty,
      fileCount: directory.fileCount,
      directories: directory.directories,
      files: directory.files,
      treeText: directory.treeText,
    })),
    contextFiles: files.map((file) => {
      const lines = file.content.split('\n');
      const scoped = files.length === 1 && !file.truncated && lines.length > 100 &&
        !/全文|整个|整体|全部|所有|重写|重构|审查|分析|总结|full|entire|review|refactor|rewrite|summari[sz]|\ball\b/i.test(options.prompt ?? '');
      const tail = scoped && /末尾|最后|结尾|底部|\b(?:end|bottom|append|last)\b/i.test(options.prompt ?? '');
      const head = !tail && scoped && /开头|首行|顶部|\b(?:beginning|top|prepend|first)\b/i.test(options.prompt ?? '');
      const start = tail ? Math.max(1, lines.length - 49) : 1;
      const end = head ? Math.min(50, lines.length) : lines.length;
      return makeContextView(file, start, end);
    }),
  };

  return JSON.stringify(payload);
}

export function makeContextView(file: ContextFile, start = 1, end = file.content.split('\n').length) {
  const lines = file.content.split('\n');
  return {
    path: file.path, language: file.language, exists: true, truncated: file.truncated,
    partial: file.truncated || start > 1 || end < lines.length,
    totalLines: file.truncated ? null : lines.length,
    sourceHash: file.truncated ? null : createHash('sha256').update(file.content).digest('hex'),
    includedRanges: [{ startLine: start, endLine: end }],
    numberedContent: lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(4, ' ')}| ${line}`).join('\n'),
  };
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.sh': 'bash',
    '.py': 'python',
  };

  return map[ext] ?? (ext.replace('.', '') ?? 'text');
}
