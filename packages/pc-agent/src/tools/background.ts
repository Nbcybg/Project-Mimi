import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { shellInvocation } from '../process.ts';
import { resolveAllowedPath } from './path-guard.ts';

const MAX_JOBS = 20;
const DEFAULT_TAIL = 20_000;

interface Job {
  pid: number;
  command: string;
  cwd: string;
  logFile: string;
  startedAt: string;
  timeoutMs?: number;
  exitCode?: number | null;
  timer?: NodeJS.Timeout;
  child: ChildProcess;
}

const jobs = new Map<number, Job>();

function killTree(pid: number): void {
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function prune(): void {
  while (jobs.size >= MAX_JOBS) {
    const oldest = jobs.values().next().value as Job | undefined;
    if (!oldest) return;
    jobs.delete(oldest.pid);
    if (oldest.exitCode === undefined && oldest.child.pid) killTree(oldest.child.pid);
    void fsp.rm(oldest.logFile, { force: true }).catch(() => {});
  }
}

export async function startBackground(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Job> {
  prune();
  const dir = path.join(os.tmpdir(), 'mimi-shell');
  await fsp.mkdir(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const logFile = path.join(dir, `${id}.log`);
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  const { file, args } = shellInvocation(command);
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.stdout) child.stdout.pipe(out);
  if (child.stderr) child.stderr.pipe(out);
  const pid = child.pid ?? -1;
  const job: Job = {
    pid,
    command,
    cwd: options.cwd,
    logFile,
    startedAt: new Date().toISOString(),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    child,
  };
  if (options.timeoutMs) {
    job.timer = setTimeout(() => {
      if (job.exitCode === undefined && job.child.pid) killTree(job.child.pid);
    }, options.timeoutMs);
    job.timer.unref?.();
  }
  child.on('error', (error) => {
    out.write(`\n[spawn error] ${error.message}\n`);
    job.exitCode = null;
  });
  child.on('close', (code) => {
    job.exitCode = code;
    out.write(`\n[process exited with ${code ?? 'no code'}]\n`);
    out.end();
    if (job.timer) clearTimeout(job.timer);
    // Keep the entry so shell_output can still read the last output.
  });
  jobs.set(pid, job);
  return job;
}

export const shellOutputTool = defineTool({
  name: 'shell_output',
  description:
    'Read the tail of a background command started with run_shell (background: true), or list the background commands. Use it after starting a dev server, a watcher or a long test.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    pid: z.number().int().positive().optional().describe('The background process; omit to list them'),
    tail_chars: z.number().int().min(100).max(100_000).optional().describe('Default 20000'),
    wait_ms: z.number().int().min(0).max(30_000).optional().describe('Wait before reading, e.g. for a server to start'),
  }),
  summarize: (input) => (input.pid ? `Read output of background pid ${input.pid}` : 'List background commands'),
  async execute(input) {
    if (input.wait_ms) await new Promise((resolve) => setTimeout(resolve, input.wait_ms));
    if (!input.pid) {
      if (jobs.size === 0) return 'No background commands were started by this PC agent.';
      return [...jobs.values()]
        .map((job) => `${job.pid}  ${job.exitCode === undefined ? 'running' : `exited ${job.exitCode}`}  ${job.startedAt}  ${job.cwd}  ${job.command}`)
        .join('\n');
    }
    const job = jobs.get(input.pid);
    if (!job) throw new Error(`No background process with pid ${input.pid}.`);
    const limit = input.tail_chars ?? DEFAULT_TAIL;
    let text = '';
    try {
      const stat = await fsp.stat(job.logFile);
      const start = Math.max(0, stat.size - limit);
      const handle = await fsp.open(job.logFile, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(limit, stat.size - start));
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      text = '(no output yet)';
    }
    return `pid ${job.pid} · ${job.exitCode === undefined ? 'running' : `exited ${job.exitCode}`} · ${job.command}\n${text || '(no output yet)'}`;
  },
});

export const shellStopTool = defineTool({
  name: 'shell_stop',
  description: 'Stop a background command started with run_shell (background: true), including its child processes.',
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({ pid: z.number().int().positive() }),
  summarize: (input) => `Stop background pid ${input.pid}`,
  async execute(input) {
    const job = jobs.get(input.pid);
    if (!job) throw new Error(`No background process with pid ${input.pid}.`);
    if (job.exitCode !== undefined) return `Process ${job.pid} already exited (${job.exitCode}).`;
    killTree(job.pid);
    if (job.timer) clearTimeout(job.timer);
    return `Stopping background pid ${job.pid}. Its last output stays in ${job.logFile}.`;
  },
});

export const backgroundTools = [shellOutputTool, shellStopTool];
