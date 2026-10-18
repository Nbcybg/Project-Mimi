import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveAllowedPath } from './path-guard.ts';
import { defineTool } from '@mimi/shared';

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

const IS_WINDOWS = process.platform === 'win32';
const SHELL_NAME = IS_WINDOWS ? 'Windows PowerShell' : 'sh';

function shellInvocation(command: string): { file: string; args: string[] } {
  if (!IS_WINDOWS) return { file: '/bin/sh', args: ['-c', command] };
  // Force UTF-8 so non-ASCII output (Thai) survives the pipe.
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
  };
}

function killTree(pid: number): void {
  if (IS_WINDOWS) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export const runShellTool = defineTool({
  name: 'run_shell',
  description: `Run a ${SHELL_NAME} command on the user's machine and return its combined output and exit code. The working directory must be inside the allowed folders.`,
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    command: z.string().min(1).describe(`Command line for ${SHELL_NAME}`),
    cwd: z.string().optional().describe('Working directory; defaults to the working folder'),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  }),
  summarize: (input) => `Run: ${input.command}${input.cwd ? ` (in ${input.cwd})` : ''}`,
  async execute(input, context) {
    const cwd = resolveAllowedPath(input.cwd ?? '.', context.allowedDirs);
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const { file, args } = shellInvocation(input.command);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        detached: !IS_WINDOWS,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let dropped = 0;
      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const room = MAX_OUTPUT_CHARS - output.length;
        output += text.slice(0, Math.max(room, 0));
        dropped += Math.max(text.length - Math.max(room, 0), 0);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      let stopReason: string | null = null;
      const stop = (reason: string) => {
        stopReason ??= reason;
        if (child.pid !== undefined) killTree(child.pid);
      };
      const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
      const onAbort = () => stop('cancelled');
      context.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
      };
      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('close', (code) => {
        cleanup();
        const truncated = dropped > 0 ? `\n[output truncated: ${dropped} more characters]` : '';
        const status = stopReason ? `[${stopReason}]` : `[exit code ${code}]`;
        resolve(`${output}${truncated}\n${status}`.trimStart());
      });
    });
  },
});
