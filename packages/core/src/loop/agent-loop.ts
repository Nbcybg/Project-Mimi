import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  MeshContext,
  MessageRole,
  RunFinishReason,
  ToolCall,
  ToolResult,
  UsageSnapshot,
} from '@mimi/shared';
import {
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  tool,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import type { AgentDefinition } from '../agents/loader.ts';
import type { MessagesRepo } from '../db/messages-repo.ts';
import type { ThreadRepo } from '../db/thread-repo.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { TraceBudget } from '../mesh/budget.ts';
import type { PermissionGate } from '../permissions/gate.ts';
import { formatModelRef, providerOptionsFor } from '../providers/registry.ts';
import type { ModelService } from '../providers/routing.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import type { ToolContext, ToolDefinition, ToolSource } from '../tools/registry.ts';
import type { UsageLogger } from '../usage/logger.ts';
import {
  buildHistory,
  buildSystem,
  extractText,
  volatileContext,
  withCacheBreakpoints,
} from './prompt-builder.ts';

/** Supplies the agent-to-agent tools (`send_to`, `reply`) for a run. */
export interface MeshToolProvider {
  toolsFor(agent: AgentDefinition, mesh: MeshContext | undefined): ToolDefinition<any>[];
}

export interface AgentLoopDeps {
  /** A message when today's spending limit is reached; model calls stop until tomorrow. */
  budgetCheck?: () => string | null;
  messages: MessagesRepo;
  threads: ThreadRepo;
  memory: MemoryStore;
  usage: UsageLogger;
  models: ModelService;
  tools: ToolSource;
  executor: ToolExecutor;
  gate: PermissionGate;
  allowedDirs: string[];
  timezone: string;
  mesh?: MeshToolProvider;
  /** Folder shown to the model as its working folder; defaults to the first allowed folder. */
  workingDir?: () => string | undefined;
  /** Stable text appended to every agent's instructions (persona file, skill index). */
  promptExtras?: (agent: AgentDefinition) => string;
  /** Lines for the volatile block at the bottom of the prompt (the agent's status). */
  contextExtras?: (agent: AgentDefinition) => string;
  /** Tools that exist only for this run (the agent's skills). */
  extraTools?: (agent: AgentDefinition, input: RunInput) => ToolDefinition<any>[];
  now?: () => Date;
  /** The user's files: tied to the message that carries them, and shown as they are to a model that can see. */
  media?: {
    link(attachmentIds: string[], messageId: number): void;
    imageParts(messageIds: number[], limit: number): Map<number, Array<{ type: 'file'; data: Buffer; mediaType: string; filename: string }>>;
  };
}

/** How many of a session's newest images a vision-capable chat model gets as pictures. */
const MAX_PROMPT_IMAGES = 6;

export interface RunInput {
  agent: AgentDefinition;
  /**
   * What wakes the agent: the user's message, or a rendered agent-to-agent message.
   * Leave it out in a group chat when the agent is answering what is already in the thread.
   */
  userText?: string;
  thread?: string;
  /** The thread is shared by several agents: their messages are shown to each other by name. */
  group?: boolean;
  /** Stable instructions for this conversation (group rules), appended to the agent's own. */
  instructions?: string;
  /** Extra lines for the volatile block stored with the message (what the last session was about). */
  context?: string;
  /** Files sent with `userText` (already read into it as text). */
  attachments?: string[];
  signal?: AbortSignal;
  /** Shared by every run that belongs to the same user turn or scheduled task. */
  traceId?: string;
  mesh?: MeshContext;
  budget?: TraceBudget;
}

const DENIAL_TEXT = {
  denied: 'The user denied this tool call; it was not run.',
  timeout: 'The permission request timed out; the tool was not run.',
  error: 'The permission request failed; the tool was not run.',
  policy: 'This tool is disabled by the permission settings; it was not run.',
} as const;

/** Tool schemas only, no `execute`: the loop runs tools itself, behind the permission gate. */
function toSdkTools(tools: ToolDefinition[]): ToolSet | undefined {
  if (tools.length === 0) return undefined;
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({ description: definition.description, inputSchema: definition.inputSchema }),
    ]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs a tool while forwarding the events it emits (sub-agent activity) as they happen.
 * Returns the tool's output, or throws what the tool threw.
 */
async function* executeStreaming(
  deps: AgentLoopDeps,
  definition: ToolDefinition,
  input: unknown,
  context: ToolContext,
): AsyncGenerator<AgentEvent, string> {
  const pending: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let settled = false;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const execution = deps.executor
    .execute(definition, input, {
      ...context,
      emit: (event) => {
        pending.push(event);
        notify();
      },
    })
    .finally(() => {
      settled = true;
      notify();
    });
  execution.catch(() => {}); // surfaced by the await below

  while (true) {
    while (pending.length > 0) yield pending.shift()!;
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  return await execution;
}

async function* runToolCall(
  deps: AgentLoopDeps,
  tools: ToolDefinition[],
  call: ToolCall,
  context: ToolContext,
): AsyncGenerator<AgentEvent, ToolResult> {
  const definition = tools.find((candidate) => candidate.name === call.name);
  yield { type: 'tool-call', call, risk: definition?.risk ?? null };

  const finish = (ok: boolean, output: string): ToolResult => ({
    callId: call.id,
    name: call.name,
    ok,
    output,
  });
  let result: ToolResult;

  const parsed = definition?.inputSchema.safeParse(call.input);
  if (!definition || !parsed) {
    result = finish(false, `Unknown tool "${call.name}".`);
  } else if (!parsed.success) {
    result = finish(false, `Invalid tool input:\n${z.prettifyError(parsed.error)}`);
  } else {
    let denial: string | null = null;
    const mode = deps.gate.modeFor(definition.name, definition.risk);
    if (mode === 'deny') {
      denial = DENIAL_TEXT.policy;
    } else if (mode === 'ask') {
      const request = deps.gate.createRequest({
        traceId: context.traceId,
        agent: context.agent,
        tool: definition.name,
        risk: definition.risk,
        input: parsed.data,
        summary: definition.summarize(parsed.data),
      });
      yield { type: 'permission-request', request };
      const decision = await deps.gate.decide(request);
      yield { type: 'permission-decision', requestId: request.id, decision };
      if (!decision.allow) denial = DENIAL_TEXT[decision.reason];
    }

    if (denial) {
      result = finish(false, denial);
    } else {
      try {
        result = finish(true, yield* executeStreaming(deps, definition, parsed.data, context));
      } catch (error) {
        result = finish(false, `Tool failed: ${errorMessage(error)}`);
      }
    }
  }

  yield { type: 'tool-result', result };
  return result;
}

/**
 * Runs one agent loop: model call -> tool calls -> model call ... until the model
 * stops asking for tools, hands the turn to another agent, or a budget is hit.
 * Everything is persisted as it happens.
 */
export async function* runAgent(deps: AgentLoopDeps, input: RunInput): AsyncGenerator<AgentEvent> {
  const { agent, signal, budget } = input;
  const thread = input.thread ?? 'main';
  const traceId = input.traceId ?? randomUUID();

  // Over the daily budget: refuse before anything is stored, like a config error.
  const overBudget = deps.budgetCheck?.();
  if (overBudget) throw new Error(overBudget);
  // Config errors (unknown tool or model, missing API key) surface before anything is stored.
  const resolved = deps.models.resolve('chat', agent.models);
  // An effort set on the agent wins over the preset's.
  const modelRef = agent.effort ? { ...resolved, params: { ...resolved.params, reasoning: agent.effort } } : resolved;
  const modelInfo = deps.models.info(modelRef);
  const tools = [
    ...deps.tools.select(agent.tools),
    ...(deps.mesh?.toolsFor(agent, input.mesh) ?? []),
    ...(deps.extraTools?.(agent, input) ?? []),
  ];
  const model = await deps.models.languageModel(modelRef);
  const sdkTools = toSdkTools(tools);

  let handoff: { messageId: number; to: string } | undefined;
  const toolContext: ToolContext = {
    traceId,
    thread,
    agent: agent.name,
    allowedDirs: deps.allowedDirs,
    signal,
    mesh: input.mesh,
    requestHandoff: (request) => {
      handoff = request;
    },
  };

  const persist = (role: MessageRole, content: unknown, context?: string) =>
    deps.messages.append({
      thread,
      traceId,
      agent: agent.name,
      role,
      content,
      text: extractText(role, content),
      context,
    });

  // Prompt = stable prefix (persona, memory snapshot, summaries) -> raw messages since the
  // last compaction -> the new user message with the volatile block. Only the tail is new.
  const state = deps.threads.ensureState(thread, () => deps.memory.renderSnapshot());
  const system = buildSystem({
    agent,
    workingDir: deps.workingDir ? deps.workingDir() : deps.allowedDirs[0],
    extras: [deps.promptExtras?.(agent), input.instructions].filter(Boolean).join('\n\n'),
    memorySnapshot: state.memorySnapshot,
    summaries: deps.threads.activeSummaries(thread),
  });
  // Without a message of its own (a group member answering the others), the run still
  // stores a row: it carries the volatile block, so the prompt can be rebuilt byte for byte.
  const userMessageId = persist(
    'user',
    input.userText ?? '',
    volatileContext(
      deps.now?.() ?? new Date(),
      deps.timezone,
      [deps.contextExtras?.(agent), input.context].filter(Boolean).join('\n'),
    ),
  );
  if (input.attachments?.length) deps.media?.link(input.attachments, userMessageId);
  const tail = deps.messages.after(thread, state.summarizedThrough);
  // A model that can see gets the pictures themselves, not only their description.
  const media =
    modelInfo.imageInput && deps.media
      ? deps.media.imageParts(
          tail.filter((message) => message.role === 'user').map((message) => message.id),
          MAX_PROMPT_IMAGES,
        )
      : undefined;
  const messages = buildHistory(tail, agent.name, { group: input.group, media });
  const providerOptions = providerOptionsFor(modelInfo);

  const runId = deps.usage.startRun({ traceId, agent: agent.name, model: modelRef });
  const startedAt = Date.now();
  const total: UsageSnapshot = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  let rounds = 0;
  let contextTokens = 0;
  let text = '';
  let reason: RunFinishReason = 'stop';
  let error: string | undefined;

  yield { type: 'run-start', traceId, agent: agent.name, model: formatModelRef(modelRef), userMessageId };

  try {
    while (true) {
      if (signal?.aborted) {
        reason = 'aborted';
        break;
      }
      const exhausted = budget?.exhausted();
      if (exhausted) {
        reason = 'trace_budget';
        error = exhausted;
        break;
      }
      rounds++;
      text = '';
      const callStartedAt = Date.now();
      const prompt = withCacheBreakpoints(modelInfo.npm, system, messages);
      const result = streamText({
        model,
        instructions: prompt.system,
        messages: prompt.messages,
        tools: sdkTools,
        providerOptions,
        ...modelRef.params,
        abortSignal: signal,
        // Errors arrive as stream parts and are handled below; skip the default console dump.
        onError: () => {},
      });

      const calls: ToolCall[] = [];
      let usage: LanguageModelUsage | undefined;
      let aborted = false;
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          text += part.text;
          yield { type: 'text-delta', text: part.text };
        } else if (part.type === 'tool-call') {
          calls.push({ id: part.toolCallId, name: part.toolName, input: part.input });
        } else if (part.type === 'finish-step') {
          usage = part.usage;
        } else if (part.type === 'abort') {
          aborted = true;
        } else if (part.type === 'error') {
          throw part.error;
        }
      }
      if (aborted) {
        reason = 'aborted';
        break;
      }

      // The SDK rejects malformed calls (unknown tool, bad input) itself and puts the
      // error result in the response; only the calls still open are ours to run.
      const rejected = new Map<string, string>();
      for (const message of await result.responseMessages) {
        messages.push(message);
        const storedId = persist(message.role, message.content);
        // Files a tool of this round sends are shown under the message that called it.
        if (message.role === 'assistant') toolContext.messageId = storedId;
        if (message.role !== 'tool') continue;
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue;
          const value = 'value' in part.output ? part.output.value : undefined;
          rejected.set(part.toolCallId, typeof value === 'string' ? value : 'Tool call rejected.');
        }
      }

      const snapshot = deps.usage.logCall({
        runId,
        traceId,
        agent: agent.name,
        kind: 'chat',
        model: modelInfo,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cachedTokens: usage?.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.inputTokenDetails.cacheWriteTokens ?? 0,
        durationMs: Date.now() - callStartedAt,
      });
      total.inputTokens += snapshot.inputTokens;
      total.outputTokens += snapshot.outputTokens;
      total.cachedTokens += snapshot.cachedTokens;
      total.costUsd += snapshot.costUsd;
      contextTokens = snapshot.inputTokens + snapshot.outputTokens;
      budget?.charge(contextTokens);
      yield { type: 'usage', round: rounds, usage: snapshot };

      if (calls.length === 0) break;

      const results: ToolResult[] = [];
      for (const call of calls) {
        const rejection = rejected.get(call.id);
        if (rejection === undefined) {
          results.push(yield* runToolCall(deps, tools, call, toolContext));
          continue;
        }
        yield { type: 'tool-call', call, risk: null };
        yield {
          type: 'tool-result',
          result: { callId: call.id, name: call.name, ok: false, output: rejection },
        };
      }
      if (results.length > 0) {
        const toolMessage: ModelMessage = {
          role: 'tool',
          content: results.map((toolResult) => ({
            type: 'tool-result' as const,
            toolCallId: toolResult.callId,
            toolName: toolResult.name,
            output: { type: toolResult.ok ? 'text' : 'error-text', value: toolResult.output },
          })),
        };
        messages.push(toolMessage);
        persist('tool', toolMessage.content);
      }

      if (handoff) {
        reason = 'handoff';
        break;
      }
      if (total.inputTokens + total.outputTokens >= agent.budgets.maxTokens) {
        reason = 'max_tokens';
        break;
      }
      if (rounds >= agent.budgets.maxRounds) {
        reason = 'max_rounds';
        break;
      }
    }
  } catch (caught) {
    reason = signal?.aborted ? 'aborted' : 'error';
    if (reason === 'error') error = errorMessage(caught);
  }

  deps.usage.finishRun(runId, {
    status: reason,
    rounds,
    usage: total,
    durationMs: Date.now() - startedAt,
    error,
  });
  yield {
    type: 'run-finish',
    traceId,
    reason,
    rounds,
    usage: total,
    contextTokens,
    text,
    handoff: reason === 'handoff' ? handoff : undefined,
    error,
  };
}
