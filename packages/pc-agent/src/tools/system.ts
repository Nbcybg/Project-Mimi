import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { resolveAllowedPath } from './path-guard.ts';

const POWER_ACTIONS = ['lock', 'sleep', 'hibernate', 'shutdown', 'restart', 'logoff', 'cancel'] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

/** Files that would run code when "opened": refused by open_path (use run_shell, which asks first). */
const EXECUTABLE = /\.(exe|bat|cmd|com|ps1|psm1|msi|scr|vbs|vbe|js|jse|wsf|jar|lnk|reg|sh|appimage)$/i;
/** Never stopped, whatever the agent asks. */
const PROTECTED_PROCESSES = new Set(['system', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'node', 'node.exe']);

export interface Invocation {
  file: string;
  args: string[];
}

/** The OS command behind a power action; pure, so it can be checked without touching the machine. */
export function powerInvocation(action: PowerAction, delaySeconds: number, platform: NodeJS.Platform = process.platform): Invocation {
  const seconds = Math.max(0, Math.round(delaySeconds));
  const minutes = Math.ceil(seconds / 60);
  if (platform === 'win32') {
    switch (action) {
      case 'lock':
        return { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] };
      case 'sleep':
        // If hibernation is switched on in Windows, this hibernates instead (a known quirk of SetSuspendState).
        return { file: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'] };
      case 'hibernate':
        return { file: 'shutdown.exe', args: ['/h'] };
      case 'shutdown':
        return { file: 'shutdown.exe', args: ['/s', '/t', String(seconds)] };
      case 'restart':
        return { file: 'shutdown.exe', args: ['/r', '/t', String(seconds)] };
      case 'logoff':
        return { file: 'shutdown.exe', args: ['/l'] };
      case 'cancel':
        return { file: 'shutdown.exe', args: ['/a'] };
    }
  }
  if (platform === 'darwin') {
    switch (action) {
      case 'lock':
        return { file: 'pmset', args: ['displaysleepnow'] };
      case 'sleep':
      case 'hibernate':
        return { file: 'pmset', args: ['sleepnow'] };
      case 'shutdown':
        return { file: 'shutdown', args: ['-h', minutes === 0 ? 'now' : `+${minutes}`] };
      case 'restart':
        return { file: 'shutdown', args: ['-r', minutes === 0 ? 'now' : `+${minutes}`] };
      case 'logoff':
        return { file: 'osascript', args: ['-e', 'tell application "System Events" to log out'] };
      case 'cancel':
        return { file: 'killall', args: ['shutdown'] };
    }
  }
  switch (action) {
    case 'lock':
      return { file: 'loginctl', args: ['lock-session'] };
    case 'sleep':
      return { file: 'systemctl', args: ['suspend'] };
    case 'hibernate':
      return { file: 'systemctl', args: ['hibernate'] };
    case 'shutdown':
      return { file: 'shutdown', args: ['-h', minutes === 0 ? 'now' : `+${minutes}`] };
    case 'restart':
      return { file: 'shutdown', args: ['-r', minutes === 0 ? 'now' : `+${minutes}`] };
    case 'logoff':
      return { file: 'loginctl', args: ['terminate-user', os.userInfo().username] };
    case 'cancel':
      return { file: 'shutdown', args: ['-c'] };
  }
}

/** Starts a command and waits briefly for it to fail; one that succeeds (or keeps running) is "sent". */
function launch({ file, args }: Invocation, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: env ?? process.env, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    const settle = setTimeout(() => {
      child.unref();
      resolve('');
    }, 1500);
    child.on('close', (code) => {
      clearTimeout(settle);
      if (code === 0 || code === null) resolve(stderr.trim());
      else reject(new Error(stderr.trim() || `${file} exited with ${code}`));
    });
  });
}

export const systemInfoTool = defineTool({
  name: 'system_info',
  description: 'Basic facts about the computer: operating system, name, uptime, memory, processors and the folders the agents may use.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({}),
  summarize: () => 'System info',
  async execute(_input, context) {
    const gb = (bytes: number) => `${(bytes / 1073741824).toFixed(1)} GB`;
    const days = Math.floor(os.uptime() / 86400);
    const hours = Math.floor((os.uptime() % 86400) / 3600);
    return [
      `host: ${os.hostname()} (${os.type()} ${os.release()}, ${os.arch()})`,
      `user: ${os.userInfo().username}`,
      `uptime: ${days} d ${hours} h`,
      `memory: ${gb(os.freemem())} free of ${gb(os.totalmem())}`,
      `processors: ${os.cpus().length} x ${os.cpus()[0]?.model.trim() ?? 'unknown'}`,
      `allowed folders: ${context.allowedDirs.join('; ') || 'none'}`,
    ].join('\n');
  },
});

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))),
  );
}

/** Parses `tasklist /FO CSV /NH` or `ps -eo pid=,comm=` into { pid, name }. */
export function parseProcessList(output: string, platform: NodeJS.Platform = process.platform): Array<{ pid: number; name: string }> {
  const rows: Array<{ pid: number; name: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (platform === 'win32') {
      const cells = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1));
      if (cells && cells.length >= 2 && /^\d+$/.test(cells[1]!)) rows.push({ pid: Number(cells[1]), name: cells[0]! });
    } else {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match) rows.push({ pid: Number(match[1]), name: match[2]!.trim() });
    }
  }
  return rows;
}

async function processes(): Promise<Array<{ pid: number; name: string }>> {
  return process.platform === 'win32'
    ? parseProcessList(await run('tasklist', ['/FO', 'CSV', '/NH']), 'win32')
    : parseProcessList(await run('ps', ['-eo', 'pid=,comm=']), process.platform);
}

export const listProcessesTool = defineTool({
  name: 'list_processes',
  description: 'List running programs (name and pid), optionally only those whose name contains a word. Use it to find what to stop_process.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    filter: z.string().optional().describe('Part of the program name, e.g. "chrome"'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
  }),
  summarize: (input) => `List processes${input.filter ? ` matching "${input.filter}"` : ''}`,
  async execute(input) {
    const needle = input.filter?.toLowerCase();
    const all = (await processes()).filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
    if (all.length === 0) return 'No matching programs are running.';
    const limit = input.limit ?? 50;
    const counts = new Map<string, number[]>();
    for (const entry of all) counts.set(entry.name, [...(counts.get(entry.name) ?? []), entry.pid]);
    const lines = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, limit).map(([name, pids]) => `${name}  pid ${pids.slice(0, 6).join(', ')}${pids.length > 6 ? ` (+${pids.length - 6})` : ''}`);
    return `${counts.size} program(s):\n${lines.join('\n')}`;
  },
});

export const stopProcessTool = defineTool({
  name: 'stop_process',
  description: 'Close a running program by pid or by name (all processes with that name). Unsaved work in it is lost. System programs and the assistant itself are protected.',
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    pid: z.number().int().positive().optional(),
    name: z.string().optional().describe('Program name, e.g. notepad.exe'),
  }),
  summarize: (input) => `Stop ${input.pid !== undefined ? `pid ${input.pid}` : input.name}`,
  async execute(input) {
    if ((input.pid === undefined) === !input.name?.trim()) throw new Error('Give exactly one of pid or name.');
    const protectedPids = new Set([process.pid, process.ppid, 0, 4]);
    if (input.pid !== undefined) {
      if (protectedPids.has(input.pid)) throw new Error(`pid ${input.pid} is protected.`);
      const invocation = process.platform === 'win32' ? { file: 'taskkill', args: ['/PID', String(input.pid), '/T', '/F'] } : { file: 'kill', args: ['-9', String(input.pid)] };
      return (await run(invocation.file, invocation.args)).trim() || `Stopped pid ${input.pid}.`;
    }
    const name = input.name!.trim();
    if (PROTECTED_PROCESSES.has(name.toLowerCase()) || /[\\/]/.test(name)) throw new Error(`"${name}" is protected or not a plain program name.`);
    const invocation = process.platform === 'win32' ? { file: 'taskkill', args: ['/IM', name, '/F'] } : { file: 'pkill', args: ['-x', name] };
    return (await run(invocation.file, invocation.args)).trim() || `Stopped ${name}.`;
  },
});

export const openPathTool = defineTool({
  name: 'open_path',
  description:
    'Open a file or folder with the program the computer uses for it (a PDF in the PDF reader, a folder in the file manager), or open a web address in the default browser. Programs and scripts are refused; use run_shell for those.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({ target: z.string().min(1).describe('A path in the allowed folders, or an http(s) address') }),
  summarize: (input) => `Open ${input.target}`,
  async execute(input, context) {
    let target = input.target.trim();
    if (/^https?:\/\//i.test(target)) {
      new URL(target); // throws on nonsense
    } else {
      target = resolveAllowedPath(target, context.allowedDirs);
      if (EXECUTABLE.test(path.basename(target))) throw new Error('Programs and scripts are not opened this way; use run_shell.');
    }
    const invocation: Invocation =
      process.platform === 'win32'
        ? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:MIMI_TARGET'] }
        : { file: process.platform === 'darwin' ? 'open' : 'xdg-open', args: [target] };
    const failure = await launch(invocation, { ...process.env, MIMI_TARGET: target });
    if (failure) throw new Error(failure);
    return `Opened ${target}`;
  },
});

export const powerTool = defineTool({
  name: 'power',
  description:
    'Control the computer\'s power: lock the screen, sleep, hibernate, shut down, restart, log off, or cancel a shutdown/restart that is counting down. Shut down and restart wait `delay_seconds` (default 60) so they can be cancelled. The user must approve every call. Sleeping, shutting down or logging off ends this connection; to turn the computer on again use wake_pc from another machine.',
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    action: z.enum(POWER_ACTIONS),
    delay_seconds: z.number().int().min(0).max(3600).optional().describe('For shutdown and restart; default 60'),
  }),
  summarize: (input) => `Power: ${input.action}${input.action === 'shutdown' || input.action === 'restart' ? ` in ${input.delay_seconds ?? 60} s` : ''}`,
  async execute(input) {
    const delay = input.delay_seconds ?? 60;
    const failure = await launch(powerInvocation(input.action, delay));
    if (failure) throw new Error(failure);
    switch (input.action) {
      case 'shutdown':
      case 'restart':
        return `The computer will ${input.action === 'shutdown' ? 'shut down' : 'restart'} in ${delay} s. Call power with action "cancel" to stop it.`;
      case 'cancel':
        return 'Any pending shutdown or restart is cancelled.';
      default:
        return `Done: ${input.action}.`;
    }
  },
});

export const systemTools = [systemInfoTool, listProcessesTool, stopProcessTool, openPathTool, powerTool];
