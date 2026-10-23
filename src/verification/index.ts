import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_CHARS = 20_000;
const DEFAULT_SCRIPT_ORDER = ['typecheck', 'test', 'lint', 'build'] as const;
const COPY_EXCLUDES = new Set([
  '.git',
  '.openbrowser',
  '.pnpm-store',
  'coverage',
  'dist',
  'node_modules',
]);

export interface VerificationResult {
  summary: string;
  scripts: string[];
  sandboxRoot?: string;
}

export interface VerificationOptions {
  scripts?: string[];
  timeoutMs?: number;
  keepSandbox?: boolean;
  onLog?: (message: string) => void;
  onScriptPassed?: (script: string) => void;
}

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

export class VerificationSetupError extends Error {
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = 'VerificationSetupError'; }
}

export function isVerificationSetupError(error: unknown): boolean {
  for (let depth = 0; depth < 8 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof VerificationSetupError) return true;
  }
  return false;
}

/**
 * Runs project scripts in a temporary workspace copy. This isolates repository
 * writes, but it is not a container and does not block network or OS access.
 */
export async function runVerificationInSandbox(
  projectRoot: string,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (!(await fs.pathExists(packageJsonPath))) {
    if (options.scripts?.length) throw new VerificationSetupError('所选验证脚本无法运行：package.json 已不存在，不会将跳过当作通过');
    return { summary: 'Verification skipped: no package.json', scripts: [] };
  }

  let packageJson: PackageJson;
  try { packageJson = await fs.readJson(packageJsonPath) as PackageJson; }
  catch (error) { throw new VerificationSetupError('无法读取验证配置 package.json，尚未运行测试', error); }
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson) || packageJson.packageManager !== undefined && typeof packageJson.packageManager !== 'string') throw new VerificationSetupError('验证配置格式不正确，尚未运行测试');
  const available = packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)
    ? Object.fromEntries(Object.entries(packageJson.scripts).filter(([, command]) => typeof command === 'string')) : {};
  const scripts = selectScripts(available, options.scripts);
  const missing = options.scripts?.filter((name) => !scripts.includes(name)) ?? [];
  if (missing.length) throw new VerificationSetupError(`所选验证脚本缺失或不可用：${missing.join('、')}。请检查配置并重新审核，不会静默跳过。`);
  if (scripts.length === 0) {
    return { summary: 'Verification skipped: no matching scripts', scripts: [] };
  }

  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-verify-'));
  try {
    try {
      await fs.copy(projectRoot, sandboxRoot, {
        filter: (source) => shouldCopy(projectRoot, source),
        preserveTimestamps: true,
      });
      await linkDependencies(projectRoot, sandboxRoot, options.onLog);
    } catch (error) {
      throw new VerificationSetupError(`验证环境准备失败，尚未运行测试；请修复本机环境后重试：${error instanceof Error ? error.message : String(error)}`, error);
    }

    const packageManager = detectPackageManager(projectRoot, packageJson.packageManager);
    const outputs: string[] = [];
    for (const script of scripts) {
      options.onLog?.(`Running ${script}`);
      const output = await runPackageScript(
        packageManager,
        script,
        sandboxRoot,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.onLog,
      );
      outputs.push(`${script}: passed${output ? `\n${output}` : ''}`);
      options.onScriptPassed?.(script);
    }

    return {
      summary: `Sandbox verification passed: ${scripts.join(', ')}`,
      scripts,
      sandboxRoot: options.keepSandbox ? sandboxRoot : undefined,
    };
  } finally {
    if (!options.keepSandbox) {
      await fs.remove(sandboxRoot);
    }
  }
}

export function selectScripts(
  available: Record<string, string>,
  requested?: string[],
): string[] {
  const candidates = requested ?? [...DEFAULT_SCRIPT_ORDER];
  return [...new Set(candidates)].filter(
    (name) => /^[a-zA-Z0-9:_-]+$/.test(name) && Boolean(available[name]?.trim()),
  );
}

function shouldCopy(projectRoot: string, source: string): boolean {
  const relative = path.relative(projectRoot, source);
  if (!relative) {
    return true;
  }
  return !relative.split(path.sep).some((segment) => COPY_EXCLUDES.has(segment));
}

async function linkDependencies(projectRoot: string, sandboxRoot: string, onLog?: (message: string) => void): Promise<void> {
  const source = path.join(projectRoot, 'node_modules');
  if (!(await fs.pathExists(source))) {
    return;
  }

  const destination = path.join(sandboxRoot, 'node_modules');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try { await fs.symlink(source, destination, type); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    // Never silently skip verification or request elevated link privileges.
    // Copy dependencies into the disposable workspace instead.
    try { await fs.lstat(destination); throw new Error('依赖目标已存在，拒绝覆盖'); }
    catch (existing) { if ((existing as NodeJS.ErrnoException).code !== 'ENOENT') throw existing; }
    onLog?.(`当前环境不允许依赖链接（${(error as NodeJS.ErrnoException).code}），改用依赖副本；首次复制可能稍慢。`);
    await fs.copy(source, destination, {
      dereference: true,
      filter: async (entry) => {
        // pnpm dependency graphs can contain cyclic directory links. Do not
        // recursively expand an ancestor into itself when dereferencing them.
        if (!(await fs.lstat(entry)).isSymbolicLink() || !(await fs.stat(entry)).isDirectory()) return true;
        const target = await fs.realpath(entry);
        let parent = path.dirname(entry);
        while (parent === source || parent.startsWith(`${source}${path.sep}`)) {
          if (await fs.realpath(parent) === target) return false;
          parent = path.dirname(parent);
        }
        return true;
      },
    });
    onLog?.('依赖副本已准备好，继续执行所选验证脚本。');
  }
}

function detectPackageManager(projectRoot: string, declared?: string): string {
  const name = declared?.split('@')[0];
  if (name && ['pnpm', 'npm', 'yarn', 'bun'].includes(name)) {
    return name;
  }
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm';
}

async function runPackageScript(
  packageManager: string,
  script: string,
  cwd: string,
  timeoutMs: number,
  onLog?: (message: string) => void,
): Promise<string> {
  const executable = process.platform === 'win32'
    ? packageManager === 'bun' ? 'bun.exe' : `${packageManager}.cmd`
    : packageManager;
  const args = packageManager === 'yarn' || packageManager === 'bun'
    ? ['run', script]
    : [...(packageManager === 'pnpm' ? ['--config.verify-deps-before-run=false'] : []), 'run', script];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: verificationEnvironment(),
      // Windows cannot spawn .cmd launchers directly. Both the executable and
      // script name are constrained above before entering the shell.
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let output = '';

    const capture = (chunk: Buffer | string): void => {
      output = `${output}${chunk.toString()}`.slice(-MAX_CAPTURE_CHARS);
      onLog?.(chunk.toString());
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Verification script "${script}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new VerificationSetupError(`无法启动验证脚本 "${script}"，请检查本机包管理器和 PATH：${error.message}`, error));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = output.trim();
      if (code === 0) {
        resolve(trimmed);
        return;
      }
      reject(
        new Error(
          `Verification script "${script}" failed with exit code ${code ?? 'unknown'}${trimmed ? `:\n${trimmed}` : ''}`,
        ),
      );
    });
  });
}

function verificationEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'PNPM_HOME',
  ];
  const env: NodeJS.ProcessEnv = {
    CI: '1',
    NODE_ENV: 'test',
    OPENBROWSER_VERIFY_SANDBOX: '1',
  };
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}
