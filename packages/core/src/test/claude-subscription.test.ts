import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent } from '@mimi/shared';
import { ModelCatalog } from '../providers/catalog.ts';
import {
  checkClaudeLogin,
  CLAUDE_SUBSCRIPTION_ID,
  CLAUDE_SUBSCRIPTION_MODELS,
  CLAUDE_SUBSCRIPTION_NPM,
  EventQueue,
  isClaudeSubscription,
  withSideEvents,
} from '../providers/claude-subscription.ts';
import { ProviderRegistry } from '../providers/registry.ts';

const text = (value: string): AgentEvent => ({ type: 'text-delta', text: value });

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

test('withSideEvents passes tool events through while the model stream is waiting', async () => {
  const queue = new EventQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* stream() {
    yield 'a';
    await gate; // the CLI is waiting on a tool; nothing arrives on the stream
    yield 'b';
  }
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const item of withSideEvents(stream(), queue)) {
      seen.push('part' in item ? item.part : `event:${(item.event as { text: string }).text}`);
      if (seen.at(-1) === 'event:ask') release();
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 20));
  queue.push(text('ask'));
  await consumer;
  assert.deepEqual(seen, ['a', 'event:ask', 'b']);
});

test('withSideEvents drains events raised after the stream ended', async () => {
  const queue = new EventQueue();
  async function* stream() {
    queue.push(text('last'));
    yield 1;
  }
  const items = await collect(withSideEvents(stream(), queue));
  assert.equal(items.length, 2);
  assert.ok(items.some((item) => 'event' in item));
});

test('a token in the environment counts as logged in, without starting the CLI', async () => {
  await checkClaudeLogin({ CLAUDE_CODE_OAUTH_TOKEN: 'x' });
});

test('a stored claude-subscription provider is offered without a key', () => {
  const registry = new ProviderRegistry(new ModelCatalog({}), {}, {}, {
    extra: () => ({ [CLAUDE_SUBSCRIPTION_ID]: { name: 'Claude (plan)', npm: CLAUDE_SUBSCRIPTION_NPM, models: CLAUDE_SUBSCRIPTION_MODELS } }),
    listed: () => ({ [CLAUDE_SUBSCRIPTION_ID]: Object.keys(CLAUDE_SUBSCRIPTION_MODELS) }),
  });
  const provider = registry.available().find((entry) => entry.id === CLAUDE_SUBSCRIPTION_ID);
  assert.ok(provider);
  assert.deepEqual(provider.models.map((model) => model.ref.model).sort(), ['haiku', 'opus', 'sonnet']);
  const info = registry.info({ provider: CLAUDE_SUBSCRIPTION_ID, model: 'sonnet' });
  assert.ok(isClaudeSubscription(info.npm));
  assert.equal(info.cost, null);
  assert.equal(registry.hasCredentials(CLAUDE_SUBSCRIPTION_ID), true);
});
