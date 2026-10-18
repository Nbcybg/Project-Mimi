import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { FlowItem, WorkflowView } from '@mimi/shared';
import { openDb } from '../db/db.ts';
import { Approvals } from '../workflows/approvals.ts';
import { runWorkflowNode, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { splitMessage, TelegramHub, type TelegramListener } from '../workflows/telegram.ts';
import { matchText } from '../workflows/text-match.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-triggers-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const workflow = (overrides: Partial<WorkflowView> = {}): WorkflowView => ({
  name: 'flow',
  agent: 'mimi',
  title: 'Flow',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  nodes: [],
  ...overrides,
});

function baseDeps(extra: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
    ...extra,
  };
}

test('text match: prefix gives the rest, contains / regex ignore case, empty pattern takes all', () => {
  assert.deepEqual(matchText('starts_with', '/จด', '/จด ซื้อนม 2 ขวด'), { ok: true, rest: 'ซื้อนม 2 ขวด' });
  assert.equal(matchText('starts_with', '/จด', 'จด ซื้อนม').ok, false);
  assert.equal(matchText('contains', 'INVOICE', 'new invoice #4').ok, true);
  assert.equal(matchText('regex', '^\\d+ บาท$', '120 บาท').ok, true);
  assert.equal(matchText('regex', '([', 'x').ok, false);
  assert.equal(matchText('starts_with', '', 'anything').ok, true);
  assert.equal(matchText('any', 'x', 'y').ok, true);
});

test('approvals: posted with buttons, answered once, timeouts / aborts / restarts settle the row', async () => {
  const db = openDb(':memory:');
  const posted: string[] = [];
  const changed: Array<number | undefined> = [];
  let nextMessage = 100;
  const approvals = new Approvals(db, {
    post: (agent, text) => {
      posted.push(`${agent}: ${text}`);
      return { chatId: 7, messageId: nextMessage++ };
    },
    changed: (chatId) => changed.push(chatId),
  });

  const waiting = approvals.request({ workflow: 'mimi/pay', agent: 'mimi', text: 'จ่าย 500 ไหม?', timeoutMs: 60_000 });
  assert.deepEqual(posted, ['mimi: จ่าย 500 ไหม?']);
  const [id] = approvals.waiting();
  assert.equal(approvals.byMessages([100]).get(100)!.status, 'pending');
  assert.equal(approvals.decide(id!, true, ' ok จ่ายได้ '), true);
  assert.deepEqual(await waiting, { decision: 'approved', note: 'ok จ่ายได้' });
  assert.equal(approvals.decide(id!, false), false);
  assert.deepEqual(approvals.byMessages([100]).get(100), { id, status: 'approved', workflow: 'mimi/pay', expiresAt: approvals.byMessages([100]).get(100)!.expiresAt, note: 'ok จ่ายได้' });
  assert.ok(changed.includes(7));

  // Timeout (the floor is one second).
  const late = await approvals.request({ workflow: 'mimi/pay', agent: 'mimi', text: 'late?', timeoutMs: 1 });
  assert.deepEqual(late, { decision: 'timeout' });
  assert.equal(approvals.byMessages([101]).get(101)!.status, 'timeout');

  // Abort: the run is gone, the request expires.
  const controller = new AbortController();
  const aborted = approvals.request({ workflow: 'mimi/pay', agent: 'mimi', text: 'abort?', timeoutMs: 60_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, /aborted/);
  assert.equal(approvals.byMessages([102]).get(102)!.status, 'expired');

  // A pending row of an earlier process is expired by the next one.
  void approvals.request({ workflow: 'mimi/pay', agent: 'mimi', text: 'restart?', timeoutMs: 60_000 });
  const again = new Approvals(db, { post: () => ({ messageId: 0 }), changed: () => {} });
  assert.equal(again.byMessages([103]).get(103)!.status, 'expired');
  approvals.close();
  assert.deepEqual(approvals.waiting(), []);
});

test('approval node: the answer picks the output and is added to the items', async () => {
  const asked: string[] = [];
  const deps = baseDeps({
    requestApproval: async (request) => {
      asked.push(`${request.workflow}|${request.agent}|${request.text}|${request.timeoutMs}`);
      return { decision: 'rejected', note: 'แพงไป' };
    },
  });
  const result = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'approval', config: { message: 'จ่าย {{ $json.amount }} บาท?', timeoutMinutes: 5 }, links: { main: [] } },
    [{ json: { amount: 900 } }],
    deps,
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(asked, ['mimi/flow|mimi|จ่าย 900 บาท?|300000']);
  assert.equal(result.outputs.rejected![0]!.json.amount, 900);
  assert.deepEqual({ ...(result.outputs.rejected![0]!.json.approval as object), at: undefined }, { decision: 'rejected', note: 'แพงไป', at: undefined });
  assert.equal(result.outputs.approved, undefined);

  const empty = await runWorkflowNode(workflow(), { id: 'n1', type: 'approval', config: { message: '' }, links: { main: [] } }, [], deps);
  assert.match(empty.error!, /write the question/);
});

test('telegram node: sends per item with the token from the vault, long text in parts', async () => {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  }) as typeof fetch;
  const deps = baseDeps({ secret: (name) => (name === 'TELEGRAM_BOT_TOKEN' ? 'tok123' : undefined), fetchFn, telegramApi: 'https://tg.test' });
  const result = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'telegram', config: { chatId: '{{ $json.chatId }}', text: 'ได้รับ: {{ $json.text }}', parseMode: 'HTML' }, links: { main: [] } },
    [{ json: { chatId: 11, text: 'a' } }, { json: { chatId: 22, text: 'b' } }],
    deps,
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(sent.map((call) => [call.url, call.body.chat_id, call.body.text, call.body.parse_mode]), [
    ['https://tg.test/bottok123/sendMessage', '11', 'ได้รับ: a', 'HTML'],
    ['https://tg.test/bottok123/sendMessage', '22', 'ได้รับ: b', 'HTML'],
  ]);
  assert.deepEqual(result.outputs.main![1]!.json.telegram, { chatId: '22', messageId: 2 });

  const missing = await runWorkflowNode(
    workflow(),
    { id: 'n1', type: 'telegram', config: { tokenSecret: 'OTHER', chatId: '1', text: 'x' }, links: { main: [] } },
    [],
    deps,
  );
  assert.match(missing.error!, /no secret "OTHER"/);

  const parts = splitMessage(`${'a'.repeat(3000)}\n${'b'.repeat(3000)}`);
  assert.deepEqual(parts.map((part) => part.length), [3000, 3000]);
  assert.equal(splitMessage('x'.repeat(9000)).length, 3);
});

test('telegram hub: polls each bot once, filters by chat and text, keeps its cursor, reports errors', async () => {
  const runs: Array<{ id: string; item: FlowItem }> = [];
  const listener = (id: string, extra: Partial<TelegramListener>): TelegramListener => ({
    id,
    tokenSecret: 'TELEGRAM_BOT_TOKEN',
    chatIds: [],
    match: 'any',
    pattern: '',
    run: async (item) => runs.push({ id, item }),
    ...extra,
  });
  let listeners = [listener('note', { match: 'starts_with', pattern: '/จด', chatIds: ['11'] }), listener('all', {})];
  const cursor = new Map<string, string>();
  const reports: string[] = [];
  const urls: string[] = [];
  let calls = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    urls.push(url);
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            { update_id: 5, message: { message_id: 1, date: 1_760_000_000, text: '/จด ซื้อนม', chat: { id: 11 }, from: { id: 11, username: 'me' } } },
            { update_id: 6, message: { message_id: 2, date: 1_760_000_000, text: '/จด จากคนอื่น', chat: { id: 99 } } },
          ],
        }),
      );
    }
    if (calls === 2) return new Response(JSON.stringify({ ok: false, description: 'Conflict: webhook is active' }), { status: 409 });
    // Then hang like a long poll until the hub stops.
    return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  }) as typeof fetch;
  const hub = new TelegramHub({
    secret: (name) => (name === 'TELEGRAM_BOT_TOKEN' ? 'tok' : undefined),
    listeners: () => listeners,
    cursor: { get: (key) => cursor.get(key), set: (key, value) => cursor.set(key, value) },
    report: (message) => reports.push(message),
    fetchFn,
    apiBase: 'https://tg.test',
    retryMs: 5,
  });
  hub.sync();
  hub.sync();
  assert.deepEqual(hub.active(), ['TELEGRAM_BOT_TOKEN']);
  await until(() => calls >= 3);
  assert.deepEqual(
    runs.map((run) => [run.id, run.item.json.text, run.item.json.rest]),
    [
      ['note', '/จด ซื้อนม', 'ซื้อนม'],
      ['all', '/จด ซื้อนม', '/จด ซื้อนม'],
      ['all', '/จด จากคนอื่น', '/จด จากคนอื่น'],
    ],
  );
  assert.equal(cursor.get('telegram:TELEGRAM_BOT_TOKEN'), '7');
  assert.match(urls[2]!, /offset=7/);
  assert.match(reports[0]!, /webhook is active.*n8n/);

  listeners = [];
  hub.sync();
  assert.deepEqual(hub.active(), []);
  await hub.close();
});

test('core: a chat trigger takes a matching message and answers in the chat', async () => {
  const target = await makeTestCore({});
  target.core.workflows.save(
    workflow({
      name: 'note',
      trigger: { pool: 'chat', config: { match: 'starts_with', pattern: '/จด', reply: 'workflow_only' } },
      nodes: [{ id: 'n1', type: 'chat', title: 'ตอบ', config: { text: 'จดแล้ว: {{ $json.rest }}' }, links: { main: [] } }],
    }),
  );
  const chat = target.core.chats.directChat('mimi');
  const changed: number[] = [];
  target.core.listeners.chatChanged = (chatId) => changed.push(chatId);

  assert.equal(target.core.chatTriggers(chat.id, 'สวัสดี').consumed, false);
  const hit = target.core.chatTriggers(chat.id, '/จด ซื้อนม');
  assert.equal(hit.consumed, true);
  const posted = target.core.postUserMessage(chat.id, '/จด ซื้อนม');
  hit.run();
  await until(() => changed.includes(chat.id));
  const [session] = target.core.chats.sessions(chat.id, 1);
  assert.equal(session!.id, posted.sessionId);
  const texts = target.core.deps.messages.page(session!.thread, undefined, 10).map((message) => `${message.role}:${message.text}`);
  assert.deepEqual(texts, ['user:/จด ซื้อนม', 'assistant:จดแล้ว: ซื้อนม']);
  await until(() => target.core.workflowRuns.list('mimi/note').length > 0);
  const runs = target.core.workflowRuns.list('mimi/note');
  assert.equal(runs[0]!.mode, 'chat');
  await target.cleanup();
});

test('core: an approval node waits for the answer in the chat, then goes on', async () => {
  const target = await makeTestCore({});
  target.core.workflows.save(
    workflow({
      name: 'pay',
      nodes: [
        { id: 'n1', type: 'approval', title: 'ถาม', config: { message: 'จ่าย {{ $json.amount }}?' }, links: { approved: ['n2'], rejected: ['n3'] } },
        { id: 'n2', type: 'set', title: 'paid', config: { fields: { paid: true } }, links: { main: [] } },
        { id: 'n3', type: 'set', title: 'skipped', config: { fields: { paid: false } }, links: { main: [] } },
      ],
    }),
  );
  const running = target.core.runWorkflow('mimi', 'pay', { amount: 300 });
  await until(() => target.core.approvals.waiting().length === 1);
  const chat = target.core.chats.directChat('mimi');
  const [session] = target.core.chats.sessions(chat.id, 1);
  const question = target.core.deps.messages.page(session!.thread, undefined, 5).at(-1)!;
  assert.equal(question.text, 'จ่าย 300?');
  assert.equal(target.core.approvals.byMessages([question.id]).get(question.id)!.status, 'pending');
  target.core.approvals.decide(target.core.approvals.waiting()[0]!, true);
  const run = await running;
  assert.equal(run.ok, true);
  assert.deepEqual(run.nodes.map((node) => node.title), ['ถาม', 'paid']);
  assert.equal(run.nodes[1]!.output[0]!.json.paid, true);
  await target.cleanup();
});
