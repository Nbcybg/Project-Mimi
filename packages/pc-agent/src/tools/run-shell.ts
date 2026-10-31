import { z } from 'zod';
import { defineTool } from '@mimi/shared';
import { resolveProjectPath } from './path-guard.ts';
import { runCommand, SHELL_NAME } from '../process.ts';
import { startBackground } from './background.ts';

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

export const runShellTool = defineTool({
  name: 'run_shell',
  description: `Run a ${SHELL_NAME} command on the user's machine and return its combined output and exit code. The working directory must be inside the allowed folders (and inside an approved project folder when the user set any). Set background: true for a dev server or watcher; read it with shell_output and stop it with shell_stop.`,
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    command: z.string().min(1).describe(`Command line for ${SHELL_NAME}`),
    cwd: z.string().optional().describe('Working directory; defaults to the working folder'),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe('For a foreground command the default is 60 s; for a background one it is an automatic stop time.'),
    background: z.boolean().optional().describe('Start it and return at once with a pid (default false)'),
  }),
  summarize: (input) => `${input.background ? 'Start in background' : 'Run'}: ${input.command}${input.cwd ? ` (in ${input.cwd})` : ''}`,
  async execute(input, context) {
    const cwd = resolveProjectPath(input.cwd ?? '.', context.allowedDirs, context.projectRoots);
    if (input.background) {
      const job = await startBackground(input.command, {
        cwd,
        ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
      });
      return `Started in background: pid ${job.pid}\nlog: ${job.logFile}\nRead it with shell_output (pid ${job.pid}); stop it with shell_stop.`;
    }
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const result = await runCommand(input.command, {
      cwd,
      timeoutMs,
      maxOutput: MAX_OUTPUT_CHARS,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const truncated = result.truncated > 0 ? `\n[output truncated: ${result.truncated} more characters]` : '';
    const status = result.cancelled
      ? '[cancelled]'
      : result.timedOut
        ? `[timed out after ${timeoutMs} ms]`
        : `[exit code ${result.exitCode}]`;
    return `${result.output}${truncated}\n${status}`.trimStart();
  },
});
