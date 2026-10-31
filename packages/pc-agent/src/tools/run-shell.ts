import { z } from 'zod';
import { defineTool } from '@mimi/shared';
import { resolveAllowedPath } from './path-guard.ts';
import { runCommand, SHELL_NAME } from '../process.ts';

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

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
