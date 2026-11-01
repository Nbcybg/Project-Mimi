import { z } from 'zod';
import { defineTool } from '@mimi/shared';
import { runProcess, sanitizedEnv, type CommandResult } from '../process.ts';

export const APP_MANAGERS = ['winget', 'brew', 'choco', 'scoop', 'apt'] as const;
export type AppManager = (typeof APP_MANAGERS)[number];
export type PackageAction = 'install' | 'update';

export interface PackageCommand {
  file: string;
  args: string[];
}

export interface PackageRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type PackageRunner = (command: PackageCommand, options: PackageRunOptions) => Promise<CommandResult>;

/** Package ids look like Google.Chrome, firefox, or extras/vscode. No flags, no paths. */
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)?$/;
const TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 8_000;

const defaultRunner: PackageRunner = (command, options) =>
  runProcess(command.file, command.args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutput: MAX_OUTPUT,
    env: sanitizedEnv(),
    ...(options.signal ? { signal: options.signal } : {}),
  });

let runner: PackageRunner = defaultRunner;

/** Replaces the process runner (tests); null restores the real one. */
export function setPackageRunner(next: PackageRunner | null): void {
  runner = next ?? defaultRunner;
}

type ManagerProbe = (file: string, cwd: string) => Promise<boolean>;

let managerExists: ManagerProbe = commandExists;

/** Replaces the "is this manager installed?" probe (tests); null restores the real one. */
export function setPackageProbe(next: ManagerProbe | null): void {
  managerExists = next ?? commandExists;
}

/** The exact command for a manager, without a shell so the package id stays one argument. */
export function packageCommand(manager: AppManager, action: PackageAction, id: string, cask = false, elevated = process.getuid?.() === 0): PackageCommand {
  if (cask && manager !== 'brew') throw new Error('cask is only for Homebrew.');
  switch (manager) {
    case 'winget':
      return {
        file: 'winget',
        args: [
          action === 'install' ? 'install' : 'upgrade',
          '--id', id,
          '--exact',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
          '--disable-interactivity',
        ],
      };
    case 'brew':
      return { file: 'brew', args: [action === 'install' ? 'install' : 'upgrade', ...(cask ? ['--cask'] : []), id] };
    case 'choco':
      return { file: 'choco', args: [action === 'install' ? 'install' : 'upgrade', id, '-y', '--no-progress'] };
    case 'scoop':
      return { file: 'scoop', args: [action === 'install' ? 'install' : 'update', id] };
    case 'apt': {
      const args =
        action === 'install'
          ? ['apt-get', 'install', '-y', '--no-install-recommends', id]
          : ['apt-get', 'install', '--only-upgrade', '-y', '--no-install-recommends', id];
      return elevated ? { file: 'apt-get', args } : { file: 'sudo', args: ['-n', ...args] };
    }
  }
}

async function commandExists(file: string, cwd: string): Promise<boolean> {
  try {
    const result = await runProcess(process.platform === 'win32' ? 'where' : 'which', [file], {
      cwd,
      timeoutMs: 10_000,
      maxOutput: 4_000,
      env: sanitizedEnv(),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function candidates(): AppManager[] {
  if (process.platform === 'win32') return ['winget', 'choco', 'scoop'];
  if (process.platform === 'darwin') return ['brew'];
  return ['apt'];
}

/** The manager the user named, or the first one installed on this machine. */
export async function pickAppManager(cwd: string, requested?: AppManager): Promise<AppManager> {
  if (requested) {
    if (!(await managerExists(requested, cwd))) throw new Error(`${requested} is not installed on this computer (or not on PATH).`);
    return requested;
  }
  for (const manager of candidates()) {
    if (await managerExists(manager, cwd)) return manager;
  }
  throw new Error(`No supported package manager found. Install ${candidates().join(' or ')}, or name one explicitly.`);
}

function tail(text: string): string {
  const clean = text.trim();
  return clean.length <= MAX_OUTPUT ? clean : `… ${clean.slice(-MAX_OUTPUT)}`;
}

export const installAppTool = defineTool({
  name: 'install_app',
  description:
    'Install or update an application with the computer\'s package manager (winget, Homebrew, Chocolatey, Scoop or apt). Give the package id only (e.g. Google.Chrome, firefox, extras/vscode); arbitrary commands are impossible. Every call needs the user\'s approval and the PC agent\'s consent.',
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    id: z.string().min(1).max(128).describe('Package id, e.g. Google.Chrome or firefox'),
    action: z.enum(['install', 'update']).optional().describe('Default install'),
    manager: z.enum(APP_MANAGERS).optional().describe('Default: the first installed manager for this OS'),
    cask: z.boolean().optional().describe('Homebrew cask (apps such as google-chrome)'),
  }),
  summarize: (input) => `${input.action === 'update' ? 'Update' : 'Install'} ${input.id}${input.manager ? ` with ${input.manager}` : ''}`,
  async execute(input, context) {
    const id = input.id.trim();
    if (!PACKAGE_ID.test(id) || id.includes('..')) throw new Error(`"${input.id}" is not a package id. Give an id such as Google.Chrome or firefox.`);
    const action = input.action ?? 'install';
    if (input.cask && input.manager !== 'brew') throw new Error('cask is only for Homebrew.');
    const cwd = context.allowedDirs[0];
    if (!cwd) throw new Error('No allowed folder is configured for this PC agent.');
    const manager = await pickAppManager(cwd, input.manager);
    const command = packageCommand(manager, action, id, input.cask === true);
    const result = await runner(command, {
      cwd,
      timeoutMs: TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.timedOut) throw new Error(`${manager} did not finish within 15 minutes; the package may still be installing.`);
    if (result.cancelled) throw new Error(`${manager} was stopped.`);
    if (result.exitCode !== 0) {
      throw new Error(`${manager} could not ${action} "${id}" (exit ${result.exitCode}):\n${tail(result.output) || '(no output)'}`);
    }
    return JSON.stringify(
      {
        ok: true,
        manager,
        action,
        id,
        exitCode: result.exitCode,
        ...(result.truncated ? { truncatedChars: result.truncated } : {}),
        output: tail(result.output),
        summary: `${action === 'install' ? 'Installed' : 'Updated'} ${id} with ${manager}.`,
      },
      null,
      2,
    );
  },
});
