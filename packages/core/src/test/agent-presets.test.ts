import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_PRESETS, agentPresets } from '../agents/presets.ts';
import { makeTestCore } from './core-helpers.ts';

test('agent presets: every tool exists and none mixes untrusted content with the shell', async (t) => {
  const harness = await makeTestCore();
  t.after(() => harness.cleanup());
  const tools = harness.core.tools;
  const presets = agentPresets((name) => Boolean(tools.get(name)));
  assert.equal(presets.length, AGENT_PRESETS.length);
  for (const [index, preset] of presets.entries()) {
    assert.deepEqual(preset.tools, AGENT_PRESETS[index]!.tools, `${preset.id}: every listed tool is registered`);
    assert.doesNotThrow(() => tools.select(preset.tools), preset.id);
    assert.match(preset.name, /^[a-z][a-z0-9_-]*$/);
  }
  assert.equal(new Set(presets.map((preset) => preset.id)).size, presets.length);
  // Presets that read the web or mail never get a shell tool.
  const secretary = presets.find((preset) => preset.id === 'secretary')!;
  assert.ok(secretary.tools.includes('web_search'));
  assert.ok(!secretary.tools.some((name) => tools.get(name)?.risk === 'shell'));
});

test('agent presets: unknown tools are left out instead of failing the save', () => {
  const presets = agentPresets((name) => name !== 'web_search');
  assert.ok(presets.every((preset) => !preset.tools.includes('web_search')));
});
