import type { AgentEvent, MeshContext } from '@mimi/shared';
import { z } from 'zod';
import type { AgentCatalog, AgentDefinition } from '../agents/loader.ts';
import type { Db } from '../db/db.ts';
import type { MessagesRepo } from '../db/messages-repo.ts';
import type { MeshToolProvider, RunInput } from '../loop/agent-loop.ts';
import type { Settings } from '../providers/settings.ts';
import { defineTool, type ToolContext, type ToolDefinition } from '../tools/registry.ts';
import { TraceBudget } from './budget.ts';

export type AgentRunner = (input: RunInput) => AsyncGenerator<AgentEvent>;
type RunFinish = Extract<AgentEvent, { type: 'run-finish' }>;
type MessageStatus = 'pending' | 'running' | 'replied' | 'failed' | 'timeout';

export interface AgentMessage {
  id: number;
  traceId: string;
  from: string;
  to: string;
  mode: 'delegate' | 'handoff';
  task: string;
  context: string;
  expectedResult: string;
  replyTo: number | null;
  result: string | null;
  status: MessageStatus;
  hopCount: number;
}

interface MessageRow {
  id: number;
  trace_id: string;
  from_agent: string;
  to_agent: string;
  mode: 'delegate' | 'handoff';
  task: string;
  context: string;
  expected_result: string;
  reply_to: number | null;
  result: string | null;
  status: MessageStatus;
  hop_count: number;
}

const SendInput = z.object({
  agent: z.string().min(1).describe('Name of the agent to message'),
  task: z.string().min(1).describe('What you need from them, stated so it stands on its own'),
  context: z
    .string()
    .optional()
    .describe('A short summary of what they need to know. They cannot see your conversation.'),
  expected_result: z.string().optional().describe('What a good answer looks like'),
  mode: z
    .enum(['delegate', 'handoff'])
    .optional()
    .describe('"delegate" (default): wait for their reply. "handoff": they answer the user instead of you.'),
});

const ReplyInput = z.object({
  message_id: z.number().int().positive().describe('The id of the agent message you are answering'),
  result: z.string().min(1).describe('Your complete result'),
});

/** Renders an agent-to-agent message as the text that wakes the receiving agent. */
function renderMessage(message: AgentMessage): string {
  const lines = [
    `<agent_message id="${message.id}" from="${message.from}" mode="${message.mode}">`,
    `Task: ${message.task}`,
  ];
  if (message.context) lines.push(`Context: ${message.context}`);
  if (message.expectedResult) lines.push(`Expected result: ${message.expectedResult}`);
  lines.push('</agent_message>');
  lines.push(
    message.mode === 'delegate'
      ? `This message is from another agent, not from the user. Do the task, then call reply(message_id=${message.id}, result=...); a plain final answer is also sent back to ${message.from}.`
      : `${message.from} handed this turn over to you. Your answer goes straight to the user.`,
  );
  return lines.join('\n');
}

/**
 * Routes messages between agents. Any agent may message any agent on its `can_message`
 * list, in any direction; every message wakes the receiver for exactly one loop run
 * in its own thread. Runaway chains are stopped by the hop limit, the trace budget
 * and the reply timeout.
 */
export class MeshRouter implements MeshToolProvider {
  private readonly db: Db;
  private readonly agents: AgentCatalog;
  private readonly messages: MessagesRepo;
  private readonly settings: Settings['mesh'];
  private runner: AgentRunner | null = null;
  private readonly budgets = new Map<string, TraceBudget>();
  private readonly explicitReplies = new Map<number, string>();

  constructor(deps: { db: Db; agents: AgentCatalog; messages: MessagesRepo; settings: Settings['mesh'] }) {
    this.db = deps.db;
    this.agents = deps.agents;
    this.messages = deps.messages;
    this.settings = deps.settings;
  }

  /** The router starts agent runs, and agent runs call the router; this closes the loop. */
  attach(runner: AgentRunner): void {
    this.runner = runner;
  }

  /** The shared budget of a trace; created on first use. */
  budgetFor(traceId: string): TraceBudget {
    let budget = this.budgets.get(traceId);
    if (!budget) {
      budget = new TraceBudget({
        maxTokens: this.settings.max_trace_tokens,
        maxRounds: this.settings.max_trace_rounds,
        maxMs: this.settings.max_trace_ms,
      });
      this.budgets.set(traceId, budget);
    }
    return budget;
  }

  endTrace(traceId: string): void {
    this.budgets.delete(traceId);
  }

  getMessage(id: number): AgentMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get(id) as MessageRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      traceId: row.trace_id,
      from: row.from_agent,
      to: row.to_agent,
      mode: row.mode,
      task: row.task,
      context: row.context,
      expectedResult: row.expected_result,
      replyTo: row.reply_to,
      result: row.result,
      status: row.status,
      hopCount: row.hop_count,
    };
  }

  private setStatus(id: number, status: MessageStatus, result?: string): void {
    this.db
      .prepare(`UPDATE agent_messages SET status = ?, result = COALESCE(?, result) WHERE id = ?`)
      .run(status, result ?? null, id);
  }

  toolsFor(agent: AgentDefinition, mesh: MeshContext | undefined): ToolDefinition<any>[] {
    const tools: ToolDefinition<any>[] = [];
    if (agent.canMessage.length > 0) tools.push(this.sendTool(agent));
    if (mesh?.mode === 'delegate') tools.push(this.replyTool());
    return tools;
  }

  private sendTool(sender: AgentDefinition): ToolDefinition<z.infer<typeof SendInput>> {
    const directory = sender.canMessage
      .map((name) => {
        try {
          return `${name} (${this.agents.get(name).description || 'no description'})`;
        } catch {
          return name;
        }
      })
      .join('; ');
    return defineTool({
      name: 'send_to',
      description: `Message another agent. You may message: ${directory}. With mode "delegate" you get their reply back as the result of this call; with mode "handoff" they take over and answer the user, and your turn ends.`,
      risk: 'read',
      target: 'core',
      inputSchema: SendInput,
      summarize: (input) => `${input.mode ?? 'delegate'} to ${input.agent}: ${input.task.slice(0, 120)}`,
      execute: (input, context) => this.send(sender, input, context),
    });
  }

  private replyTool(): ToolDefinition<z.infer<typeof ReplyInput>> {
    return defineTool({
      name: 'reply',
      description:
        'Send your result back to the agent whose message you are working on. Call it once, when the task is done.',
      risk: 'read',
      target: 'core',
      inputSchema: ReplyInput,
      summarize: (input) => `Reply to message #${input.message_id}`,
      execute: async (input, context) => {
        const message = this.getMessage(input.message_id);
        if (!message || message.to !== context.agent || message.traceId !== context.traceId) {
          throw new Error(`Message #${input.message_id} is not addressed to you.`);
        }
        if (message.status !== 'running') {
          throw new Error(`Message #${input.message_id} is already ${message.status}.`);
        }
        this.explicitReplies.set(message.id, input.result);
        this.setStatus(message.id, 'replied', input.result);
        return `Reply delivered to ${message.from}. End your turn now.`;
      },
    });
  }

  private async send(
    sender: AgentDefinition,
    input: z.infer<typeof SendInput>,
    context: ToolContext,
  ): Promise<string> {
    const mode = input.mode ?? 'delegate';
    if (!sender.canMessage.includes(input.agent)) {
      throw new Error(
        `${sender.name} is not allowed to message "${input.agent}". Allowed: ${sender.canMessage.join(', ')}.`,
      );
    }
    const target = this.agents.get(input.agent);
    const hop = (context.mesh?.hop ?? 0) + 1;
    if (hop > this.settings.max_hops) {
      throw new Error(
        `Hop limit reached: this request already passed through ${this.settings.max_hops} agent-to-agent messages. Finish with what you have.`,
      );
    }
    const spent = this.budgetFor(context.traceId).exhausted();
    if (spent) throw new Error(`${spent} Finish with what you have.`);
    if (mode === 'handoff' && (context.mesh?.mode === 'delegate' || !context.requestHandoff)) {
      throw new Error(
        'Only the agent that is answering the user can hand off. Return your result with reply(...) instead.',
      );
    }

    const id = Number(
      this.db
        .prepare(
          `INSERT INTO agent_messages
             (trace_id, from_agent, to_agent, mode, task, context, expected_result, reply_to, hop_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          context.traceId,
          sender.name,
          target.name,
          mode,
          input.task,
          input.context ?? '',
          input.expected_result ?? '',
          context.mesh?.messageId ?? null,
          hop,
        ).lastInsertRowid,
    );

    if (mode === 'handoff') {
      context.requestHandoff!({ messageId: id, to: target.name });
      return `Handed off to ${target.name} (message #${id}). They answer the user now. End your turn without adding anything.`;
    }
    return this.runDelegate(this.getMessage(id)!, target, context);
  }

  /** Wakes the receiver for one loop run and waits for its reply, up to the reply timeout. */
  private async runDelegate(message: AgentMessage, target: AgentDefinition, context: ToolContext): Promise<string> {
    if (!this.runner) throw new Error('Mesh router is not attached to a runner');
    const runner = this.runner;
    this.setStatus(message.id, 'running');

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    let finish: RunFinish | undefined;
    const run = (async () => {
      for await (const event of runner({
        agent: target,
        userText: renderMessage(message),
        thread: `mesh:${message.id}`,
        traceId: message.traceId,
        mesh: { messageId: message.id, from: message.from, mode: 'delegate', hop: message.hopCount },
        budget: this.budgetFor(message.traceId),
        signal: controller.signal,
      })) {
        if (event.type === 'run-finish') finish = event;
        context.emit?.({ type: 'agent-activity', agent: target.name, messageId: message.id, event });
      }
      return 'done' as const;
    })();
    run.catch(() => {}); // a run that outlives its timeout must not crash the process

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.settings.reply_timeout_ms);
    });
    let outcome: 'done' | 'timeout';
    try {
      outcome = await Promise.race([run, timeout]);
    } catch (error) {
      this.setStatus(message.id, 'failed');
      throw new Error(`${target.name} could not be started: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }

    const explicit = this.explicitReplies.get(message.id);
    this.explicitReplies.delete(message.id);
    if (explicit !== undefined) return `Reply from ${target.name} (message #${message.id}):\n${explicit}`;

    if (outcome === 'timeout') {
      controller.abort();
      this.setStatus(message.id, 'timeout');
      throw new Error(
        `${target.name} did not reply within ${Math.round(this.settings.reply_timeout_ms / 1000)}s (message #${message.id}). Continue without them.`,
      );
    }
    const done = finish as RunFinish | undefined;
    if (!done || done.reason === 'error' || done.reason === 'aborted') {
      this.setStatus(message.id, 'failed');
      throw new Error(`${target.name} failed on message #${message.id}: ${done?.error ?? done?.reason ?? 'no result'}`);
    }
    const result = done.text.trim() || `(no answer; ${target.name} stopped: ${done.error ?? done.reason})`;
    this.setStatus(message.id, 'replied', result);
    return `Reply from ${target.name} (message #${message.id}):\n${result}`;
  }

  /**
   * Runs the receiver of a handoff. Its events are the user-facing stream; its final
   * answer is also written to the user's thread so the conversation stays continuous.
   */
  async *runHandoff(messageId: number, userThread: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (!this.runner) throw new Error('Mesh router is not attached to a runner');
    const message = this.getMessage(messageId);
    if (!message || message.mode !== 'handoff' || message.status !== 'pending') {
      throw new Error(`Message #${messageId} is not a pending handoff`);
    }
    const target = this.agents.get(message.to);
    this.setStatus(message.id, 'running');

    let finish: RunFinish | undefined;
    try {
      for await (const event of this.runner({
        agent: target,
        userText: renderMessage(message),
        thread: `mesh:${message.id}`,
        traceId: message.traceId,
        mesh: { messageId: message.id, from: message.from, mode: 'handoff', hop: message.hopCount },
        budget: this.budgetFor(message.traceId),
        signal,
      })) {
        if (event.type === 'run-finish') finish = event;
        yield event;
      }
    } finally {
      const done = finish as RunFinish | undefined;
      const ok = done !== undefined && done.reason !== 'error' && done.reason !== 'aborted';
      this.setStatus(message.id, ok ? 'replied' : 'failed', done?.text);
      if (done?.text.trim()) {
        this.messages.append({
          thread: userThread,
          traceId: message.traceId,
          agent: target.name,
          role: 'assistant',
          content: done.text,
          text: done.text,
        });
      }
    }
  }
}
