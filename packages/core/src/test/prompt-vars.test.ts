import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentFile } from '../agents/loader.ts';
import { buildSystem } from '../loop/prompt-builder.ts';
import { buildPromptVars, renderPromptVars } from '../loop/prompt-vars.ts';
import { makeAgent } from './helpers.ts';

const vars = buildPromptVars({
  userName: 'Ann',
  self: { name: 'mimi', displayName: 'Mimi' },
  agents: [
    { name: 'mimi', displayName: 'Mimi' },
    { name: 'tim', displayName: 'Tim' },
    { name: 'karen', displayName: '' },
  ],
  extra: { wa01: 'work outfit' },
});

test('{{user}}, {{char}} and {{agent id}} are replaced; unknown names are left alone', () => {
  assert.equal(renderPromptVars('{{char}} helps {{user}}. Ask {{ tim }} or {{karen}}.', vars), 'Mimi helps Ann. Ask Tim or karen.');
  assert.equal(renderPromptVars('{{User}} / {{CHAR}}', vars), 'Ann / Mimi');
  assert.equal(renderPromptVars('Dear {{customer}}, {{ $json.x }}', vars), 'Dear {{customer}}, {{ $json.x }}');
  assert.equal(renderPromptVars('wearing {{wa01}}', vars), 'wearing work outfit');
});

test('an agent or outfit cannot shadow {{user}} or {{char}}', () => {
  const shadow = buildPromptVars({
    userName: 'Ann',
    self: { name: 'mimi', displayName: 'Mimi' },
    agents: [{ name: 'user', displayName: 'Hijack' }],
    extra: { char: 'Hijack' },
  });
  assert.equal(renderPromptVars('{{user}} {{char}}', shadow), 'Ann Mimi');
  assert.throws(() => parseAgentFile('---\nname: user\n---\nhi'), /reserved/);
});

test('buildSystem renders the persona and says who is who', () => {
  const agent = makeAgent({ name: 'mimi', displayName: 'Mimi', systemPrompt: '{{char}} is the secretary of {{user}}. Colleague: {{tim}}.' });
  const [block] = buildSystem({ agent, workingDir: undefined, memorySnapshot: '', summaries: [], vars });
  const text = String(block!.content);
  assert.match(text, /^Mimi is the secretary of Ann\. Colleague: Tim\./);
  assert.match(text, /Your name: Mimi \(agent id: mimi\)\. The person you talk to: Ann\./);
  assert.equal(String(buildSystem({ agent, workingDir: undefined, memorySnapshot: '', summaries: [] })[0]!.content).includes('Who is who'), false);
});
