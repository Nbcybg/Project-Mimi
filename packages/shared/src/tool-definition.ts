import type { z } from 'zod';
import type { AgentEvent } from './events.ts';
import type { ToolSettingValues, ToolSpec } from './tools.ts';

/** Present when the run was started by a message from another agent. */
export interface MeshContext {
  messageId: number;
  from: string;
  mode: 'delegate' | 'handoff';
  /** How many agent-to-agent messages deep this run is within its trace. */
  hop: number;
}

export interface ToolContext {
  traceId: string;
  thread: string;
  agent: string;
  /** Folder allowlist for file/shell access; the first entry is the default working folder. */
  allowedDirs: string[];
  signal?: AbortSignal;
  mesh?: MeshContext;
  /** The stored assistant message that made this call; files the tool sends are shown under it. */
  messageId?: number;
  /** Streams an event to the user while the tool is still running (sub-agent activity). */
  emit?(event: AgentEvent): void;
  /** Ends the current run after this tool call and passes the user-facing turn to another agent. */
  requestHandoff?(handoff: { messageId: number; to: string }): void;
}

export interface ToolDefinition<Input = unknown> extends ToolSpec {
  inputSchema: z.ZodType<Input>;
  /** One line shown in permission prompts. */
  summarize(input: Input): string;
  /**
   * Returns the text handed back to the model. Throw to report a failure.
   * `settings` are the values of the preset this tool runs as, when there is one.
   */
  execute(input: Input, context: ToolContext, settings?: ToolSettingValues): Promise<string>;
}

/** Identity helper that infers the input type from the schema. */
export function defineTool<Input>(tool: ToolDefinition<Input>): ToolDefinition<Input> {
  return tool;
}

/**
 * A tool result that is a file instead of text, e.g. a browser screenshot taken on the
 * user's PC: this mark, then JSON {@link ToolFile}. The core keeps the file as a chat
 * attachment and the agent gets its id, so nothing has to stay on the PC.
 */
export const TOOL_FILE_MARK = '\u0000mimi-file\u0000';

export interface ToolFile {
  name: string;
  mime: string;
  /** base64 */
  data: string;
}

export function toolFileOutput(file: ToolFile): string {
  return `${TOOL_FILE_MARK}${JSON.stringify(file)}`;
}

/** The file inside a tool result, or null for an ordinary text result. */
export function parseToolFile(output: string): ToolFile | null {
  if (!output.startsWith(TOOL_FILE_MARK)) return null;
  try {
    const file = JSON.parse(output.slice(TOOL_FILE_MARK.length)) as Partial<ToolFile>;
    return typeof file.name === 'string' && typeof file.mime === 'string' && typeof file.data === 'string'
      ? { name: file.name, mime: file.mime, data: file.data }
      : null;
  } catch {
    return null;
  }
}
