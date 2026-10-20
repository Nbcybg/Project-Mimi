import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredMessage } from '@mimi/shared';
import type { MockLanguageModelV4 } from 'ai/test';
import { runAgent } from '../loop/agent-loop.ts';
import { estimateMessageTokens } from '../loop/tokens.ts';
import { Compactor, planCompaction, splitBatches } from '../memory/compactor.ts';
import { PostTurnJobs } from '../memory/post-turn.ts';
import { renderTranscript } from '../memory/transcript.ts';
import { MemoryWriter } from '../memory/writer.ts';
import type { Settings } from '../providers/settings.ts';
import {
  collect,
  generatePromptOf,
  type Harness,
  type HarnessOptions,
  makeAgent,
  makeHarness,
  type Reply,
  replyingModel,
  scriptedModel,
  textStep,
} from './helpers.ts';

const agent = makeAgent({ tools: [] });
const SETTINGS: Settings['compaction'] = { auto: true, threshold: 0.65, keep_recent: 0.25, summary_budget: 0.15 };

interface Setup extends Harness {
  compactor: Compactor;
  summarizer: MockLanguageModelV4;
  /** Appends a user+assistant turn whose two messages are ~100 tokens each. */
  addTurn(label: string): void;
  state(): { epoch: number; summarized_through: number; memory_snapshot: string };
  summaries(): Array<{ id: number; from_message_id: number; to_message_id: number; content: string; source: string; superseded_by: number | null }>;
}

function setup(
  replies: Array<Reply | ((prompt: string) => Reply)> = [{ text: 'SUMMARY' }],
  options: HarnessOptions & { settings?: Partial<Settings['compaction']> } = {},
): Setup {
  const summarizer = replyingModel(replies);
  const chat = scriptedModel([textStep('ok')]);
  const harness = makeHarness(chat, { contextLimit: 3000, ...options, small: summarizer });
  const { deps, db } = harness;
  const compactor = new Compactor({
    messages: deps.messages,
    threads: deps.threads,
    memory: deps.memory,
    models: deps.models,
    usage: deps.usage,
    settings: { ...SETTINGS, ...options.settings },
    workingDir: undefined,
  });
  const filler = (label: string) => `${label} `.padEnd(300, 'x');
  return {
    ...harness,
    compactor,
    summarizer,
    addTurn(label) {
      for (const role of ['user', 'assistant'] as const) {
        const text = filler(`${label}-${role}`);
        deps.messages.append({ thread: 'main', traceId: label, agent: 'mimi', role, content: text, text });
      }
    },
    state: () => db.prepare(`SELECT epoch, summarized_through, memory_snapshot FROM thread_state`).get() as ReturnType<Setup['state']>,
    summaries: () => db.prepare(`SELECT id, from_message_id, to_message_id, content, source, superseded_by FROM summaries ORDER BY id`).all() as ReturnType<Setup['summaries']>,
  };
}

/** Appends user+assistant turns of ~100 tokens per message. */
function seedTurns(deps: Harness['deps'], count: number): void {
  for (let turn = 1; turn <= count; turn++) {
    for (const role of ['user', 'assistant'] as const) {
      const text = ('seed' + turn + '-' + role + ' ').padEnd(300, 'x');
      deps.messages.append({ thread: 'main', traceId: 'seed' + turn, agent: 'mimi', role, content: text, text });
    }
  }
}

function addTurns(target: Setup, count: number, prefix = 'turn'): void {
  for (let index = 1; index <= count; index++) target.addTurn(`${prefix}${index}`);
}

const message = (id: number, role: StoredMessage['role'], content: unknown = 'x'.repeat(300)): StoredMessage => ({
  id,
  thread: 'main',
  traceId: 't',
  agent: 'mimi',
  role,
  content,
  text: typeof content === 'string' ? content : '',
  createdAt: '2026-10-12T05:00:00.000Z',
});

/** user, assistant(tool call), tool, assistant -- repeated; each message ~104 tokens. */
function toolTurns(turns: number): StoredMessage[] {
  const all: StoredMessage[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const base = turn * 4;
    all.push(message(base + 1, 'user'), message(base + 2, 'assistant'), message(base + 3, 'tool'), message(base + 4, 'assistant'));
  }
  return all;
}

test('plan: cuts only at the start of a user turn, whatever the budget', () => {
  const messages = toolTurns(6);
  const perTurn = messages.slice(0, 4).reduce((total, item) => total + estimateMessageTokens(item), 0);

  for (let keepTokens = 0; keepTokens <= perTurn * 7; keepTokens += 37) {
    const plan = planCompaction(messages, keepTokens);
    assert.equal(plan.summarize.length + plan.keep.length, messages.length);
    assert.equal(plan.summarize.length % 4, 0, `tool exchange torn apart at keep=${keepTokens}`);
    assert.equal(plan.keep[0]!.role, 'user');
    assert.ok(plan.keep.length >= 4, 'the newest turn always stays raw');
  }
});

test('plan: keeps as many recent turns as fit the budget', () => {
  const messages = toolTurns(6);
  const perTurn = messages.slice(0, 4).reduce((total, item) => total + estimateMessageTokens(item), 0);

  assert.equal(planCompaction(messages, perTurn * 2).keep.length, 8);
  assert.equal(planCompaction(messages, perTurn * 2 + perTurn - 1).keep.length, 8, 'a turn that does not fully fit is summarized');
  assert.equal(planCompaction(messages, perTurn * 6).summarize.length, 0, 'everything fits: nothing to do');
  assert.equal(planCompaction(messages, 0).keep.length, 4, 'budget too small: only the newest turn stays');
  assert.equal(planCompaction(toolTurns(1), 0).summarize.length, 0, 'a single turn is never summarized');
  assert.deepEqual(planCompaction([], 100), { summarize: [], keep: [] });
});

test('batches: consecutive, in order, each within the summarizer capacity', () => {
  const messages = toolTurns(5);
  const batches = splitBatches(messages, 250);
  assert.deepEqual(batches.flat().map((item) => item.id), messages.map((item) => item.id));
  assert.ok(batches.length > 1);
  assert.deepEqual(splitBatches(messages, 1_000_000).length, 1);
  assert.equal(splitBatches([message(1, 'user', 'y'.repeat(9000))], 100).length, 1, 'an oversized message still goes out alone');
});

test('transcript: ids, speakers, clipped tool output, images as text placeholders', () => {
  const transcript = renderTranscript([
    message(7, 'user', [
      { type: 'text', text: 'look at this' },
      { type: 'image', image: 'BASE64DATA', description: 'receipt from 7-Eleven, 245 THB' },
      { type: 'image', image: 'BASE64DATA' },
    ]),
    message(8, 'assistant', [
      { type: 'reasoning', text: 'hidden' },
      { type: 'tool-call', toolCallId: 'c', toolName: 'read_file', input: { path: 'a.txt' } },
    ]),
    message(9, 'tool', [
      { type: 'tool-result', toolCallId: 'c', toolName: 'read_file', output: { type: 'text', value: 'z'.repeat(5000) } },
    ]),
  ]);

  assert.match(transcript, /#7 \[2026-10-12T05:00Z user\]\nlook at this\n\[image: receipt from 7-Eleven, 245 THB\]\n\[image, not described\]/);
  assert.match(transcript, /#8 \[2026-10-12T05:00Z assistant mimi\]\n-> called read_file \{"path":"a.txt"\}/);
  assert.match(transcript, /#9 .*tool\]\nread_file returned: z+\.\.\. \[4200 more chars\]/);
  assert.doesNotMatch(transcript, /BASE64DATA|hidden/);
});

test('below the threshold nothing happens and the summarizer is not called', async () => {
  const target = setup();
  addTurns(target, 3);
  assert.equal(await target.compactor.maybeCompact('main', agent), null);
  assert.equal(target.summarizer.doGenerateCalls.length, 0);
  assert.equal(target.summaries().length, 0);
});

test('at the threshold the oldest turns are summarized in one batch from raw messages', async () => {
  const target = setup([{ text: '## Garden\n- planted chili (#1-#18)' }]);
  addTurns(target, 12); // 24 messages, ~2500 tokens against a 3000-token window
  target.deps.memory.write({ path: 'profile', content: '- Name: Ton' });

  const result = await target.compactor.maybeCompact('main', agent);

  // keep_recent = 25% of 3000 = 750 tokens = the newest 3 turns (6 messages).
  assert.deepEqual(result, { summarized: { fromId: 1, toId: 18, messages: 18 }, merged: 0 });
  assert.equal(target.summarizer.doGenerateCalls.length, 1, 'one large batch, not one call per turn');
  const prompt = generatePromptOf(target.summarizer, 0);
  assert.match(prompt, /#1 \[/);
  assert.match(prompt, /turn9-assistant/);
  assert.doesNotMatch(prompt, /turn10-user/);

  assert.deepEqual(target.summaries(), [
    { id: 1, from_message_id: 1, to_message_id: 18, content: '## Garden\n- planted chili (#1-#18)', source: 'raw', superseded_by: null },
  ]);
  const state = target.state();
  assert.deepEqual({ epoch: state.epoch, through: state.summarized_through }, { epoch: 1, through: 18 });
  assert.match(state.memory_snapshot, /Name: Ton/, 'memory edits become visible at compaction');
  assert.deepEqual(target.db.prepare('SELECT COUNT(*) AS n FROM messages').get(), { n: 24 }, 'raw messages are never deleted');
  assert.deepEqual(target.db.prepare(`SELECT capability FROM usage_log`).get(), { capability: 'summarize' });
});

test('after compaction the prompt holds the summary, then only the kept raw messages', async () => {
  const target = setup([{ text: 'SUMMARY-OF-OLD-TURNS' }]);
  addTurns(target, 12);
  await target.compactor.maybeCompact('main', agent);

  const chat = target.deps.models.languageModel({ provider: 'test', model: 'chat' }) as Promise<MockLanguageModelV4>;
  await collect(runAgent(target.deps, { agent, userText: 'what did we discuss?' }));
  const prompt = (await chat).doStreamCalls[0]!.prompt;
  const system = JSON.stringify(prompt.filter((part) => part.role === 'system'));
  const rest = JSON.stringify(prompt.filter((part) => part.role !== 'system'));

  assert.match(system, /<conversation_summary messages=\\"#1-#18\\">\\nSUMMARY-OF-OLD-TURNS/);
  assert.doesNotMatch(rest, /turn9-user/);
  assert.match(rest, /turn10-user/);
  assert.match(rest, /what did we discuss\?/);
  assert.ok(rest.indexOf('turn10-user') < rest.indexOf('turn12-assistant'));
});

test('the real prompt size from the provider triggers compaction even when the estimate is low', async () => {
  const target = setup();
  addTurns(target, 4);
  assert.equal(await target.compactor.maybeCompact('main', agent, 1949), null);
  const result = await target.compactor.maybeCompact('main', agent, 1950);
  // The estimate (~950) is about half the real size, so the keep budget is halved too.
  assert.equal(result!.summarized!.toId, 4, 'only the newest turns fit the rescaled budget');
});

test('context_cap bounds the window; auto=false disables automatic compaction only', async () => {
  const capped = setup([{ text: 'S' }], { contextLimit: 1_000_000, settings: { context_cap: 3000 } });
  addTurns(capped, 12);
  assert.ok(await capped.compactor.maybeCompact('main', agent));

  const manual = setup([{ text: 'S' }], { settings: { auto: false } });
  addTurns(manual, 12);
  assert.equal(await manual.compactor.maybeCompact('main', agent), null);
  const forced = await manual.compactor.compactNow('main', agent);
  assert.deepEqual(forced.summarized, { fromId: 1, toId: 22, messages: 22 }, 'manual compaction keeps only the newest turn');
});

test('manual compaction with nothing to summarize still refreshes the memory snapshot', async () => {
  const target = setup();
  target.addTurn('only');
  target.deps.threads.ensureState('main', () => target.deps.memory.renderSnapshot());
  target.deps.memory.write({ path: 'preferences', content: '- Short answers' });
  assert.doesNotMatch(target.state().memory_snapshot, /Short answers/);

  assert.deepEqual(await target.compactor.compactNow('main', agent), { summarized: null, merged: 0 });
  assert.match(target.state().memory_snapshot, /Short answers/);
  assert.equal(target.state().epoch, 1);
  assert.equal(target.summarizer.doGenerateCalls.length, 0);
});

test('a chunk larger than the summarizer window is split into consecutive summaries', async () => {
  const target = setup([{ text: 'PART' }], { smallContextLimit: 1200 }); // capacity: 600 transcript tokens
  addTurns(target, 12);
  await target.compactor.maybeCompact('main', agent);

  const rows = target.summaries();
  assert.ok(rows.length >= 3);
  assert.equal(rows[0]!.from_message_id, 1);
  assert.equal(rows.at(-1)!.to_message_id, 18);
  for (let index = 1; index < rows.length; index++) {
    assert.equal(rows[index]!.from_message_id, rows[index - 1]!.to_message_id + 1, 'ranges are contiguous');
  }
});

test('summaries over budget are merged, rewritten from the raw messages when those still fit', async () => {
  const long = 'S'.repeat(300); // ~100 tokens per summary; budget = 5% of 3000 = 150 tokens
  const target = setup([{ text: long }, { text: long }, { text: 'MERGED-FROM-RAW' }], { settings: { summary_budget: 0.05 } });
  addTurns(target, 12, 'early');
  await target.compactor.maybeCompact('main', agent);
  addTurns(target, 9, 'late');
  const second = await target.compactor.maybeCompact('main', agent);

  assert.equal(second!.merged, 2);
  const rows = target.summaries();
  assert.deepEqual(rows.map((row) => row.superseded_by), [3, 3, null]);
  assert.deepEqual(
    { from: rows[2]!.from_message_id, to: rows[2]!.to_message_id, content: rows[2]!.content, source: rows[2]!.source },
    { from: 1, to: rows[1]!.to_message_id, content: 'MERGED-FROM-RAW', source: 'raw' },
  );
  const mergePrompt = generatePromptOf(target.summarizer, 2);
  assert.match(mergePrompt, /early1-user/, 'the merge re-reads the raw messages');
  assert.doesNotMatch(mergePrompt, /conversation_summary/);
  assert.equal(target.deps.threads.activeSummaries('main').length, 1);
});

test('when the raw range no longer fits, summaries are merged from summaries and marked as such', async () => {
  const fromSummaries = (prompt: string): Reply =>
    prompt.includes('conversation_summary') ? { text: 'MERGED' } : { text: 'S'.repeat(300) };
  const target = setup([fromSummaries], { smallContextLimit: 1200, settings: { summary_budget: 0.05 } });
  addTurns(target, 12);
  await target.compactor.maybeCompact('main', agent);

  const rows = target.summaries();
  const merged = rows.filter((row) => row.source === 'summaries');
  assert.ok(merged.length >= 1);
  assert.ok(merged.every((row) => row.content === 'MERGED'));
  assert.ok(rows.filter((row) => row.superseded_by !== null).length >= 2);
  const active = target.deps.threads.activeSummaries('main');
  assert.equal(active[0]!.fromMessageId, 1);
  assert.equal(active.at(-1)!.toMessageId, 18, 'the active summaries still cover the whole range');
});

test('a failing summarizer leaves the thread exactly as it was', async () => {
  const target = setup([{ text: '   ' }]);
  addTurns(target, 12);
  target.deps.threads.ensureState('main', () => 'SNAPSHOT');

  await assert.rejects(target.compactor.maybeCompact('main', agent), /empty summary/);
  assert.deepEqual(target.state(), { epoch: 0, summarized_through: 0, memory_snapshot: 'SNAPSHOT' });
  assert.equal(target.summaries().length, 0);
});

test('compactions are serialized: a second concurrent request finds nothing left to do', async () => {
  const target = setup();
  addTurns(target, 12);
  const [first, second] = await Promise.all([
    target.compactor.maybeCompact('main', agent),
    target.compactor.maybeCompact('main', agent),
  ]);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(target.summarizer.doGenerateCalls.length, 1);
});

test('prompt prefix: byte-stable and append-only between compactions, new epoch after one', async () => {
  const chat = scriptedModel([textStep('a1'), textStep('a2'), textStep('a3')]);
  const summarizer = replyingModel([{ text: 'EPOCH-2-SUMMARY' }]);
  const harness = makeHarness(chat, { small: summarizer });
  const compactor = new Compactor({ ...harness.deps, settings: SETTINGS, workingDir: undefined });
  const promptOf = (index: number) => {
    const prompt = chat.doStreamCalls[index]!.prompt;
    return {
      system: JSON.stringify(prompt.filter((part) => part.role === 'system')),
      messages: prompt.filter((part) => part.role !== 'system').map((part) => JSON.stringify(part)),
    };
  };

  await collect(runAgent(harness.deps, { agent, userText: 'first' }));
  harness.deps.memory.write({ path: 'profile', content: '- Name: Ton' });
  await collect(runAgent(harness.deps, { agent, userText: 'second' }));

  const [one, two] = [promptOf(0), promptOf(1)];
  assert.equal(two.system, one.system, 'memory edits do not disturb the cached prefix');
  assert.deepEqual(two.messages.slice(0, one.messages.length), one.messages, 'earlier messages are replayed byte-identically');
  assert.ok(two.messages.length > one.messages.length);

  await compactor.compactNow('main', agent);
  await collect(runAgent(harness.deps, { agent, userText: 'third' }));
  const three = promptOf(2);
  assert.notEqual(three.system, two.system);
  assert.match(three.system, /Name: Ton/);
  assert.match(three.system, /EPOCH-2-SUMMARY/);
  assert.doesNotMatch(three.messages.join(), /"first"/);
});

test('post-turn jobs: writer then compaction, results surface as notices', async () => {
  const background = replyingModel([
    { toolCalls: [{ name: 'save_memory', input: { path: 'profile', content: '- Name: Ton' } }] },
    { text: 'SUMMARY' },
  ]);
  const harness = makeHarness(scriptedModel([textStep('ok')]), { contextLimit: 3000, small: background });
  const { deps } = harness;
  const compactor = new Compactor({ ...deps, settings: SETTINGS, workingDir: undefined });
  const writer = new MemoryWriter({ ...deps, profileMaxChars: 4000, timezone: 'Asia/Bangkok' });
  const jobs = new PostTurnJobs(writer, compactor, true);
  seedTurns(deps, 12);
  deps.messages.append({ thread: 'main', traceId: 'turn', agent: 'mimi', role: 'user', content: 'I am Ton', text: 'I am Ton' });
  deps.messages.append({ thread: 'main', traceId: 'turn', agent: 'mimi', role: 'assistant', content: 'Hi Ton', text: 'Hi Ton' });

  jobs.schedule({ thread: 'main', traceId: 'turn', agent, contextTokens: 2600, completed: true });
  await jobs.idle();

  assert.deepEqual(jobs.drainNotices(), ['memory: saved profile', 'compaction: summarized 18 messages (#1-#18)']);
  assert.deepEqual(jobs.drainNotices(), []);
  const snapshot = harness.db.prepare(`SELECT memory_snapshot FROM thread_state`).get() as { memory_snapshot: string };
  assert.match(snapshot.memory_snapshot, /Name: Ton/, 'the new snapshot already contains what the writer filed');
});

test('post-turn jobs: failures become notices; failed turns are not mined for memory', async () => {
  const broken = replyingModel([() => { throw new Error('small model down'); }]);
  const harness = makeHarness(scriptedModel([textStep('ok')]), { contextLimit: 3000, small: broken });
  const { deps } = harness;
  const compactor = new Compactor({ ...deps, settings: SETTINGS, workingDir: undefined });
  const writer = new MemoryWriter({ ...deps, profileMaxChars: 4000, timezone: 'Asia/Bangkok' });
  const jobs = new PostTurnJobs(writer, compactor, true);
  seedTurns(deps, 12);
  for (const role of ['user', 'assistant'] as const) {
    deps.messages.append({ thread: 'main', traceId: 'a', agent: 'mimi', role, content: 'hello', text: 'hello' });
  }

  jobs.schedule({ thread: 'main', traceId: 'a', agent, contextTokens: 2600, completed: true });
  await jobs.idle();
  const notices = jobs.drainNotices();
  assert.match(notices[0]!, /^memory writer failed: .*small model down/);
  assert.match(notices[1]!, /^compaction failed: .*small model down/);

  const calls = broken.doGenerateCalls.length;
  jobs.schedule({ thread: 'main', traceId: 'a', agent, contextTokens: 10, completed: false });
  await jobs.idle();
  assert.equal(broken.doGenerateCalls.length, calls, 'no writer call for a failed turn, no compaction below the threshold');

  const disabled = new PostTurnJobs(writer, compactor, false);
  disabled.schedule({ thread: 'main', traceId: 'a', agent, contextTokens: 10, completed: true });
  await disabled.idle();
  assert.equal(broken.doGenerateCalls.length, calls, 'memory.auto_write = false turns the writer off');
});
