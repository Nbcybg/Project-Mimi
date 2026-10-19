import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@mimi/shared';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { type CoreConfig, loadConfig } from '../config.ts';
import { type Core, createCore } from '../core.ts';
import { ModelCatalog } from '../providers/catalog.ts';
import { parseSettings, type Settings } from '../providers/settings.ts';
import { FakeBroker, type FakeModelsOptions, fakeModels, replyingModel, scriptedModel, textStep } from './helpers.ts';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type Chunk = StreamResult['stream'] extends ReadableStream<infer T> ? T : never;

const AGENT_FILES: Record<string, string> = {
  mimi: `---
name: mimi
description: Secretary
model: test/mimi
tools: [read_file, write_file, create_trigger, list_triggers, load_skill, read_memory]
can_message: [tim, scout]
---
You are Mimi.`,
  tim: `---
name: tim
description: Butler and planner
model: test/tim
tools: [read_file]
can_message: [mimi, scout]
---
You are Tim.`,
  scout: `---
name: scout
description: Third test agent
model: test/scout
can_message: [tim]
---
You are Scout.`,
};

/** A throwaway user workspace with three agents, a persona file and one skill. */
export function makeTestRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-root-')));
  for (const [name, source] of Object.entries(AGENT_FILES)) {
    fs.mkdirSync(path.join(root, 'user/agents', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'user/agents', name, 'agent.md'), source);
  }
  fs.writeFileSync(path.join(root, 'user/persona.md'), 'PERSONA: the household speaks Thai.');
  fs.mkdirSync(path.join(root, 'user/skills'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'user/skills/night-quiz.md'),
    '---\nname: night-quiz\ndescription: Bedtime quiz game\n---\nQUIZ RULES: ask five questions.',
  );
  fs.mkdirSync(path.join(root, 'user/workspace'));
  return root;
}

/**
 * Mock chat model whose answer depends on what it was sent, which is what recursive
 * agent-to-agent runs need (one model serves several nested runs of the same agent).
 */
export function reactiveModel(respond: (prompt: string, call: number) => Chunk[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: simulateReadableStream({ chunks: respond(JSON.stringify(options.prompt), call++) }),
    }),
  });
}

/** A model that accepts the request and then never produces anything. */
export function hangingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: new ReadableStream<Chunk>({ start() {} }) }),
  });
}

export interface TestCoreOptions {
  /** Chat model per agent name; agents without one answer "ok". */
  models?: Record<string, MockLanguageModelV4>;
  small?: MockLanguageModelV4;
  settings?: Record<string, unknown>;
  approve?: boolean | 'never';
  env?: NodeJS.ProcessEnv;
  /** The chat models can see images. */
  imageInput?: boolean;
  media?: FakeModelsOptions['media'];
}

export interface TestCore {
  core: Core;
  root: string;
  config: CoreConfig;
  settings: Settings;
  broker: FakeBroker;
  small: MockLanguageModelV4;
  coreOptions: Parameters<typeof createCore>[2];
  cleanup(): Promise<void>;
}

/** Everything `createCore` needs for a test: temp project root, mock models, injected settings. */
export function testCoreParts(options: TestCoreOptions = {}) {
  const root = makeTestRoot();
  const config = loadConfig({
    MIMI_ROOT: root,
    MIMI_DB: ':memory:',
    PERMISSION_TIMEOUT_MS: '1000',
    PORT: '0',
    MIMI_TOKEN: 'test-token',
    ...options.env,
  });
  const settings = parseSettings({ model: 'test/chat', ...options.settings }, {});
  const small = options.small ?? replyingModel([{ text: 'nothing' }]);
  const coreOptions = {
    settings,
    catalog: new ModelCatalog(),
    models: fakeModels({
      chat: scriptedModel([textStep('ok')]),
      small,
      byModel: options.models,
      imageInput: options.imageInput,
      media: options.media,
    }),
  };
  return { root, config: { ...config, dbPath: ':memory:' }, settings, small, coreOptions };
}

export async function makeTestCore(options: TestCoreOptions = {}): Promise<TestCore> {
  const parts = testCoreParts(options);
  const broker = new FakeBroker(options.approve ?? true);
  const core = await createCore(parts.config, broker, parts.coreOptions);
  return {
    ...parts,
    core,
    broker,
    async cleanup() {
      await core.close();
      fs.rmSync(parts.root, { recursive: true, force: true });
    },
  };
}

/** Flattens sub-agent activity so assertions can look at every event of a turn. */
export function flatten(events: AgentEvent[]): Array<{ agent: string | null; event: AgentEvent }> {
  const out: Array<{ agent: string | null; event: AgentEvent }> = [];
  const walk = (event: AgentEvent, agent: string | null) => {
    if (event.type === 'agent-activity') walk(event.event, event.agent);
    else out.push({ agent, event });
  };
  for (const event of events) walk(event, null);
  return out;
}
