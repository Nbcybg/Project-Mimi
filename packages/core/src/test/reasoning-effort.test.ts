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
