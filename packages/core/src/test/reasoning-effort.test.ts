import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { resolveModelName } from '../providers/routing.ts';

test('reasoning effort: a preset carries it, and the AI SDK hands it to the model call', async () => {
  const ref = resolveModelName('thinker', { thinker: { model: 'opencode-go/deepseek-v4-flash', reasoning: 'high', temperature: 0.3 } });
  assert.deepEqual(ref, { provider: 'opencode-go', model: 'deepseek-v4-flash', params: { reasoning: 'high', temperature: 0.3 } });
  assert.equal(resolveModelName('opencode-go/deepseek-v4-flash', {}).params, undefined, 'a bare model uses the provider default');

  // The core spreads `ref.params` into every call; the provider receives `reasoning`.
  let seen: unknown;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen = (options as { reasoning?: unknown }).reasoning;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  await generateText({ model, prompt: 'hi', ...ref.params });
  assert.equal(seen, 'high');
});

test('sampling penalties: SDK settings go to the call, the rest become provider options of the request body', async () => {
  const ref = resolveModelName('tidy', {
    tidy: { model: 'local/qwen', presencePenalty: 0.5, frequencyPenalty: -0.2, repetitionPenalty: 1.1, minTokens: 16 },
  });
  assert.deepEqual(ref, {
    provider: 'local',
    model: 'qwen',
    params: { presencePenalty: 0.5, frequencyPenalty: -0.2 },
    extra: { min_tokens: 16, repetition_penalty: 1.1 },
  });
  assert.equal(resolveModelName('plain', { plain: { model: 'local/qwen' } }).extra, undefined, 'nothing extra unless set');

  let seen: { presencePenalty?: unknown; frequencyPenalty?: unknown } = {};
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen = options as typeof seen;
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  await generateText({ model, prompt: 'hi', ...ref.params });
  assert.equal(seen.presencePenalty, 0.5);
  assert.equal(seen.frequencyPenalty, -0.2);
});
