import type { ToolDefinition } from '@mimi/shared';
import { readFileTool } from './tools/read-file.ts';
import { runShellTool } from './tools/run-shell.ts';
import { writeFileTool } from './tools/write-file.ts';

export { PcAgent, type PcAgentOptions } from './client.ts';
export { PathNotAllowedError, resolveAllowedPath } from './tools/path-guard.ts';
export { readFileTool, runShellTool, writeFileTool };

/** Tools that act on the user's machine. The core holds their schemas; the PC agent runs them. */
export const pcTools: ToolDefinition<any>[] = [readFileTool, writeFileTool, runShellTool];
