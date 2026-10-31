import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 20_000;

export const SHELL_NAME = process.platform === 'win32' ? 'Windows PowerShell' : 'sh';

/** The shell a command runs in: PowerShell on Windows, sh everywhere else. */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c', command] };
  // Force UTF-8 so non-ASCII output (Thai) survives the pipe.
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
}

export interface CommandResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Characters dropped because the output exceeded `maxOutput`. */
  truncated: number;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutput?: number;
  signal?: AbortSignal;
}

function killTree(pid: number, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** Runs one program without a shell. Used for git and other fixed commands. */
export function runProcess(file: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const platform = process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let truncated = 0;
    let timedOut = false;
    let cancelled = false;
    let stopReason: 'timeout' | 'cancel' | null = null;

    const collect = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const room = maxOutput - output.length;
      output += text.slice(0, Math.max(room, 0));
      truncated += Math.max(text.length - Math.max(room, 0), 0);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const stop = (reason: 'timeout' | 'cancel') => {
      stopReason ??= reason;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      if (child.pid !== undefined) killTree(child.pid, platform);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('cancel');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ output, exitCode: code, timedOut: timedOut || stopReason === 'timeout', cancelled, truncated });
    });
  });
}

/** Runs a command line in the platform's shell. */
export function runCommand(command: string, options: CommandOptions): Promise<CommandResult> {
  const { file, args } = shellInvocation(command);
  return runProcess(file, args, options);
}

const WINDOWS_ENV = [
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PATH',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'USERNAME',
  'USERDOMAIN',
] as const;

const POSIX_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SHELL', 'TERM'] as const;

/**
 * The environment a user command gets: enough to find the toolchain, no API keys,
 * tokens or MIMI_* settings. Git also gets a non-interactive, colorless setup.
 */
export function sanitizedEnv(extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of platform === 'win32' ? WINDOWS_ENV : POSIX_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = '1';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  return { ...env, ...extra };
}
