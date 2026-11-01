import { execFile } from 'node:child_process';
import type { LanguageModel, Tool } from 'ai';
import type { AgentEvent } from '@mimi/shared';
import type { ModelDef } from './settings.ts';

/** The provider that runs Claude through the user's own Claude Code login (Pro/Max plan). */
export const CLAUDE_SUBSCRIPTION_ID = 'claude-subscription';
export const CLAUDE_SUBSCRIPTION_NPM = 'ai-sdk-provider-claude-code';

/** The Claude Code CLI names tools it gets from an MCP server `mcp__<server>__<tool>`. */
const SERVER = 'mimi';

/** Models the plan offers. Subscription calls cost nothing per token, so no price is set. */
export const CLAUDE_SUBSCRIPTION_MODELS: Record<string, ModelDef> = {
  haiku: { name: 'Claude Haiku', tool_call: true, limit: { context: 200_000, output: 64_000 } },
  sonnet: { name: 'Claude Sonnet', tool_call: true, limit: { context: 200_000, output: 64_000 } },
  opus: { name: 'Claude Opus', tool_call: true, limit: { context: 200_000, output: 64_000 } },
};

export function isClaudeSubscription(npm: string): boolean {
  return npm === CLAUDE_SUBSCRIPTION_NPM;
}

/**
 * Throws a plain message when Claude cannot be used on this machine: the CLI is not
 * installed, or nobody is logged in. A token in the environment (`claude setup-token`,
 * for a server) counts as logged in.
 */
export function checkClaudeLogin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    execFile('claude', ['auth', 'status'], { env, timeout: 20_000, windowsHide: true }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Claude Code is not installed. Install it, then run: claude auth login'));
        return;
      }
      try {
        if ((JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn) {
          resolve();
          return;
        }
      } catch {
        // not JSON: fall through to the message below
      }
      reject(new Error('Claude Code is not logged in. Run: claude auth login (on a server: claude setup-token, then set CLAUDE_CODE_OAUTH_TOKEN)'));
    });
  });
}

/** A tool Mimi runs itself, behind its permission gate; the Claude CLI only asks for it. */
export interface BridgedTool {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  run(input: unknown): Promise<string>;
}

/**
 * A Claude model whose only tools are Mimi's. The CLI's own tools (files, shell, web) are
 * off and so are the account's claude.ai connectors and settings files, so the prompt is
 * Mimi's alone (about 3k tokens instead of 75k) and nothing runs outside the permission gate.
 */
export async function claudeModelWithTools(modelId: string, tools: BridgedTool[], maxTurns: number): Promise<LanguageModel> {
  // Loaded on demand: the Claude Code SDK is heavy and only this provider needs it.
  const { createAiSdkMcpServer, createClaudeCode } = await import('ai-sdk-provider-claude-code');
  const bridged = Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (input: unknown) => definition.run(input),
      },
    ]),
  );
  const provider = createClaudeCode({
    defaultSettings: {
      tools: [],
      mcpServers: tools.length > 0 ? { [SERVER]: createAiSdkMcpServer(SERVER, bridged as never) } : {},
      allowedTools: tools.map((definition) => `mcp__${SERVER}__${definition.name}`),
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      maxTurns,
    },
  });
  return provider(modelId) as LanguageModel;
}

/** Events raised while the CLI waits on a tool (permission asks, tool results), for the loop to pass on. */
export class EventQueue {
  readonly items: AgentEvent[] = [];
  private wake: (() => void) | undefined;

  push(event: AgentEvent): void {
    this.items.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  wait(): Promise<void> {
    if (this.items.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }
}

/** Interleaves a model stream with the events tools raise while it is waiting on them. */
export async function* withSideEvents<T>(
  source: AsyncIterable<T>,
  queue: EventQueue,
): AsyncGenerator<{ part: T } | { event: AgentEvent }> {
  const iterator = source[Symbol.asyncIterator]();
  let next = iterator.next();
  try {
    while (true) {
      while (queue.items.length > 0) yield { event: queue.items.shift()! };
      const winner = await Promise.race([next, queue.wait().then(() => null)]);
      if (winner === null) continue;
      if (winner.done) break;
      yield { part: winner.value };
      next = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
  while (queue.items.length > 0) yield { event: queue.items.shift()! };
}
