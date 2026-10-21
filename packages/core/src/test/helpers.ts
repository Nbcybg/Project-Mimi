import type { AgentEvent, Capability, PermissionRequest } from '@mimi/shared';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { AgentDefinition } from '../agents/loader.ts';
import { type Db, openDb } from '../db/db.ts';
import { MessagesRepo } from '../db/messages-repo.ts';
import { ThreadRepo } from '../db/thread-repo.ts';
import type { AgentLoopDeps } from '../loop/agent-loop.ts';
import { MemoryStore } from '../memory/store.ts';
import { type PermissionBroker, PermissionGate } from '../permissions/gate.ts';
import type { ModelCost, ModelInfo, ModelRef } from '../providers/registry.ts';
import type { MediaKind, ModelService } from '../providers/routing.ts';
import { LocalExecutor } from '../tools/executor.ts';
import { createMemoryTools } from '../tools/memory-tools.ts';
import { defineTool, ToolRegistry } from '../tools/registry.ts';
import { UsageLogger } from '../usage/logger.ts';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type Chunk = StreamResult['stream'] extends ReadableStream<infer T> ? T : never;
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

export interface StepUsage {
  input?: number;
  cached?: number;
  output?: number;
}

function usageOf(usage: StepUsage) {
  const input = usage.input ?? 10;
  const cached = usage.cached ?? 0;
  const output = usage.output ?? 5;
  return {
    inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function finishChunk(reason: 'stop' | 'tool-calls', usage: StepUsage): Chunk {
  return { type: 'finish', finishReason: { unified: reason, raw: undefined }, usage: usageOf(usage) };
}

/** A streamed model step that answers with plain text. */
export function textStep(text: string, usage: StepUsage = {}): Chunk[] {
  return [
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    finishChunk('stop', usage),
  ];
}

/** A streamed model step that asks for one tool call. */
export function toolStep(toolName: string, input: unknown, id = 'call-1', usage: StepUsage = {}): Chunk[] {
  return [
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    finishChunk('tool-calls', usage),
  ];
}

/** Mock chat model that plays `steps` in order; the last step repeats once the list runs out. */
export function scriptedModel(steps: Chunk[][]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = steps[Math.min(call++, steps.length - 1)]!;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

export interface Reply {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
}

/**
 * Mock non-streaming model (summarizer, memory writer). Replies are played in order,
 * the last one repeats; a function reply receives the prompt as text.
 */
export function replyingModel(replies: Array<Reply | ((prompt: string) => Reply)>): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options): Promise<GenerateResult> => {
      const next = replies[Math.min(call++, replies.length - 1)]!;
      const reply = typeof next === 'function' ? next(JSON.stringify(options.prompt)) : next;
      const toolCalls = reply.toolCalls ?? [];
      return {
        content: [
          ...(reply.text ? [{ type: 'text' as const, text: reply.text }] : []),
          ...toolCalls.map((toolCall, index) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${index}`,
            toolName: toolCall.name,
            input: JSON.stringify(toolCall.input),
          })),
        ],
        finishReason: { unified: toolCalls.length > 0 ? 'tool-calls' : 'stop', raw: undefined },
        usage: usageOf({ input: 100, output: 20 }),
        warnings: [],
      };
    },
  });
}

/** Everything a non-streaming mock was sent on call `index`, as text. */
export function generatePromptOf(model: MockLanguageModelV4, index: number): string {
  return JSON.stringify(model.doGenerateCalls[index]!.prompt);
}

export const TEST_COST: ModelCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };

export interface FakeModelsOptions {
  chat: MockLanguageModelV4;
  /** Used for the `summarize` capability; defaults to the chat model. */
  small?: MockLanguageModelV4;
  contextLimit?: number;
  smallContextLimit?: number;
  npm?: string;
  /** The chat models can see images (the catalog's image input). */
  imageInput?: boolean;
  /** The catalog's input modalities for the chat models (text, image, audio, video, pdf). */
  inputs?: string[];
  /** Models that make pictures / speech / video (generate_image, text_to_speech, generate_video). */
  media?: Partial<Record<MediaKind, unknown>>;
  /** Chat models for agents that set `model: test/<name>` in their file. */
  byModel?: Record<string, MockLanguageModelV4>;
}

/**
 * Model service backed by mocks: `test/chat` for chat (or the agent's own `test/<name>`),
 * `test/small` for background jobs.
 */
export function fakeModels(options: FakeModelsOptions): ModelService {
  return {
    resolve: (capability: Capability, agent?: { model?: string }): ModelRef => ({
      provider: 'test',
      model: capability !== 'chat' ? 'small' : (agent?.model?.replace(/^test\//, '') ?? 'chat'),
    }),
    info: (ref: ModelRef): ModelInfo => ({
      ref,
      name: ref.model,
      npm: options.npm ?? '@ai-sdk/test',
      baseURL: undefined,
      textOutput: true,
      contextLimit:
        ref.model === 'small' ? (options.smallContextLimit ?? 100_000) : (options.contextLimit ?? 100_000),
      outputLimit: undefined,
      cost: TEST_COST,
      imageInput: ref.model !== 'small' && (options.imageInput ?? false),
      inputs: ref.model === 'small' ? undefined : options.inputs,
      toolCall: true,
      options: {},
    }),
    ...(options.media
      ? {
          mediaModel: async (kind: MediaKind) => {
            const model = options.media?.[kind];
            if (!model) throw new Error(`No ${kind} model in this test.`);
            return model as never;
          },
        }
      : {}),
    languageModel: async (ref: ModelRef) =>
      ref.model === 'small'
        ? (options.small ?? options.chat)
        : (options.byModel?.[ref.model] ?? options.chat),
  };
}

export class FakeBroker implements PermissionBroker {
  readonly requests: PermissionRequest[] = [];
  private readonly answer: boolean | 'never';

  constructor(answer: boolean | 'never') {
    this.answer = answer;
  }

  request(request: PermissionRequest): Promise<boolean> {
    this.requests.push(request);
    if (this.answer === 'never') return new Promise(() => {});
    return Promise.resolve(this.answer);
  }
}

export function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'mimi',
    displayName: '',
    description: '',
    models: {},
    tools: ['echo', 'danger'],
    skills: [],
    canMessage: [],
    budgets: { maxRounds: 12, maxTokens: 200_000 },
    systemPrompt: 'You are a test agent.',
    ...overrides,
  };
}

export interface Harness {
  db: Db;
  deps: AgentLoopDeps;
  broker: FakeBroker;
  /** Inputs of every `echo` / `danger` execution, in order. */
  executed: Array<{ tool: string; input: unknown }>;
}

export interface HarnessOptions extends Partial<FakeModelsOptions> {
  approve?: boolean | 'never';
  permissionTimeoutMs?: number;
}

export function makeHarness(model: MockLanguageModelV4, options: HarnessOptions = {}): Harness {
  const db = openDb(':memory:');
  const broker = new FakeBroker(options.approve ?? true);
  const executed: Harness['executed'] = [];
  const messages = new MessagesRepo(db);
  const memory = new MemoryStore(db);

  const echo = defineTool({
    name: 'echo',
    description: 'Echo text back',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ text: z.string() }),
    summarize: (input) => `Echo ${input.text}`,
    async execute(input) {
      executed.push({ tool: 'echo', input });
      return `echo: ${input.text}`;
    },
  });
  const danger = defineTool({
    name: 'danger',
    description: 'Pretend to change something',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({ target: z.string() }),
    summarize: (input) => `Change ${input.target}`,
    async execute(input) {
      executed.push({ tool: 'danger', input });
      return `changed ${input.target}`;
    },
  });

  return {
    db,
    broker,
    executed,
    deps: {
      messages,
      threads: new ThreadRepo(db),
      memory,
      usage: new UsageLogger(db),
      models: fakeModels({ ...options, chat: model }),
      tools: new ToolRegistry().register(echo, danger, ...createMemoryTools(memory, messages)),
      executor: new LocalExecutor(),
      gate: new PermissionGate(broker, { timeoutMs: options.permissionTimeoutMs ?? 1_000 }),
      allowedDirs: [],
      timezone: 'Asia/Bangkok',
      now: () => new Date('2026-10-12T05:00:00Z'),
    },
  };
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

export function eventsOf<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}
