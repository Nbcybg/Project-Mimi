import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../db/db.ts';
import { NotificationCenter } from '../notify/notifications.ts';
import type { PushResult, PushSubscriptionKeys } from '../notify/web-push.ts';
import { makeTestCore } from './core-helpers.ts';

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function center(answers: Record<string, number>) {
  const sent: Array<{ endpoint: string; payload: unknown; urgency: string }> = [];
  const send = async (subscription: PushSubscriptionKeys, payload: unknown, urgency: 'normal' | 'high'): Promise<PushResult> => {
    sent.push({ endpoint: subscription.endpoint, payload, urgency });
    const status = answers[subscription.endpoint] ?? 201;
    if (status === 0) throw new Error('network down');
    return { status, gone: status === 404 || status === 410 };
  };
  const notifications = new NotificationCenter(openDb(':memory:'), {
    vapid: () => {
      throw new Error('not used');
    },
    subject: 'mailto:mimi@localhost',
    send,
  });
  return { notifications, sent };
}

test('inbox: every notification is kept, unread counted, read marks stick', () => {
  const { notifications } = center({});
  const first = notifications.add({ kind: 'reminder', title: 'โทรหาแม่', body: 'ตอน 6 โมงเย็น', chatId: 4, triggerId: 9 });
  notifications.add({ kind: 'info', title: 'Telegram', body: 'เชื่อมไม่ได้' });
  assert.deepEqual({ ...first, createdAt: '' }, { id: first.id, kind: 'reminder', title: 'โทรหาแม่', body: 'ตอน 6 โมงเย็น', chatId: 4, triggerId: 9, createdAt: '', read: false });
  assert.equal(notifications.unread(), 2);
  notifications.markRead([first.id]);
  const listed = notifications.list();
  assert.deepEqual(listed.items.map((item) => [item.title, item.read]), [['Telegram', false], ['โทรหาแม่', true]]);
  assert.equal(listed.unread, 1);
  notifications.markRead();
  assert.equal(notifications.unread(), 0);
});

test('push: important kinds go to every device, dead ones are dropped, info stays in the inbox', async () => {
  const { notifications, sent } = center({ 'https://push.example.com/gone': 410, 'https://push.example.com/flaky': 0 });
  assert.throws(() => notifications.subscribe({ endpoint: 'http://insecure.example.com/x', p256dh: 'a', auth: 'b' }, 'x'), /https/);
  assert.throws(() => notifications.subscribe({ endpoint: 'not a url', p256dh: 'a', auth: 'b' }, 'x'), /not a URL/);
  for (const name of ['phone', 'gone', 'flaky']) notifications.subscribe({ endpoint: `https://push.example.com/${name}`, p256dh: 'key', auth: 'secret' }, name);
  notifications.subscribe({ endpoint: 'https://push.example.com/phone', p256dh: 'key2', auth: 'secret2' }, 'Android · Chrome');
  assert.deepEqual(notifications.devices().map((device) => [device.label, device.service]), [
    ['Android · Chrome', 'push.example.com'],
    ['gone', 'push.example.com'],
    ['flaky', 'push.example.com'],
  ]);

  notifications.add({ kind: 'info', title: 'note', body: 'just a note' });
  assert.equal(sent.length, 0, 'info is not pushed');

  const item = notifications.add({ kind: 'approval', title: 'รออนุมัติ', body: 'จ่าย 500?', chatId: 2 });
  await until(() => sent.length === 3);
  assert.deepEqual(sent[0]!.payload, { id: item.id, kind: 'approval', title: 'รออนุมัติ', body: 'จ่าย 500?', chatId: 2 });
  assert.ok(sent.every((entry) => entry.urgency === 'high'));
  await until(() => notifications.devices().length === 2);
  assert.deepEqual(notifications.devices().map((device) => device.label), ['Android · Chrome', 'flaky']);
  assert.ok(notifications.devices()[0]!.lastOkAt);
  assert.equal(await notifications.push({ id: 0, kind: 'task-result', title: 't', body: 'b' }), 1);
  assert.equal(notifications.unsubscribe('https://push.example.com/flaky'), true);
});


test('muted agents stay in the inbox but are not pushed', async () => {
  const sent: unknown[] = [];
  const notifications = new NotificationCenter(openDb(':memory:'), {
    vapid: () => { throw new Error('not used'); },
    subject: 'mailto:mimi@localhost',
    preferences: () => ({ mutedAgents: ['tim'] }),
    send: async (subscription, payload, urgency) => {
      sent.push({ endpoint: subscription.endpoint, payload, urgency });
      return { status: 201, gone: false };
    },
  });
  notifications.subscribe({ endpoint: 'https://push.example.com/phone', p256dh: 'key', auth: 'secret' }, 'phone');
  const muted = notifications.add({ kind: 'message', title: 'Tim', body: 'quiet', agent: 'tim' });
  const normal = notifications.add({ kind: 'message', title: 'Mimi', body: 'hello', agent: 'mimi' });
  await until(() => sent.length === 1);
  assert.equal((sent[0] as { payload: { id: number } }).payload.id, normal.id);
  assert.equal(notifications.list().items.some((item) => item.id === muted.id), true);
  assert.equal(notifications.muted('tim'), true);
  assert.equal(notifications.muted('mimi'), false);
});

test('core: approvals and reminders land in the inbox with their chat', async () => {
  const target = await makeTestCore({});
  const live: unknown[] = [];
  target.core.listeners.notification = (notification) => live.push(notification);
  target.core.workflows.save({
    name: 'pay',
    agent: 'mimi',
    title: 'จ่าย',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes: [{ id: 'n1', type: 'approval', config: { message: 'จ่ายไหม?' }, links: { approved: [], rejected: [] } }],
  });
  const paused = await target.core.runWorkflow('mimi', 'pay', {});
  assert.equal(paused.suspended!.kind, 'approval');
  const [stored] = target.core.notifications.list().items;
  assert.equal(stored!.kind, 'approval');
  assert.equal(stored!.chatId, target.core.chats.directChat('mimi').id);
  assert.equal((live[0] as { id: number }).id, stored!.id);
  await target.core.resumeParked(paused.suspended!.id, { kind: 'approval', decision: 'approved' });
  await target.cleanup();
});
