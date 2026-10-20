import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent } from '@mimi/shared';
import { MockLanguageModelV4 } from 'ai/test';
import { runAgent } from '../loop/agent-loop.ts';
import {
  collect,
  eventsOf,
  makeAgent,
  makeHarness,
  scriptedModel,
  textStep,
  toolStep,
} from './helpers.ts';

interface RunRow {
  status: string;
  rounds: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}

function runRow(db: ReturnType<typeof makeHarness>['db']): RunRow {
  return db.prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1').get() as RunRow;
}

function storedRoles(db: ReturnType<typeof makeHarness>['db']): string[] {
  const rows = db.prepare('SELECT role FROM messages ORDER BY id').all() as { role: string }[];
  return rows.map((row) => row.role);
}

/** Text of everything the model was sent on call `index`, for prompt assertions. */
function promptOf(model: MockLanguageModelV4, index: number): string {
  return JSON.stringify(model.doStreamCalls[index]!.prompt);
}

/** A bad tool call must surface as one failed result, reach the model once, and not end the run. */
function assertRejectedOnce(events: AgentEvent[], model: MockLanguageModelV4): void {
  const results = eventsOf(events, 'tool-result');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.result.ok, false);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(promptOf(model, 1).split('"type":"tool-result"').length - 1, 1);
  assert.equal(eventsOf(events, 'run-finish')[0]!.reason, 'stop');
}

test('plain answer: streams text, stores both messages, logs usage', async () => {
  const model = scriptedModel([textStep('Hello, world!', { input: 100, cached: 40, output: 20 })]);
  const harness = makeHarness(model);

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'hi' }));

  const text = eventsOf(events, 'text-delta').map((event) => event.text).join('');
  assert.equal(text, 'Hello, world!');
  const finish = eventsOf(events, 'run-finish')[0]!;
  assert.equal(finish.reason, 'stop');
  assert.equal(finish.rounds, 1);
  assert.deepEqual(
    { ...finish.usage, costUsd: undefined },
    { inputTokens: 100, outputTokens: 20, cachedTokens: 40, costUsd: undefined },
  );

  assert.deepEqual(storedRoles(harness.db), ['user', 'assistant']);
  assert.equal(runRow(harness.db).status, 'stop');
  const calls = harness.db.prepare('SELECT COUNT(*) AS n FROM usage_log').get() as { n: number };
  assert.equal(calls.n, 1);
});

test('voice direction is stored apart from the visible answer', async () => {
  const model = scriptedModel([textStep('[emotion: เศร้า][tone: กระซิบ][speed: 0.9]\nฉันขอโทษนะ')]);
  const harness = makeHarness(model);

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'เป็นอะไร' }));

  const finish = eventsOf(events, 'run-finish')[0]!;
  assert.equal(finish.text, 'ฉันขอโทษนะ');
  assert.deepEqual(finish.speech, { emotion: 'เศร้า', tone: 'กระซิบ', speed: 0.9 });
  assert.equal(eventsOf(events, 'text-delta').map((event) => event.text).join(''), 'ฉันขอโทษนะ');
  const row = harness.db.prepare('SELECT text, speech FROM messages WHERE role = ?').get('assistant') as {
    text: string;
    speech: string | null;
  };
  assert.equal(row.text, 'ฉันขอโทษนะ');
  assert.deepEqual(JSON.parse(row.speech!), { emotion: 'เศร้า', tone: 'กระซิบ', speed: 0.9 });

  await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'ต่อ' }));
  assert.match(promptOf(model, 1), /ฉันขอโทษนะ/);
  assert.doesNotMatch(promptOf(model, 1), /\[emotion: เศร้า\]/);
});

test('ordinary bracket text still streams when it starts the reply', async () => {
  const model = scriptedModel([textStep('[1] หมายเหตุ')]);
  const harness = makeHarness(model);

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'hi' }));

  assert.equal(eventsOf(events, 'text-delta').map((event) => event.text).join(''), '[1] หมายเหตุ');
  assert.equal(eventsOf(events, 'run-finish')[0]!.text, '[1] หมายเหตุ');
  assert.equal(eventsOf(events, 'run-finish')[0]!.speech, undefined);
});

test('tool call: runs the tool, feeds the result back, then answers', async () => {
  const model = scriptedModel([toolStep('echo', { text: 'ping' }), textStep('done')]);
  const harness = makeHarness(model);

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'echo it' }));

  assert.deepEqual(harness.executed, [{ tool: 'echo', input: { text: 'ping' } }]);
  assert.equal(harness.broker.requests.length, 0, 'read-only tools must not ask');
  const result = eventsOf(events, 'tool-result')[0]!.result;
  assert.deepEqual(result, { callId: 'call-1', name: 'echo', ok: true, output: 'echo: ping' });

  assert.equal(model.doStreamCalls.length, 2);
  assert.match(promptOf(model, 1), /echo: ping/);
  assert.equal(eventsOf(events, 'run-finish')[0]!.rounds, 2);
  assert.deepEqual(storedRoles(harness.db), ['user', 'assistant', 'tool', 'assistant']);
});

test('max_rounds budget stops a model that never stops calling tools', async () => {
  const model = scriptedModel([toolStep('echo', { text: 'again' })]);
  const harness = makeHarness(model);
  const agent = makeAgent({ budgets: { maxRounds: 3, maxTokens: 200_000 } });

  const events = await collect(runAgent(harness.deps, { agent, userText: 'loop' }));

  const finish = eventsOf(events, 'run-finish')[0]!;
  assert.equal(finish.reason, 'max_rounds');
  assert.equal(finish.rounds, 3);
  assert.equal(model.doStreamCalls.length, 3);
  assert.equal(harness.executed.length, 3);
  assert.equal(runRow(harness.db).status, 'max_rounds');
});

test('max_tokens budget stops the run once cumulative tokens reach the cap', async () => {
  const model = scriptedModel([toolStep('echo', { text: 'x' }, 'call-1', { input: 50, output: 10 })]);
  const harness = makeHarness(model);
  const agent = makeAgent({ budgets: { maxRounds: 12, maxTokens: 100 } });

  const events = await collect(runAgent(harness.deps, { agent, userText: 'spend' }));

  const finish = eventsOf(events, 'run-finish')[0]!;
  assert.equal(finish.reason, 'max_tokens');
  assert.equal(finish.rounds, 2);
  assert.equal(finish.usage.inputTokens + finish.usage.outputTokens, 120);
});

test('ask-level tool runs only after the user approves', async () => {
  const model = scriptedModel([toolStep('danger', { target: 'a.txt' }), textStep('ok')]);
  const harness = makeHarness(model, { approve: true });

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'do it' }));

  assert.equal(harness.broker.requests.length, 1);
  assert.equal(harness.broker.requests[0]!.summary, 'Change a.txt');
  assert.deepEqual(eventsOf(events, 'permission-decision')[0]!.decision, { allow: true, via: 'user' });
  assert.deepEqual(harness.executed, [{ tool: 'danger', input: { target: 'a.txt' } }]);
});

test('denied tool is not run; the model is told and can still answer', async () => {
  const model = scriptedModel([toolStep('danger', { target: 'a.txt' }), textStep('understood')]);
  const harness = makeHarness(model, { approve: false });

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'do it' }));

  assert.deepEqual(harness.executed, []);
  const result = eventsOf(events, 'tool-result')[0]!.result;
  assert.equal(result.ok, false);
  assert.match(result.output, /denied/);
  assert.match(promptOf(model, 1), /denied this tool call/);
  assert.equal(eventsOf(events, 'run-finish')[0]!.reason, 'stop');
});

test('permission timeout counts as a denial', async () => {
  const model = scriptedModel([toolStep('danger', { target: 'a.txt' }), textStep('timed out')]);
  const harness = makeHarness(model, { approve: 'never', permissionTimeoutMs: 20 });

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'do it' }));

  assert.deepEqual(harness.executed, []);
  assert.deepEqual(eventsOf(events, 'permission-decision')[0]!.decision, {
    allow: false,
    reason: 'timeout',
  });
});

test('a tool the agent does not have is rejected without running anything', async () => {
  const model = scriptedModel([toolStep('danger', { target: 'a.txt' }), textStep('sorry')]);
  const harness = makeHarness(model);
  const agent = makeAgent({ tools: ['echo'] });

  const events = await collect(runAgent(harness.deps, { agent, userText: 'do it' }));

  assert.deepEqual(harness.executed, []);
  assert.equal(harness.broker.requests.length, 0);
  assertRejectedOnce(events, model);
});

test('invalid tool input is reported back instead of executed', async () => {
  const model = scriptedModel([toolStep('echo', { text: 42 }), textStep('fixed')]);
  const harness = makeHarness(model);

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'echo' }));

  assert.deepEqual(harness.executed, []);
  assertRejectedOnce(events, model);
});

test('single continuous thread: the next run sees earlier turns and the current time', async () => {
  const model = scriptedModel([textStep('first answer'), textStep('second answer')]);
  const harness = makeHarness(model);
  const agent = makeAgent();

  await collect(runAgent(harness.deps, { agent, userText: 'first question' }));
  await collect(runAgent(harness.deps, { agent, userText: 'second question' }));

  const prompt = promptOf(model, 1);
  assert.match(prompt, /first question/);
  assert.match(prompt, /first answer/);
  assert.match(prompt, /second question/);
  assert.match(prompt, /Current time: Monday, 12 October 2026/);
  // Volatile context is appended at send time only, never stored.
  const stored = harness.db.prepare('SELECT text FROM messages ORDER BY id').all() as { text: string }[];
  assert.ok(stored.every((row) => !row.text.includes('Current time')));
});

test('provider failure ends the run with an error instead of throwing', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('upstream exploded');
    },
  });
  const harness = makeHarness(model);

  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'hi' }));

  const finish = eventsOf(events, 'run-finish')[0]!;
  assert.equal(finish.reason, 'error');
  assert.match(finish.error ?? '', /upstream exploded/);
  assert.equal(runRow(harness.db).status, 'error');
});

test('an empty answer gets one more go; a second empty one ends the run', async () => {
  const model = scriptedModel([textStep(''), textStep('ตอบแล้วค่ะ')]);
  const harness = makeHarness(model);
  const events = await collect(runAgent(harness.deps, { agent: makeAgent(), userText: 'hi' }));
  const finish = eventsOf(events, 'run-finish')[0]!;
  assert.deepEqual([finish.reason, finish.rounds, finish.text], ['stop', 2, 'ตอบแล้วค่ะ']);
  assert.match(promptOf(model, 1), /came out empty/);
  assert.ok(!storedRoles(harness.db).includes('system'));

  const silent = scriptedModel([textStep('')]);
  const quiet = await collect(runAgent(makeHarness(silent).deps, { agent: makeAgent(), userText: 'hi' }));
  assert.deepEqual([eventsOf(quiet, 'run-finish')[0]!.rounds, silent.doStreamCalls.length], [2, 2]);
});
