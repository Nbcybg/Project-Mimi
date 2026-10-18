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
