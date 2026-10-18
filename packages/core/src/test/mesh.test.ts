import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent } from '@mimi/shared';
import { TraceBudget } from '../mesh/budget.ts';
import { flatten, hangingModel, makeTestCore, reactiveModel, type TestCore } from './core-helpers.ts';
import { collect, eventsOf, scriptedModel, textStep, toolStep } from './helpers.ts';

interface MeshRow {
  id: number;
  from_agent: string;
  to_agent: string;
  mode: string;
  status: string;
  hop_count: number;
  reply_to: number | null;
  result: string | null;
}

const rows = (target: TestCore) =>
  target.core.db.prepare(`SELECT id, from_agent, to_agent, mode, status, hop_count, reply_to, result FROM agent_messages ORDER BY id`).all() as MeshRow[];
const threadsOf = (target: TestCore, agent: string) =>
  (target.core.db.prepare(`SELECT DISTINCT thread FROM messages WHERE agent = ? ORDER BY thread`).all(agent) as { thread: string }[]).map((row) => row.thread);

async function turn(target: TestCore, agent: string, text: string): Promise<AgentEvent[]> {
  return collect(target.core.runTurn({ agent: target.core.agents.get(agent), userText: text }));
}

/** Tool results of a turn, at any nesting depth. */
const toolResults = (events: AgentEvent[]) =>
  flatten(events).flatMap(({ event }) => (event.type === 'tool-result' ? [event.result] : []));

test('delegate: the receiver runs in its own thread and its answer comes back as the tool result', async () => {
  const mimi = scriptedModel([
    toolStep('send_to', { agent: 'tim', task: 'Plan a weekend in Chiang Mai', context: 'Budget 5000 THB', expected_result: 'A two-day plan' }),
    textStep('Tim planned it.'),
  ]);
  const tim = scriptedModel([textStep('DAY 1: temples. DAY 2: mountains.')]);
  const target = await makeTestCore({ models: { mimi, tim } });

  const events = await turn(target, 'mimi', 'plan my weekend');

  const result = eventsOf(events, 'tool-result')[0]!.result;
  assert.equal(result.ok, true);
  assert.equal(result.output, 'Reply from tim (message #1):\nDAY 1: temples. DAY 2: mountains.');
  assert.deepEqual(rows(target), [
    { id: 1, from_agent: 'mimi', to_agent: 'tim', mode: 'delegate', status: 'replied', hop_count: 1, reply_to: null, result: 'DAY 1: temples. DAY 2: mountains.' },
  ]);

  // Tim was woken with the message itself, not with Mimi's conversation.
  const timPrompt = JSON.stringify(tim.doStreamCalls[0]!.prompt);
  assert.match(timPrompt, /<agent_message id=\\"1\\" from=\\"mimi\\" mode=\\"delegate\\">/);
  assert.match(timPrompt, /Budget 5000 THB/);
  assert.match(timPrompt, /A two-day plan/);
  assert.doesNotMatch(timPrompt, /plan my weekend/);
  assert.deepEqual(threadsOf(target, 'tim'), ['mesh:1']);
  assert.deepEqual(threadsOf(target, 'mimi'), ['main']);

  // The user can watch the sub-agent work.
  const activity = eventsOf(events, 'agent-activity');
  assert.ok(activity.length > 0 && activity.every((event) => event.agent === 'tim' && event.messageId === 1));
  assert.equal(eventsOf(events, 'run-finish')[0]!.text, 'Tim planned it.');
  await target.cleanup();
});

test('delegate: an explicit reply() wins over the final text', async () => {
  const mimi = scriptedModel([toolStep('send_to', { agent: 'tim', task: 'x' }), textStep('done')]);
  const tim = scriptedModel([toolStep('reply', { message_id: 1, result: 'EXPLICIT RESULT' }), textStep('chatter')]);
  const target = await makeTestCore({ models: { mimi, tim } });

  const events = await turn(target, 'mimi', 'go');

  assert.equal(eventsOf(events, 'tool-result')[0]!.result.output, 'Reply from tim (message #1):\nEXPLICIT RESULT');
  assert.equal(rows(target)[0]!.result, 'EXPLICIT RESULT');
  await target.cleanup();
});

test('mesh, not tree: B messages A back, and A -> C -> B chains work', async () => {
  // mimi -> tim -> mimi (woken a second time, in another thread) -> back up.
  const mimi = reactiveModel((prompt) => {
    if (prompt.includes('from=\\"tim\\"')) return textStep('MIMI-HELPED-TIM');
    if (prompt.includes('Reply from tim')) return textStep('all done');
    return toolStep('send_to', { agent: 'tim', task: 'need your help' });
  });
  const tim = reactiveModel((prompt) =>
    prompt.includes('Reply from mimi')
      ? textStep('TIM-FINISHED')
      : toolStep('send_to', { agent: 'mimi', task: 'one question back' }),
  );
  const back = await makeTestCore({ models: { mimi, tim } });
  await turn(back, 'mimi', 'start');
  assert.deepEqual(
    rows(back).map((row) => [row.from_agent, row.to_agent, row.hop_count, row.reply_to, row.status, row.result]),
    [
      ['mimi', 'tim', 1, null, 'replied', 'TIM-FINISHED'],
      ['tim', 'mimi', 2, 1, 'replied', 'MIMI-HELPED-TIM'],
    ],
  );
  assert.deepEqual(threadsOf(back, 'mimi'), ['main', 'mesh:2']);
  await back.cleanup();

  // mimi -> scout -> tim
  const chain = await makeTestCore({
    models: {
      mimi: reactiveModel((prompt) => (prompt.includes('Reply from scout') ? textStep('end') : toolStep('send_to', { agent: 'scout', task: 'scout it' }))),
      scout: reactiveModel((prompt) => (prompt.includes('Reply from tim') ? textStep('SCOUT+TIM') : toolStep('send_to', { agent: 'tim', task: 'verify' }))),
      tim: scriptedModel([textStep('VERIFIED')]),
    },
  });
  await turn(chain, 'mimi', 'start');
  assert.deepEqual(
    rows(chain).map((row) => [row.from_agent, row.to_agent, row.hop_count, row.result]),
    [['mimi', 'scout', 1, 'SCOUT+TIM'], ['scout', 'tim', 2, 'VERIFIED']],
  );
  await chain.cleanup();
});

test('can_message is enforced, and agents without peers get no send_to at all', async () => {
  const scout = scriptedModel([toolStep('send_to', { agent: 'mimi', task: 'psst' }), textStep('fine')]);
  const target = await makeTestCore({ models: { scout } });

  const events = await turn(target, 'scout', 'try it');
  const result = eventsOf(events, 'tool-result')[0]!.result;
  assert.equal(result.ok, false);
  assert.match(result.output, /scout is not allowed to message "mimi". Allowed: tim/);
  assert.equal(rows(target).length, 0);

  const tools = (agent: string, mesh?: Parameters<typeof target.core.mesh.toolsFor>[1]) =>
    target.core.mesh.toolsFor(target.core.agents.get(agent), mesh).map((tool) => tool.name);
  assert.deepEqual(tools('mimi'), ['send_to']);
  assert.deepEqual(tools('tim', { messageId: 1, from: 'mimi', mode: 'delegate', hop: 1 }), ['send_to', 'reply']);
  assert.deepEqual(target.core.mesh.toolsFor({ ...target.core.agents.get('scout'), canMessage: [] }, undefined), []);
  await target.cleanup();
});

test('hop limit: a ping-pong between two agents is cut off at max_hops', async () => {
  const pingPong = (other: string) =>
    reactiveModel((prompt) =>
      /Hop limit reached|Reply from/.test(prompt.slice(-600))
        ? textStep('stopping here')
        : toolStep('send_to', { agent: other, task: 'your turn' }),
    );
  const target = await makeTestCore({
    models: { mimi: pingPong('tim'), tim: pingPong('mimi') },
    settings: { mesh: { max_hops: 3 } },
  });

  const events = await turn(target, 'mimi', 'start');

  assert.deepEqual(rows(target).map((row) => row.hop_count), [1, 2, 3]);
  assert.ok(rows(target).every((row) => row.status === 'replied'));
  const refused = toolResults(events).filter((result) => /Hop limit reached/.test(result.output));
  assert.equal(refused.length, 1, 'the fourth message is refused');
  assert.equal(eventsOf(events, 'run-finish')[0]!.reason, 'stop');
  await target.cleanup();
});

test('deadlock timeout: a receiver that never answers does not block the sender forever', async () => {
  const mimi = scriptedModel([toolStep('send_to', { agent: 'tim', task: 'hello?' }), textStep('Tim is unavailable.')]);
  const target = await makeTestCore({
    models: { mimi, tim: hangingModel() },
    settings: { mesh: { reply_timeout_ms: 80 } },
  });

  const started = Date.now();
  const events = await turn(target, 'mimi', 'ask tim');

  assert.ok(Date.now() - started < 5000);
  const result = eventsOf(events, 'tool-result')[0]!.result;
  assert.equal(result.ok, false);
  assert.match(result.output, /tim did not reply within .*message #1/);
  assert.equal(rows(target)[0]!.status, 'timeout');
  assert.equal(eventsOf(events, 'run-finish')[0]!.text, 'Tim is unavailable.');
  await target.cleanup();
});

test('trace budget: total model calls across all agents of a turn are capped', async () => {
  const forever = (other: string) => reactiveModel(() => toolStep('send_to', { agent: other, task: 'again' }));
  const target = await makeTestCore({
    models: { mimi: forever('tim'), tim: forever('mimi') },
    settings: { mesh: { max_hops: 50, max_trace_rounds: 5 } },
  });

  const events = await turn(target, 'mimi', 'start');

  const calls = target.core.db.prepare(`SELECT COUNT(*) AS n FROM usage_log WHERE capability = 'chat'`).get() as { n: number };
  assert.equal(calls.n, 5, 'exactly the budgeted number of model calls happened');
  const finishes = flatten(events).flatMap(({ event }) => (event.type === 'run-finish' ? [event.reason] : []));
  assert.ok(finishes.includes('trace_budget'));
  await target.cleanup();
});

test('trace budget object: tokens, rounds and time each stop the trace', () => {
  let clock = 0;
  const make = () => new TraceBudget({ maxTokens: 100, maxRounds: 3, maxMs: 1000 }, () => clock);

  const tokens = make();
  tokens.charge(99);
  assert.equal(tokens.exhausted(), null);
  tokens.charge(1);
  assert.match(tokens.exhausted()!, /token budget/);

  const rounds = make();
  for (let call = 0; call < 3; call++) rounds.charge(1);
  assert.match(rounds.exhausted()!, /round budget/);

  const time = make();
  clock = 999;
  assert.equal(time.exhausted(), null);
  clock = 1000;
  assert.match(time.exhausted()!, /time budget/);
});

test('handoff: the sender stops, the receiver answers the user, and the thread stays continuous', async () => {
  const mimi = scriptedModel([
    toolStep('send_to', { agent: 'tim', task: 'Answer the master about the tax deadline', context: 'He asked when to file', mode: 'handoff' }),
    textStep('SHOULD NOT BE SPOKEN'),
    textStep('next turn answer'),
  ]);
  const tim = scriptedModel([textStep('The deadline is 31 March.')]);
  const target = await makeTestCore({ models: { mimi, tim } });

  const events = await turn(target, 'mimi', 'when do I file taxes?');

  const finishes = eventsOf(events, 'run-finish');
  assert.deepEqual(finishes.map((event) => event.reason), ['handoff', 'stop']);
  assert.deepEqual(finishes[0]!.handoff, { messageId: 1, to: 'tim' });
  assert.equal(mimi.doStreamCalls.length, 1, 'the sender is not called again after handing off');
  // Tim's text reaches the user as a normal top-level stream, not as sub-agent activity.
  assert.deepEqual(eventsOf(events, 'run-start').map((event) => event.agent), ['mimi', 'tim']);
  assert.equal(eventsOf(events, 'text-delta').map((event) => event.text).join(''), 'The deadline is 31 March.');
  assert.equal(eventsOf(events, 'agent-activity').length, 0);

  // Handoffs carry a summary, not the history.
  const timPrompt = JSON.stringify(tim.doStreamCalls[0]!.prompt);
  assert.match(timPrompt, /mode=\\"handoff\\"/);
  assert.match(timPrompt, /He asked when to file/);
  assert.doesNotMatch(timPrompt, /when do I file taxes\?/);

  assert.equal(rows(target)[0]!.status, 'replied');
  const main = target.core.history();
  assert.deepEqual(main.map((message) => [message.role, message.agent, message.text]), [
    ['user', 'mimi', 'when do I file taxes?'],
    ['assistant', 'tim', 'The deadline is 31 March.'],
  ]);

  // Next turn: Mimi sees what Tim told the user.
  await turn(target, 'mimi', 'thanks');
  assert.match(JSON.stringify(mimi.doStreamCalls[1]!.prompt), /The deadline is 31 March\./);
  await target.cleanup();
});

test('handoff is only for the agent answering the user: a delegated agent must reply instead', async () => {
  const mimi = scriptedModel([toolStep('send_to', { agent: 'tim', task: 'do it' }), textStep('ok')]);
  const tim = scriptedModel([toolStep('send_to', { agent: 'scout', task: 'take over', mode: 'handoff' }), textStep('did it myself')]);
  const target = await makeTestCore({ models: { mimi, tim } });

  const events = await turn(target, 'mimi', 'go');

  const refused = toolResults(events).find((result) => /Only the agent that is answering the user can hand off/.test(result.output));
  assert.ok(refused);
  assert.deepEqual(rows(target).map((row) => [row.to_agent, row.mode]), [['tim', 'delegate']]);
  assert.equal(eventsOf(events, 'run-finish').length, 1);
  await target.cleanup();
});

test('persona and skill index are injected by the core; sub-agents ask the same user for permission', async () => {
  const mimi = scriptedModel([toolStep('load_skill', { name: 'night-quiz' }), toolStep('send_to', { agent: 'tim', task: 'read notes.txt' }), textStep('ok')]);
  const tim = scriptedModel([toolStep('read_file', { path: 'missing.txt' }), textStep('no such file')]);
  const target = await makeTestCore({ models: { mimi, tim } });

  const events = await turn(target, 'mimi', 'quiz me');

  const mimiSystem = JSON.stringify(mimi.doStreamCalls[0]!.prompt.filter((part) => part.role === 'system'));
  assert.match(mimiSystem, /PERSONA: the household speaks Thai\./);
  assert.match(mimiSystem, /- night-quiz: Bedtime quiz game/);
  assert.doesNotMatch(mimiSystem, /QUIZ RULES/, 'only name and description are always loaded');
  const timSystem = JSON.stringify(tim.doStreamCalls[0]!.prompt.filter((part) => part.role === 'system'));
  assert.match(timSystem, /PERSONA/);
  assert.doesNotMatch(timSystem, /night-quiz/, 'no skill index without the load_skill tool');

  assert.equal(eventsOf(events, 'tool-result')[0]!.result.output, 'QUIZ RULES: ask five questions.');
  const nested = flatten(events).filter(({ agent }) => agent === 'tim');
  assert.ok(nested.some(({ event }) => event.type === 'tool-call' && event.call.name === 'read_file'));
  await target.cleanup();
});
