import type { ToolContext, ToolDefinition } from './registry.ts';

/**
 * Runs an already-validated, already-approved tool call. The agent loop only talks
 * to this interface; where a tool physically runs is decided here.
 */
export interface ToolExecutor {
  execute(tool: ToolDefinition, input: unknown, context: ToolContext): Promise<string>;
}

/** Runs every tool in the core process. */
export class LocalExecutor implements ToolExecutor {
  execute(tool: ToolDefinition, input: unknown, context: ToolContext): Promise<string> {
    return tool.execute(input, context, {});
  }
}

/** The connection to the PC agent, if one is attached. */
export interface PcLink {
  readonly online: boolean;
  /** Folders the PC agent allows, as reported when it connected. */
  readonly allowedDirs: string[];
  execute(tool: string, input: unknown, context: ToolContext): Promise<string>;
}

export const PC_OFFLINE =
  'PC offline: the PC agent is not connected, so files and commands on the user\'s computer are unavailable right now. Turn on "ให้ Mimi ใช้เครื่องนี้ (PC agent)" from the Mimi tray menu, then try again.';

/**
 * Where work meant for the user's machine goes: down the PC agent's socket when one is
 * connected, in this process when the core runs on that machine itself, or nowhere.
 */
export interface PcRunner {
  mode(): 'remote' | 'local' | 'offline';
  execute(tool: string, input: unknown, context: ToolContext): Promise<string>;
}

export function makePcRunner(pc: PcLink | undefined, localPcTools: boolean): PcRunner {
  return {
    mode: () => (pc?.online ? 'remote' : localPcTools ? 'local' : 'offline'),
    execute: (tool, input, context) => (pc?.online ? pc.execute(tool, input, context) : Promise.reject(new Error(PC_OFFLINE))),
  };
}

/**
 * Sends `pc` tools to the PC agent and runs everything else in the core. Without a
 * connected PC agent, `pc` tools fail with "PC offline" unless the core was started
 * on the user's own machine with local execution enabled.
 */
export class RoutingExecutor implements ToolExecutor {
  private readonly pc: PcLink | undefined;
  private readonly localPcTools: boolean;

  constructor(options: { pc?: PcLink; localPcTools: boolean }) {
    this.pc = options.pc;
    this.localPcTools = options.localPcTools;
  }

  async execute(tool: ToolDefinition, input: unknown, context: ToolContext): Promise<string> {
    if (tool.target !== 'pc') return tool.execute(input, context);
    if (this.pc?.online) return this.pc.execute(tool.name, input, context);
    if (this.localPcTools) return tool.execute(input, context);
    throw new Error(PC_OFFLINE);
  }
}
