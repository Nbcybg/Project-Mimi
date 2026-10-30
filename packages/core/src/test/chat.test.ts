import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent, StoredMessage } from '@mimi/shared';
import { stripAttachments } from '../chat/attachments.ts';
import { ChatStore } from '../chat/chat-store.ts';
import { type ChatTurnEvent, mentionedAgents } from '../chat/engine.ts';
import { MemoStore, StatusStore } from '../chat/state-store.ts';
import { openDb } from '../db/db.ts';
import { MessagesRepo } from '../db/messages-repo.ts';
import { runAgent } from '../loop/agent-loop.ts';
import { buildHistory, groupInstructions } from '../loop/prompt-builder.ts';
import { resolveModelName } from '../providers/routing.ts';
import { makeTestCore, reactiveModel, type TestCore } from './core-helpers.ts';
import { collect, makeAgent, makeHarness, replyingModel, scriptedModel, textStep, toolStep } from './helpers.ts';

async function turn(
  target: TestCore,
  input: { chatId: number; text: string; attachments?: string[]; replyTo?: number; forward?: { from: string; chat: string } },
) {
  const items: ChatTurnEvent[] = [];
  for await (const item of target.core.engine.runTurn(input)) items.push(item);
  const events = items.flatMap((item) => (item.type === 'agent-event' ? [item.event] : []));
  return {
    items,
    events,
    session: items.find((item) => item.type === 'session')!,
    userMessage: items.find((item) => item.type === 'user-message'),
    speakers: events.flatMap((event) => (event.type === 'run-start' ? [event.agent] : [])),
  };
}

const promptOf = (model: { doStreamCalls: Array<{ prompt: unknown }> }, call: number) =>
  JSON.stringify(model.doStreamCalls[call]!.prompt);

/** Replaces the frontmatter of a test agent (the catalog reads files on every call). */
function setAgent(target: TestCore, name: string, frontmatter: string, body = `You are ${name}.`) {
  fs.mkdirSync(path.join(target.root, 'user', 'agents', name), { recursive: true });
  fs.writeFileSync(path.join(target.root, 'user', 'agents', name, 'agent.md'), `---\nname: ${name}\n${frontmatter}\n---\n${body}`);
}

test('chat store: one-to-one and group chats; a session starts by itself after a long silence', () => {
  let now = new Date('2026-10-12T08:00:00Z');
  const db = openDb(':memory:');
  const chats = new ChatStore(db, () => now);
  const messages = new MessagesRepo(db);

  const direct = chats.directChat('mimi');
  assert.equal(chats.directChat('mimi').id, direct.id, 'one chat per agent');
  assert.throws(() => chats.createChat({ kind: 'group', agents: ['mimi'] }), /at least two/);
  assert.throws(() => chats.createChat({ kind: 'direct', agents: ['mimi', 'tim'] }), /exactly one/);
  const group = chats.createChat({ kind: 'group', agents: ['mimi', 'tim', 'mimi'], title: ' Team ' });
  assert.deepEqual([group.title, group.agents], ['Team', ['mimi', 'tim']]);

  const first = chats.currentSession(direct.id, 60_000);
  assert.equal(first.started, true);
  now = new Date('2026-10-12T12:00:00Z');
  assert.equal(chats.currentSession(direct.id, 60_000).session.id, first.session.id, 'an unused session is reused');

  messages.append({ thread: first.session.thread, traceId: 't', agent: 'mimi', role: 'user', content: 'hi', text: 'hi' });
  chats.touch(first.session.id);
  now = new Date('2026-10-12T12:00:30Z');
  assert.equal(chats.currentSession(direct.id, 60_000).started, false, 'within the gap: same session');
  now = new Date('2026-10-12T12:05:00Z');
  const next = chats.currentSession(direct.id, 60_000);
  assert.deepEqual([next.started, next.previous?.id], [true, first.session.id]);
  assert.equal(chats.previousSession(next.session)!.id, first.session.id);
  assert.deepEqual(chats.sessions(direct.id).map((session) => session.id), [next.session.id, first.session.id]);

  chats.currentSession(group.id, 60_000);
  assert.deepEqual(chats.sessionsFor('tim').map(({ chat }) => chat.id), [group.id]);
  assert.equal(chats.sessionsFor('mimi').length, 3);

  chats.renameAgent('mimi', 'secretary');
  assert.deepEqual(chats.getChat(group.id)!.agents, ['secretary', 'tim']);
  chats.forgetAgent('tim');
  assert.deepEqual(chats.listChats().map((chat) => chat.kind), ['direct'], 'a group left with one member is removed');
});

test('messages: rewinding hides rows from every read, and search can span sessions', () => {
  const db = openDb(':memory:');
  const repo = new MessagesRepo(db);
  const add = (thread: string, role: 'user' | 'assistant', text: string) =>
    repo.append({ thread, traceId: 't', agent: 'mimi', role, content: text, text });
  add('s-1', 'user', 'จองโรงแรมที่เชียงใหม่');
  add('s-1', 'assistant', 'จองแล้วค่ะ');
  const second = add('s-1', 'user', 'ยกเลิกโรงแรมที่เชียงใหม่');
  add('s-1', 'assistant', 'ยกเลิกแล้วค่ะ');
  add('s-2', 'user', 'เชียงใหม่อากาศเป็นไง');

  assert.deepEqual(repo.search(['s-1', 's-2'], 'เชียงใหม่').map((message) => message.thread), ['s-2', 's-1', 's-1']);
  assert.deepEqual(repo.search([], 'เชียงใหม่'), []);

  assert.equal(repo.hideFrom('s-1', second), 2);
  assert.deepEqual(repo.after('s-1', 0).map((message) => message.text), ['จองโรงแรมที่เชียงใหม่', 'จองแล้วค่ะ']);
  assert.equal(repo.page('s-1', undefined, 10).length, 2);
  assert.equal(repo.search('s-1', 'ยกเลิก').length, 0);
  assert.equal(repo.get(second), undefined);
  assert.equal(repo.hideFrom('s-1', second), 0, 'already hidden');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n, 5, 'nothing is deleted');
});

test('mentions: @name decides who speaks next', () => {
  const members = [
    makeAgent({ name: 'mimi', displayName: 'มีมี่' }),
    makeAgent({ name: 'tim' }),
    makeAgent({ name: 'timothy' }),
  ];
  assert.deepEqual(mentionedAgents('@tim ว่าไง แล้ว @มีมี่ล่ะ @TIM', members), ['tim', 'mimi']);
  assert.deepEqual(mentionedAgents('ถาม @timothy หน่อย', members), ['timothy']);
  assert.deepEqual(mentionedAgents('ส่งเมลไปที่ boss@tim.co แล้ว', members), [], 'an address is not a mention');
  assert.deepEqual(mentionedAgents('tim กับ mimi', members), []);
  assert.deepEqual(mentionedAgents('@ทุกคน มาประชุม', members), ['mimi', 'tim', 'timothy']);
});

test('group history: other agents speak on the user side by name; each sees only its own context', () => {
  const row = (id: number, role: StoredMessage['role'], agent: string, text: string, context?: string): StoredMessage => ({
    id,
    thread: 's-1',
    traceId: 't',
    agent,
    role,
    content: text,
    text,
    context,
    createdAt: '2026-10-12T05:00:00.000Z',
  });
  const rows = [
    row(1, 'user', 'mimi', 'ไปไหนดี', 'CTX-MIMI'),
    row(2, 'assistant', 'mimi', 'เชียงใหม่ @tim ว่าไง'),
    row(3, 'user', 'tim', '', 'CTX-TIM'),
    row(4, 'assistant', 'tim', 'ฝนตก @mimi'),
    row(5, 'user', 'mimi', '', 'CTX-MIMI-2'),
  ];
  const text = (value: string) => ({ type: 'text', text: value });

  assert.deepEqual(buildHistory(rows.slice(0, 3), 'tim', { group: true }), [
    { role: 'user', content: [text('ไปไหนดี'), text('[mimi]: เชียงใหม่ @tim ว่าไง'), text('CTX-TIM')] },
  ]);
  assert.deepEqual(buildHistory(rows, 'mimi', { group: true }), [
    { role: 'user', content: [text('ไปไหนดี'), text('CTX-MIMI')] },
    { role: 'assistant', content: 'เชียงใหม่ @tim ว่าไง' },
    { role: 'user', content: [text('[tim]: ฝนตก @mimi'), text('CTX-MIMI-2')] },
  ]);

  const rules = groupInstructions('tim', [
    { name: 'mimi', description: 'Secretary' },
    { name: 'tim', description: 'Butler' },
  ]);
  assert.match(rules, /You are "tim"/);
  assert.match(rules, /- mimi: Secretary/);
  assert.doesNotMatch(rules, /- tim: Butler/);
});

test('one-to-one chat: the turn lands in a session; the agent keeps its own status', async () => {
  const mimi = scriptedModel([toolStep('status_set', { key: 'mood', value: 'สดใส' }), textStep('สวัสดีค่ะ')]);
  const target = await makeTestCore({ models: { mimi } });
  setAgent(target, 'mimi', 'model: test/mimi\ntools: [status_set, memo_save, memo_get]');
  const changes: string[] = [];
  target.core.status.onChange = (agent, status) => changes.push(`${agent}:${status.mood}`);
  const chat = target.core.chats.directChat('mimi');

  const first = await turn(target, { chatId: chat.id, text: 'สวัสดี' });
  assert.equal(first.session.type === 'session' && first.session.started, true);
  assert.equal(first.userMessage?.type === 'user-message' && first.userMessage.text, 'สวัสดี');
  assert.deepEqual(first.speakers, ['mimi']);
  assert.deepEqual(changes, ['mimi:สดใส']);
  assert.deepEqual(target.core.status.get('mimi'), { mood: 'สดใส' });
  assert.match(promptOf(mimi, 0), /## Status/);
  assert.doesNotMatch(promptOf(mimi, 0), /Your current status/);

  const second = await turn(target, { chatId: chat.id, text: 'ทำอะไรอยู่' });
  assert.equal(second.session.type === 'session' && second.session.started, false, 'same session');
  assert.match(promptOf(mimi, 2), /Your current status:\\nmood: สดใส/, 'the snapshot rides at the bottom of the prompt');

  const [session] = target.core.chats.sessions(chat.id);
  assert.equal(session!.title, 'สวัสดี');
  assert.deepEqual(
    target.core.deps.messages.page(session!.thread, undefined, 10).map((message) => [message.role, message.text]),
    [['user', 'สวัสดี'], ['assistant', 'สวัสดีค่ะ'], ['user', 'ทำอะไรอยู่'], ['assistant', 'สวัสดีค่ะ']],
  );
  assert.equal(target.core.history().length, 0, 'nothing went to the legacy thread');
  await target.cleanup();
});

test('group chat is two-way: agents address each other with @name and answer back', async () => {
  const mimi = reactiveModel((_prompt, call) =>
    call === 0 ? textStep('ฉันว่าไปเชียงใหม่ @tim คิดว่าไง') : textStep('โอเค งั้นไปหัวหิน'),
  );
  const tim = scriptedModel([textStep('ไม่เห็นด้วย ช่วงนี้ฝนตก @mimi เปลี่ยนเป็นหัวหินไหม')]);
  const scout = scriptedModel([textStep('ผมว่าง')]);
  const target = await makeTestCore({ models: { mimi, tim, scout } });
  const chat = target.core.chats.createChat({ kind: 'group', agents: ['mimi', 'tim', 'scout'] });

  const result = await turn(target, { chatId: chat.id, text: 'ไปเที่ยวไหนดี' });
  assert.deepEqual(result.speakers, ['mimi', 'tim', 'mimi'], 'mimi asks tim, tim disagrees and asks back, mimi settles it');
  assert.equal(scout.doStreamCalls.length, 0, 'nobody addressed scout');

  const timPrompt = promptOf(tim, 0);
  assert.match(timPrompt, /## Group chat/);
  assert.match(timPrompt, /ไปเที่ยวไหนดี/);
  assert.match(timPrompt, /\[mimi\]: ฉันว่าไปเชียงใหม่ @tim คิดว่าไง/);
  assert.match(promptOf(mimi, 1), /\[tim\]: ไม่เห็นด้วย ช่วงนี้ฝนตก/);

  const [session] = target.core.chats.sessions(chat.id);
  assert.deepEqual(
    target.core.deps.messages.page(session!.thread, undefined, 10).map((message) => [message.role, message.agent]),
    [['user', 'mimi'], ['assistant', 'mimi'], ['assistant', 'tim'], ['assistant', 'mimi']],
    'one user message; the wake-up rows of the others stay out of sight',
  );

  // The user can address anyone directly; the first member only answers by default.
  const direct = await turn(target, { chatId: chat.id, text: '@scout ว่างไหม' });
  assert.deepEqual(direct.speakers, ['scout']);
  await target.cleanup();
});

test('group chat: agents that keep addressing each other are stopped at the turn limit', async () => {
  const mimi = scriptedModel([textStep('@tim ว่าไง')]);
  const tim = scriptedModel([textStep('@mimi ว่าไง')]);
  const target = await makeTestCore({ models: { mimi, tim }, settings: { mesh: { max_hops: 4 } } });
  const chat = target.core.chats.createChat({ kind: 'group', agents: ['mimi', 'tim'] });

  const result = await turn(target, { chatId: chat.id, text: 'เริ่ม' });
  assert.deepEqual(result.speakers, ['mimi', 'tim', 'mimi', 'tim']);
  await target.cleanup();
});

test('a new session is told what the previous one was about, and old sessions stay readable', async () => {
  const mimi = scriptedModel([textStep('ได้ค่ะ')]);
  const small = replyingModel([
    (prompt) =>
      prompt.includes('You file finished conversations')
        ? { text: 'TITLE: จองร้านอาหาร\nSUMMARY: ผู้ใช้ให้จองร้านซูชิวันศุกร์ 19:00 ยังไม่ได้ยืนยัน' }
        : { text: 'nothing' },
  ]);
  const target = await makeTestCore({ models: { mimi }, small, settings: { session: { idle_minutes: 0.00002 } } });
  setAgent(target, 'mimi', 'model: test/mimi\ntools: [list_sessions, read_session, search_history]');
  const chat = target.core.chats.directChat('mimi');

  const first = await turn(target, { chatId: chat.id, text: 'จองร้านซูชิวันศุกร์ให้หน่อย' });
  await target.core.jobs.idle();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await turn(target, { chatId: chat.id, text: 'เรื่องเมื่อกี้ถึงไหนแล้ว' });

  assert.ok(first.session.type === 'session' && second.session.type === 'session');
  assert.equal(second.session.started, true);
  assert.notEqual(second.session.session.id, first.session.session.id);
  const closed = target.core.chats.getSession(first.session.session.id)!;
  assert.deepEqual([closed.title, closed.summary], ['จองร้านอาหาร', 'ผู้ใช้ให้จองร้านซูชิวันศุกร์ 19:00 ยังไม่ได้ยืนยัน']);

  const prompt = promptOf(mimi, 1);
  assert.match(prompt, /This is a new session\. The previous one \(session 1,/);
  assert.match(prompt, /ยังไม่ได้ยืนยัน/);
  assert.doesNotMatch(prompt, /จองร้านซูชิวันศุกร์ให้หน่อย/, 'the old session itself is not replayed');

  // The agent can still reach into it.
  const context = { traceId: 't', thread: second.session.session.thread, agent: 'mimi', allowedDirs: [] };
  const tools = target.core.deps.tools;
  const listed = await tools.get('list_sessions')!.execute({}, context);
  assert.match(listed, /session 2 \(this session\)/);
  assert.match(listed, /session 1 · chat with mimi · .* · จองร้านอาหาร/);
  assert.match(await tools.get('read_session')!.execute({ session_id: 1 }, context), /user\nจองร้านซูชิวันศุกร์ให้หน่อย/);
  assert.match(await tools.get('search_history')!.execute({ query: 'ซูชิ' }, context), /No messages match/);
  assert.match(await tools.get('search_history')!.execute({ query: 'ซูชิ', all_sessions: true }, context), /จองร้านซูชิ/);
  await assert.rejects(tools.get('read_session')!.execute({ session_id: 1 }, { ...context, agent: 'tim' }), /No session 1/);
  await target.cleanup();
});

test('attachments are read once when they arrive: documents as text, images by the vision model', async () => {
  const mimi = scriptedModel([textStep('เห็นแล้วค่ะ')]);
  const small = replyingModel([
    (prompt) => (prompt.includes('Describe this image') ? { text: 'แมวสีส้มนอนบนโซฟา' } : { text: 'nothing' }),
  ]);
  const target = await makeTestCore({ models: { mimi }, small });
  const { attachments } = target.core;
  const note = attachments.save({ name: 'note.txt', mime: 'text/plain', data: Buffer.from('ซื้อนม 2 ขวด') });
  const cat = attachments.save({ name: '../cat.png', mime: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) });
  assert.deepEqual([note.kind, cat.kind, cat.name], ['file', 'image', 'cat.png']);
  assert.throws(() => attachments.save({ name: 'x', mime: 'text/plain', data: Buffer.alloc(0) }), /empty/);
  const chat = target.core.chats.directChat('mimi');

  const result = await turn(target, { chatId: chat.id, text: 'ดูนี่', attachments: [note.id, cat.id] });
  const prompt = promptOf(mimi, 0);
  assert.match(prompt, /kind=\\"file\\" name=\\"note.txt\\">\\nซื้อนม 2 ขวด\\n<\/attachment>/);
  assert.match(prompt, /kind=\\"image\\" name=\\"cat.png\\">\\nแมวสีส้มนอนบนโซฟา/);
  assert.ok(result.userMessage?.type === 'user-message');
  assert.deepEqual(result.items.filter((item) => item.type === 'viewing').map((item) => item.on), [true, false]);
  assert.equal(result.userMessage.text, 'ดูนี่');
  assert.deepEqual(result.userMessage.attachments.map((file) => file.name), ['note.txt', 'cat.png']);

  const linked = attachments.forMessages([result.userMessage.id]).get(result.userMessage.id)!;
  assert.deepEqual(linked.map((file) => file.text), ['ซื้อนม 2 ขวด', 'แมวสีส้มนอนบนโซฟา']);
  const [session] = target.core.chats.sessions(chat.id);
  const stored = target.core.deps.messages.page(session!.thread, undefined, 10)[0]!;
  assert.match(stored.text, /<attachment /);
  assert.equal(stripAttachments(stored.text), 'ดูนี่');
  const vision = JSON.stringify(small.doGenerateCalls.find((call) => JSON.stringify(call.prompt).includes('Describe this image'))!.prompt);
  assert.match(vision, /"mediaType":"image\/png"/);
  const kinds = target.core.db.prepare(`SELECT capability FROM usage_log WHERE capability = 'vision'`).all();
  assert.equal(kinds.length, 1, 'described once, and the call is on the cost report');

  // The stored text is reused; an unknown file stops the turn before anything is stored.
  await turn(target, { chatId: chat.id, text: 'อีกรอบ', attachments: [cat.id] });
  assert.equal(target.core.db.prepare(`SELECT 1 FROM usage_log WHERE capability = 'vision'`).all().length, 1);
  await assert.rejects(turn(target, { chatId: chat.id, text: 'x', attachments: ['nope'] }), /Unknown attachment/);
  await target.cleanup();
});

test('skills from the hub: one without a model hands over instructions, one with a model runs on it', async () => {
  const mimi = scriptedModel([
    toolStep('use_skill', { name: 'poem' }, 'c1'),
    toolStep('use_skill', { name: 'deep', input: 'วิเคราะห์ยอดขาย' }, 'c2'),
    toolStep('use_skill', { name: 'night-quiz' }, 'c3'),
    textStep('เสร็จแล้ว'),
  ]);
  const scout = scriptedModel([textStep('ยอดขายโต 12%')]);
  const target = await makeTestCore({ models: { mimi, scout } });
  const skill = (name: string, frontmatter: string, body: string) => {
    fs.mkdirSync(path.join(target.root, 'user', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(target.root, 'user', 'skills', `${name}.md`), `---\nname: ${name}\n${frontmatter}\n---\n${body}`);
  };
  skill('poem', 'description: Write poems', 'POEM RULES: three lines.');
  skill('deep', 'description: Careful analysis\nmodel: test/scout\ntools: [read_memory]', 'DEEP RULES: think step by step.');
  setAgent(target, 'mimi', 'model: test/mimi\nskills: [poem, deep]');
  const chat = target.core.chats.directChat('mimi');

  const { events } = await turn(target, { chatId: chat.id, text: 'ลองใช้ skill' });
  const results = events.flatMap((event) => (event.type === 'tool-result' ? [event.result] : []));
  assert.match(results[0]!.output, /Instructions of skill "poem" \(follow them now\):\n\nPOEM RULES: three lines\./);
  assert.deepEqual([results[1]!.ok, results[1]!.output], [true, 'ยอดขายโต 12%']);
  assert.deepEqual([results[2]!.ok, /No skill "night-quiz"\. Available: deep, poem/.test(results[2]!.output)], [false, true]);

  const worker = promptOf(scout, 0);
  assert.match(worker, /DEEP RULES: think step by step\./);
  assert.match(worker, /วิเคราะห์ยอดขาย/);
  assert.doesNotMatch(worker, /You are mimi/, "the skill's instructions replace the agent's");
  const activity = events.filter((event): event is Extract<AgentEvent, { type: 'agent-activity' }> => event.type === 'agent-activity');
  assert.ok(activity.some((event) => event.agent === 'mimi:deep' && event.event.type === 'run-finish'));

  const index = promptOf(mimi, 0);
  assert.match(index, /call use_skill\(name, input\) first/);
  assert.match(index, /- deep: Careful analysis\\n- poem: Write poems/);
  assert.doesNotMatch(index, /night-quiz/, 'only the skills given to this agent are listed');
  await target.cleanup();
});

test('model pool: a preset name resolves to its model and sampling settings, which reach the model call', async () => {
  const presets = { creative: { model: 'lab/chat-strong', temperature: 1.1, topP: 0.9, topK: 40 }, plain: { model: 'lab/chat' } };
  assert.deepEqual(resolveModelName('creative', presets), {
    provider: 'lab',
    model: 'chat-strong',
    params: { temperature: 1.1, topP: 0.9, topK: 40 },
  });
  assert.deepEqual(resolveModelName('plain', presets), { provider: 'lab', model: 'chat' });
  assert.deepEqual(resolveModelName('lab/x/y', presets), { provider: 'lab', model: 'x/y' });
  assert.throws(() => resolveModelName('missing', presets), /Unknown model preset "missing"/);

  const model = scriptedModel([textStep('ok')]);
  const harness = makeHarness(model);
  const models = {
    ...harness.deps.models,
    resolve: () => ({ provider: 'test', model: 'chat', params: { temperature: 0.3, topP: 0.8, topK: 20, maxOutputTokens: 512 } }),
  };
  await collect(runAgent({ ...harness.deps, models }, { agent: makeAgent({ tools: [] }), userText: 'hi' }));
  const call = model.doStreamCalls[0]!;
  assert.deepEqual([call.temperature, call.topP, call.topK, call.maxOutputTokens], [0.3, 0.8, 20, 512]);
});

test('status and memos belong to one agent each', () => {
  const db = openDb(':memory:');
  const status = new StatusStore(db);
  const memos = new MemoStore(db);
  status.set('mimi', 'location', '  ห้องทำงาน \n ชั้น 2 ');
  status.set('mimi', 'mood', 'ง่วง');
  status.set('tim', 'mood', 'เฉย ๆ');
  assert.deepEqual(status.get('mimi'), { location: 'ห้องทำงาน ชั้น 2', mood: 'ง่วง' });
  assert.equal(status.render('mimi'), 'Your current status:\nlocation: ห้องทำงาน ชั้น 2\nmood: ง่วง');
  status.set('mimi', 'mood', '');
  assert.deepEqual(status.get('mimi'), { location: 'ห้องทำงาน ชั้น 2' });
  assert.equal(status.render('nobody'), '');

  memos.save('mimi', 'wifi', 'รหัสอยู่หลังเราเตอร์');
  memos.save('mimi', 'wifi', 'เปลี่ยนรหัสแล้ว');
  assert.deepEqual(memos.list('mimi').map((memo) => [memo.key, memo.value]), [['wifi', 'เปลี่ยนรหัสแล้ว']]);
  assert.deepEqual(memos.list('tim'), []);
  status.rename('mimi', 'secretary');
  memos.rename('mimi', 'secretary');
  assert.deepEqual([status.get('secretary').location, memos.get('secretary', 'wifi')?.value], ['ห้องทำงาน ชั้น 2', 'เปลี่ยนรหัสแล้ว']);
  assert.equal(memos.delete('secretary', 'wifi'), true);
});

test('a reply quotes the answered message in the prompt and is recorded on the row', async () => {
  const mimi = scriptedModel([textStep('ได้ค่ะ'), textStep('เปลี่ยนเป็นวันเสาร์แล้วค่ะ')]);
  const target = await makeTestCore({ models: { mimi } });
  const chat = target.core.chats.directChat('mimi');
  const first = await turn(target, { chatId: chat.id, text: 'จองร้านอาหารวันศุกร์' });

  const second = await turn(target, { chatId: chat.id, text: 'เปลี่ยนเป็นวันเสาร์', replyTo: first.userMessage!.id });
  assert.equal(second.userMessage!.replyTo!.id, first.userMessage!.id);
  assert.equal(second.userMessage!.replyTo!.role, 'user');
  assert.equal(second.userMessage!.replyTo!.text, 'จองร้านอาหารวันศุกร์');
  const stored = target.core.deps.messages.get(second.userMessage!.id)!;
  assert.equal(stored.replyTo, first.userMessage!.id);

  const prompt = promptOf(mimi, 1);
  assert.match(prompt, /<reply_to id=\\"\d+\\" name=\\"the user\\">\\nจองร้านอาหารวันศุกร์/);
  assert.equal(stripAttachments(stored.text), 'เปลี่ยนเป็นวันเสาร์', 'the quote is hidden from display');
  await assert.rejects(turn(target, { chatId: chat.id, text: 'x', replyTo: 999_999 }), /does not exist/);
  await target.cleanup();
});

test('forwarding copies the files and marks where the message came from', async () => {
  const mimi = scriptedModel([textStep('ok')]);
  const target = await makeTestCore({ models: { mimi } });
  const chat = target.core.chats.directChat('mimi');
  const file = target.core.attachments.save({ name: 'note.txt', mime: 'text/plain', data: Buffer.from('hello file') });
  const first = await turn(target, { chatId: chat.id, text: 'ดูไฟล์นี้', attachments: [file.id] });
  assert.equal(target.core.attachments.get(file.id)!.messageId, first.userMessage!.id);

  const other = target.core.chats.createChat({ kind: 'group', agents: ['mimi', 'tim'], title: 'Team' });
  const forwarded = await turn(target, {
    chatId: other.id,
    text: 'ดูไฟล์นี้',
    attachments: [file.id],
    forward: { from: 'คุณ', chat: 'แชตกับมีมี่' },
  });
  assert.deepEqual(forwarded.userMessage!.forwardedFrom, { from: 'คุณ', chat: 'แชตกับมีมี่' });
  const stored = target.core.deps.messages.get(forwarded.userMessage!.id)!;
  assert.equal(stored.forwardFrom, 'คุณ');
  const copies = target.core.attachments.forMessages([forwarded.userMessage!.id]).get(forwarded.userMessage!.id)!;
  assert.equal(copies.length, 1);
  assert.notEqual(copies[0]!.id, file.id, 'the forward owns a copy of the file');
  assert.equal(target.core.attachments.get(file.id)!.messageId, first.userMessage!.id, 'the original keeps its file');
  await target.cleanup();
});

test('a session whose conversation outgrew max_tokens continues in a new one, with usage numbers for the old one', async () => {
  const mimi = scriptedModel([textStep('ได้ค่ะ'), textStep('ค่ะ')]);
  const small = replyingModel([(prompt) => (prompt.includes('You file finished conversations') ? { text: 'TITLE: เรื่องยาว\nSUMMARY: คุยกันยาวมาก' } : { text: 'nothing' })]);
  const target = await makeTestCore({ models: { mimi }, small, settings: { session: { max_tokens: 40 } } });
  setAgent(target, 'mimi', 'model: test/mimi\ntools: []');
  const chat = target.core.chats.directChat('mimi');

  const first = await turn(target, { chatId: chat.id, text: 'เล่าเรื่องยาว ๆ ให้ฟังหน่อย '.repeat(10) });
  const second = await turn(target, { chatId: chat.id, text: 'ต่อเลย' });

  assert.ok(first.session.type === 'session' && second.session.type === 'session');
  assert.equal(second.session.started, true, 'the long session is followed by a new one without any silence');
  assert.notEqual(second.session.session.id, first.session.session.id);
  assert.ok(target.core.chats.sessionTokens(first.session.session.thread) >= 40);
  const usage = target.core.chats.sessionUsage(first.session.session.thread);
  assert.ok(usage.inputTokens >= 0 && usage.costUsd >= 0);
  await target.cleanup();
});
