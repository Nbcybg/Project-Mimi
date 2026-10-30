import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentEvent, Notification } from '@mimi/shared';
import { AgentCatalog } from '../agents/loader.ts';
import { openDb } from '../db/db.ts';
import { Scheduler } from '../scheduler/scheduler.ts';
import { TriggerFiles } from '../scheduler/trigger-files.ts';
import { createTriggerTools } from '../scheduler/trigger-tools.ts';
import { type Trigger, TriggerError, TriggerStore } from '../scheduler/triggers.ts';
import type { ToolDefinition } from '../tools/registry.ts';
import { flatten, makeTestCore, makeTestRoot } from './core-helpers.ts';
import { scriptedModel, textStep } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-sched-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Monday 12 October 2026, 12:00 in Bangkok. */
const NOON = new Date('2026-10-12T05:00:00Z');

function setup(dbPath = ':memory:') {
  let now = NOON;
  const db = openDb(dbPath);
  const store = new TriggerStore(db, 'Asia/Bangkok', () => now);
  return {
    db,
    store,
    advanceTo: (iso: string) => {
      now = new Date(iso);
    },
  };
}
const reminder = (extra: object) => ({ kind: 'reminder' as const, title: 'Dentist', text: 'Leave at 9', ...extra });

test('one-shot times without an offset are read in the core time zone', () => {
  const { store } = setup();
  const local = store.create(reminder({ fireAt: '2026-10-13T09:00:00' }));
  assert.equal(local.fireAt, '2026-10-13T02:00:00.000Z');
  assert.equal(local.nextFireAt, local.fireAt);
  assert.deepEqual({ repeat: local.repeat, status: local.status, synced: local.deviceSynced }, { repeat: false, status: 'active', synced: false });

  const withOffset = store.create(reminder({ fireAt: '2026-10-13T09:00:00+09:00' }));
  assert.equal(withOffset.fireAt, '2026-10-13T00:00:00.000Z');
});

test('cron triggers get their next time in the core time zone and repeat by default', () => {
  const { store } = setup();
  const daily = store.create(reminder({ cron: '0 8 * * *' }));
  assert.equal(daily.nextFireAt, '2026-10-13T01:00:00.000Z', '08:00 Bangkok, tomorrow');
  assert.equal(daily.repeat, true);
  assert.equal(store.create(reminder({ cron: '0 8 * * *', repeat: false })).repeat, false);
});

test('invalid schedules are rejected with a message the model can act on', () => {
  const { store } = setup();
  assert.throws(() => store.create(reminder({})), /exactly one of fire_at/);
  assert.throws(() => store.create(reminder({ fireAt: '2026-10-13T09:00:00', cron: '0 8 * * *' })), /exactly one/);
  assert.throws(() => store.create(reminder({ fireAt: '2026-10-11T09:00:00' })), /in the past/);
  assert.throws(() => store.create(reminder({ fireAt: 'next tuesday' })), TriggerError);
  assert.throws(() => store.create(reminder({ cron: 'every day' })), /Invalid schedule/);
  assert.throws(() => store.create({ ...reminder({ cron: '0 8 * * *' }), title: ' ' }), /needs a title/);
  assert.equal(store.list().length, 0);
});

test('update reschedules and resets the device sync flag; cancel deactivates', () => {
  const { store } = setup();
  const created = store.create(reminder({ fireAt: '2026-10-13T09:00:00' }));
  store.markSynced([created.id]);
  assert.equal(store.get(created.id)!.deviceSynced, true);

  const moved = store.update(created.id, { fireAt: '2026-10-14T10:30:00', title: 'Dentist (moved)' });
  assert.deepEqual(
    { title: moved.title, next: moved.nextFireAt, text: moved.text, synced: moved.deviceSynced },
    { title: 'Dentist (moved)', next: '2026-10-14T03:30:00.000Z', text: 'Leave at 9', synced: false },
  );
  const recurring = store.update(created.id, { cron: '30 7 * * 1' });
  assert.deepEqual({ fireAt: recurring.fireAt, cron: recurring.cron }, { fireAt: null, cron: '30 7 * * 1' });

  const cancelled = store.cancel(created.id);
  assert.deepEqual({ status: cancelled.status, next: cancelled.nextFireAt }, { status: 'cancelled', next: null });
  assert.throws(() => store.update(created.id, { title: 'x' }), /is cancelled/);
  assert.throws(() => store.cancel(999), /No trigger #999/);
});

test('scheduler fires each due trigger exactly once and advances recurring ones', async () => {
  const { store, advanceTo } = setup();
  const once = store.create(reminder({ fireAt: '2026-10-12T13:00:00' }));
  const daily = store.create({ kind: 'agent_task', title: 'Brief', text: 'Morning brief', cron: '0 8 * * *', agent: 'mimi' });
  const fired: number[] = [];
  const scheduler = new Scheduler({ store, fire: async (trigger) => (fired.push(trigger.id), `ran ${trigger.id}`) });

  assert.equal(await scheduler.tick(), 0, 'nothing is due yet');
  advanceTo('2026-10-12T06:00:30Z');
  assert.equal(await scheduler.tick(), 1);
  assert.equal(await scheduler.tick(), 0, 'a fired one-shot does not fire again');
  assert.deepEqual({ status: store.get(once.id)!.status, result: store.get(once.id)!.lastResult }, { status: 'fired', result: 'ran 1' });

  advanceTo('2026-10-13T01:00:05Z');
  await scheduler.tick();
  advanceTo('2026-10-14T01:00:05Z');
  await scheduler.tick();
  assert.deepEqual(fired, [once.id, daily.id, daily.id]);
  assert.deepEqual(
    { status: store.get(daily.id)!.status, next: store.get(daily.id)!.nextFireAt },
    { status: 'active', next: '2026-10-15T01:00:00.000Z' },
  );
});

test('triggers survive a restart: one missed while the process was down fires on the first check', async () => {
  const file = path.join(tmp, 'restart.db');
  const first = setup(file);
  first.store.create(reminder({ fireAt: '2026-10-12T13:00:00' }));
  first.db.close();

  const second = setup(file);
  second.advanceTo('2026-10-12T09:00:00Z'); // three hours late
  const fired: Trigger[] = [];
  const scheduler = new Scheduler({ store: second.store, fire: async (trigger) => (fired.push(trigger), 'ok') });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(fired[0]!.title, 'Dentist');
  second.db.close();
});

test('a failing action is recorded and does not stop the others; overlapping ticks share one pass', async () => {
  const { store, advanceTo } = setup();
  const bad = store.create(reminder({ fireAt: '2026-10-12T13:00:00', title: 'bad' }));
  const good = store.create(reminder({ fireAt: '2026-10-12T13:00:00', title: 'good' }));
  const errors: string[] = [];
  let runs = 0;
  const scheduler = new Scheduler({
    store,
    fire: async (trigger) => {
      runs++;
      if (trigger.title === 'bad') throw new Error('boom');
      return 'ok';
    },
    onError: (trigger, error) => errors.push(`${trigger.title}: ${error.message}`),
  });
  advanceTo('2026-10-12T07:00:00Z');

  const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.deepEqual([a, b, runs], [2, 2, 2]);
  assert.deepEqual(errors, ['bad: boom']);
  assert.equal(store.get(bad.id)!.lastResult, 'error: boom');
  assert.equal(store.get(good.id)!.lastResult, 'ok');
  assert.equal(store.get(bad.id)!.status, 'fired', 'advanced before the action ran, so it cannot fire twice');
});

test('trigger tools: create, list, update, cancel', async () => {
  const { store } = setup();
  const root = makeTestRoot();
  const tools = Object.fromEntries(
    createTriggerTools(store, new AgentCatalog(path.join(root, 'user', 'agents')), 'Asia/Bangkok').map((tool) => [tool.name, tool]),
  ) as Record<string, ToolDefinition<any>>;
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };
  assert.deepEqual(
    Object.values(tools).map((tool) => [tool.name, tool.risk]),
    [['create_trigger', 'write'], ['list_triggers', 'read'], ['update_trigger', 'write'], ['cancel_trigger', 'write']],
  );

  const created = await tools.create_trigger!.execute(
    { kind: 'agent_task', title: 'Brief', text: 'Summarize my mail', cron: '0 8 * * 1-5' },
    context,
  );
  assert.match(created, /Created #1 agent_task "Brief" cron "0 8 \* \* 1-5".*\[agent mimi\]: Summarize my mail/);
  await assert.rejects(
    tools.create_trigger!.execute({ kind: 'agent_task', title: 'x', text: 'y', cron: '0 8 * * *', agent: 'ghost' }, context),
    /Unknown agent "ghost"/,
  );
  await assert.rejects(
    tools.create_trigger!.execute({ kind: 'reminder', title: 'x', text: 'y', fire_at: '2020-01-01T00:00:00' }, context),
    TriggerError,
  );

  assert.match(await tools.list_triggers!.execute({}, context), /#1 agent_task "Brief"/);
  assert.match(await tools.update_trigger!.execute({ id: 1, title: 'Morning brief' }, context), /Updated #1 agent_task "Morning brief"/);
  assert.match(await tools.cancel_trigger!.execute({ id: 1 }, context), /Cancelled #1 .*\(cancelled\)/);
  assert.equal(await tools.list_triggers!.execute({}, context), 'No active triggers.');
  assert.match(await tools.list_triggers!.execute({ status: 'all' }, context), /#1 /);
  fs.rmSync(root, { recursive: true, force: true });
});

test('trigger tool results show times in the local zone, not UTC', async () => {
  const { store } = setup();
  const root = makeTestRoot();
  const tools = Object.fromEntries(
    createTriggerTools(store, new AgentCatalog(path.join(root, 'user', 'agents')), 'Asia/Bangkok').map((tool) => [tool.name, tool]),
  ) as Record<string, ToolDefinition<any>>;
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };

  const created = await tools.create_trigger!.execute(
    { kind: 'agent_task', title: 'Report', text: 'Send it', fire_at: '2026-10-31T00:30:00' },
    context,
  );
  // 00:30 Bangkok on the 31st is 17:30 UTC on the 30th; the reply must still name the 31st.
  assert.match(created, /at 2026-10-31T00:30:00\+07:00 \(Asia\/Bangkok\)/);
  assert.match(await tools.list_triggers!.execute({}, context), /at 2026-10-31T00:30:00\+07:00 \(Asia\/Bangkok\)/);
  fs.rmSync(root, { recursive: true, force: true });
});

/** Makes a trigger due without waiting for the clock. */
function makeDue(target: Awaited<ReturnType<typeof makeTestCore>>, id: number): void {
  target.core.db.prepare(`UPDATE triggers SET next_fire_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
}

/** What was said in the one-to-one chat with `agent`, which is where triggers report. */
function chatLog(target: Awaited<ReturnType<typeof makeTestCore>>, agent: string) {
  const chat = target.core.chats.directChat(agent);
  const [session] = target.core.chats.sessions(chat.id, 1);
  return { chat, messages: session ? target.core.deps.messages.page(session.thread, undefined, 50) : [] };
}

test('core: a reminder speaks in the chat with its agent and notifies clients', async () => {
  const target = await makeTestCore();
  const notifications: Notification[] = [];
  target.core.listeners.notification = (notification) => notifications.push(notification);
  const trigger = target.core.triggers.create({ kind: 'reminder', title: 'ประชุมทีม', text: 'ห้อง 3 ชั้น 5', cron: '0 9 * * 1' });
  makeDue(target, trigger.id);

  assert.equal(await target.core.scheduler.tick(), 1);

  const log = chatLog(target, 'mimi');
  // Each one is also stored in the inbox; its row id comes along.
  assert.ok(notifications.every((entry) => typeof entry.id === 'number'));
  assert.deepEqual(notifications.map(({ id: _id, ...rest }) => rest), [
    { kind: 'reminder', title: 'ประชุมทีม', body: 'ห้อง 3 ชั้น 5', triggerId: trigger.id, chatId: log.chat.id },
  ]);
  assert.deepEqual(
    log.messages.map((message) => [message.role, message.agent, message.text]),
    [['assistant', 'mimi', '⏰ ประชุมทีม: ห้อง 3 ชั้น 5']],
  );
  assert.equal(target.core.triggers.get(trigger.id)!.status, 'active', 'a recurring reminder stays scheduled');
  await target.cleanup();
});

test('core: an agent task runs unattended in its own thread; only the report joins the user thread', async () => {
  const tim = scriptedModel([textStep('3 new mails, nothing urgent.')]);
  const target = await makeTestCore({ models: { tim } });
  const notifications: Notification[] = [];
  const background: AgentEvent[] = [];
  target.core.listeners.notification = (notification) => notifications.push(notification);
  target.core.listeners.backgroundEvent = (event) => background.push(event);
  const trigger = target.core.triggers.create({
    kind: 'agent_task',
    title: 'Mail brief',
    text: 'Check my inbox and summarize',
    fireAt: new Date(Date.now() + 3_600_000).toISOString(),
    agent: 'tim',
  });
  makeDue(target, trigger.id);

  await target.core.scheduler.tick();

  const prompt = JSON.stringify(tim.doStreamCalls[0]!.prompt);
  assert.match(prompt, /<scheduled_task id=\\"1\\" title=\\"Mail brief\\">\\nCheck my inbox and summarize/);
  assert.match(prompt, /runs unattended/);
  const log = chatLog(target, 'tim');
  // Each one is also stored in the inbox; its row id comes along.
  assert.ok(notifications.every((entry) => typeof entry.id === 'number'));
  assert.deepEqual(notifications.map(({ id: _id, ...rest }) => rest), [
    { kind: 'task-result', title: 'Mail brief', body: '3 new mails, nothing urgent.', triggerId: 1, chatId: log.chat.id },
  ]);
  assert.deepEqual(
    log.messages.map((message) => [message.agent, message.text]),
    [['tim', '[Scheduled task "Mail brief"]\n3 new mails, nothing urgent.']],
  );
  const threads = target.core.db.prepare(`SELECT DISTINCT thread FROM messages ORDER BY thread`).all() as Array<{ thread: string }>;
  assert.equal(threads.length, 2, 'the task ran in its own thread; only the report is in the chat');
  assert.ok(threads.some(({ thread }) => thread === 'task:1'));
  assert.ok(flatten(background).some(({ agent, event }) => agent === 'tim' && event.type === 'run-finish'));
  assert.deepEqual(
    { status: target.core.triggers.get(1)!.status, result: target.core.triggers.get(1)!.lastResult },
    { status: 'fired', result: '3 new mails, nothing urgent.' },
  );
  await target.cleanup();
});

test('webhook triggers: unguessable key, no schedule, edited by key, deleted for good', () => {
  const { store } = setup();
  const hook = store.create({ kind: 'agent_task', title: 'Order', text: 'Handle the order', agent: 'mimi', webhook: true });
  assert.ok(hook.webhookKey && hook.webhookKey.length >= 20);
  assert.equal(hook.webhook, `/api/webhook/${hook.webhookKey}`);
  assert.equal(hook.fireAt, null);
  assert.equal(hook.cron, null);
  assert.equal(hook.nextFireAt, null);
  assert.deepEqual(store.due(), [], 'a webhook never comes due on the clock');
  assert.equal(store.byWebhookKey(hook.webhookKey!)!.id, hook.id);
  assert.equal(store.byWebhookKey('nope'), undefined);

  const updated = store.update(hook.id, { title: 'Orders', text: 'Handle the orders' });
  assert.equal(updated.webhookKey, hook.webhookKey, 'editing text keeps the URL');
  assert.equal(store.cancel(hook.id).status, 'cancelled');
  assert.equal(store.byWebhookKey(hook.webhookKey!)!.status, 'cancelled');
  assert.equal(store.delete(hook.id), true);
  assert.equal(store.byWebhookKey(hook.webhookKey!), undefined);
});

test('trigger files: export on change, import on a fresh database, newer side wins', () => {
  const dir = path.join(tmp, 'trigger-files');
  const first = setup();
  const files = new TriggerFiles(dir);
  first.store.onChange = (trigger) => files.write(trigger);
  const created = first.store.create(reminder({ fireAt: '2026-10-13T09:00:00' }));
  const file = path.join(dir, `${created.id}.json`);
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'Dentist');

  // A synced folder arriving on another machine: the fresh database imports it.
  const second = setup();
  const imported = new TriggerFiles(dir).reconcile(second.store);
  assert.equal(imported.imported, 1);
  const copy = second.store.get(created.id)!;
  assert.equal(copy.title, 'Dentist');
  assert.equal(copy.status, 'active');
  assert.ok(copy.nextFireAt, 'the schedule is recomputed on import');

  // The file was changed later (on the other machine): it replaces the row.
  files.write({ ...copy, title: 'From file', updatedAt: '2999-01-01T00:00:00.000Z' });
  assert.equal(new TriggerFiles(dir).reconcile(second.store).updated, 1);
  assert.equal(second.store.get(created.id)!.title, 'From file');

  // The row is newer: the file is overwritten from the database.
  second.store.update(created.id, { title: 'From db' });
  const stale = new TriggerFiles(dir).readAll()[0]!;
  files.write({ ...stale, updatedAt: '2000-01-01T00:00:00.000Z' });
  const exported = new TriggerFiles(dir).reconcile(second.store);
  assert.equal(exported.exported, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).title, 'From db');

  // Deleting removes the file too.
  second.store.onDelete = (id) => files.remove(id);
  assert.equal(second.store.delete(created.id), true);
  assert.equal(fs.existsSync(file), false);
});
