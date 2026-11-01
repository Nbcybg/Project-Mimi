import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { CalendarChangeView, WorkflowView } from '@mimi/shared';
import type { GoogleAuth } from '../google/auth.ts';
import type { MicrosoftAuth } from '../microsoft/auth.ts';
import { CalendarSync, type CalendarAccountHub } from '../calendar/sync.ts';
import { TriggerPool } from '../workflows/trigger-pool.ts';
import { triggerItems, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-calendar-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = new Date('2026-11-01T00:00:00Z');
const calendarDir = (name: string) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function requester(handler: (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => unknown) {
  return { request: async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => handler(url, init) };
}

function hub(accounts: Array<{ id: string; service: 'google' | 'microsoft'; name: string; auth: unknown }>): CalendarAccountHub {
  return {
    list: () => accounts.map(({ id, service, name }) => ({ id, service, name })),
    google: (id?: string) => (accounts.find((entry) => entry.id === id)?.auth ?? { isConfigured: false }) as GoogleAuth,
    microsoft: (id?: string) => (accounts.find((entry) => entry.id === id)?.auth ?? { isConfigured: false }) as MicrosoftAuth,
  };
}

const googleAccount = (auth: unknown) => ({ id: 'google-1', service: 'google' as const, name: 'งาน', auth: { isConfigured: true, ...(auth as object) } });
const microsoftAccount = (auth: unknown) => ({ id: 'microsoft-1', service: 'microsoft' as const, name: 'ส่วนตัว', auth: { isConfigured: true, ...(auth as object) } });

const googleEvent = (id: string, updated: string, status = 'confirmed') => ({
  id,
  status,
  summary: `event ${id}`,
  created: '2026-10-01T00:00:00.000Z',
  updated,
  start: { dateTime: '2026-11-02T09:00:00+07:00' },
  end: { dateTime: '2026-11-02T10:00:00+07:00' },
  htmlLink: `https://calendar.example/${id}`,
});

test('Google: first pass is a baseline, then syncToken changes are emitted once', async () => {
  const dir = calendarDir('google-delta');
  let deltas = 0;
  const auth = requester((url) => {
    assert.match(url, /calendars\/primary\/events/);
    if (url.includes('syncToken=s1')) {
      deltas++;
      return { items: [googleEvent('e1', '2026-11-01T05:00:00.000Z'), googleEvent('e2', '2026-11-01T05:00:00.000Z', 'cancelled')], nextSyncToken: 's2' };
    }
    if (url.includes('syncToken=s2')) {
      deltas++;
      return { items: [googleEvent('e1', '2026-11-01T05:00:00.000Z'), googleEvent('e2', '2026-11-01T05:00:00.000Z', 'cancelled')], nextSyncToken: 's2' };
    }
    assert.match(url, /timeMin=/);
    return { items: [googleEvent('e0', '2026-10-01T00:00:00.000Z')], nextSyncToken: 's1' };
  });
  const sync = new CalendarSync({ dir, accounts: hub([googleAccount(auth)]), now: () => NOW });

  assert.equal(await sync.tick(), 0, 'the baseline is not a change');
  assert.deepEqual(sync.pending('google'), []);

  assert.equal(await sync.tick(), 2);
  assert.deepEqual(
    sync.pending('google').map((change) => [change.id, change.action, change.source, change.account]),
    [
      ['e1', 'updated', 'google', 'google-1'],
      ['e2', 'deleted', 'google', 'google-1'],
    ],
  );
  assert.equal(await sync.tick(), 0, 'the same delta on the next poll is deduped');
  assert.equal(deltas, 2);

  const reloaded = new CalendarSync({ dir, accounts: hub([googleAccount(auth)]), now: () => NOW });
  assert.equal(reloaded.pending('google', 'google-1').length, 2, 'state and dedupe survive a restart');
  assert.equal(reloaded.view().accounts[0]!.push, false, 'no public URL = polling only');
});

test('Google: a 410 token restarts as a baseline instead of failing the poll', async () => {
  const dir = calendarDir('google-410');
  let second = false;
  const auth = requester((url) => {
    if (url.includes('syncToken=old')) throw new Error('Google API error 410: Sync token is no longer valid');
    if (second) return { items: [googleEvent('fresh', '2026-11-01T06:00:00.000Z')], nextSyncToken: 'new' };
    second = true;
    return { items: [], nextSyncToken: 'old' };
  });
  const sync = new CalendarSync({ dir, accounts: hub([googleAccount(auth)]), now: () => NOW });
  await sync.tick();
  assert.equal(await sync.tick(), 0, 'the replacement baseline is not emitted');
  assert.equal(sync.view().accounts[0]!.lastError, null);
});

test('Google push: channel token and message numbers are checked before a sync', async () => {
  const dir = calendarDir('google-push');
  let watch: Record<string, unknown> | undefined;
  let deltaCalls = 0;
  let pushItems: unknown[] = [];
  const auth = requester((url, init) => {
    if (url.endsWith('/events/watch')) {
      watch = init?.body as Record<string, unknown>;
      return { id: 'chan-1', resourceId: 'res-1', expiration: String(NOW.getTime() + 7 * 86_400_000) };
    }
    if (url.includes('/events')) {
      deltaCalls++;
      const items = deltaCalls === 1 ? [] : pushItems;
      return { items, nextSyncToken: `s${deltaCalls}` };
    }
    throw new Error(`unexpected ${url}`);
  });
  const sync = new CalendarSync({
    dir,
    accounts: hub([googleAccount(auth)]),
    publicUrl: 'https://tunnel.example',
    now: () => NOW,
  });
  await sync.tick();
  assert.match(String(watch?.address), /^https:\/\/tunnel\.example\/api\/calendar\/push\/[\w-]{20,}$/);
  assert.equal(watch?.type, 'web_hook');
  assert.equal((watch?.params as Record<string, string>).ttl, '604800');

  const url = new URL(String(watch?.address));
  const token = String(watch?.token);
  const push = (headers: Record<string, string>) =>
    sync.handlePush({ method: 'POST', url, headers, body: '' });

  assert.equal((await push({ 'x-goog-channel-token': 'wrong', 'x-goog-channel-id': 'chan-1', 'x-goog-message-number': '1' })).status, 401);
  assert.equal((await push({ 'x-goog-channel-token': token, 'x-goog-channel-id': 'chan-1', 'x-goog-resource-state': 'sync', 'x-goog-message-number': '0' })).status, 200);
  assert.equal(deltaCalls, 1, 'the initial sync notification does not start another delta');

  pushItems = [googleEvent('e9', '2026-11-01T07:00:00.000Z')];
  assert.equal((await push({ 'x-goog-channel-token': token, 'x-goog-channel-id': 'chan-1', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '5' })).status, 200);
  await sync.idle();
  assert.equal(sync.pending('google').length, 1);

  assert.equal((await push({ 'x-goog-channel-token': token, 'x-goog-channel-id': 'chan-1', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '5' })).body, 'duplicate');
  await sync.idle();
  assert.equal(deltaCalls, 2, 'a repeated message number is not synced again');
});

test('Graph: validation handshake, clientState check, delta and renewal', async () => {
  const dir = calendarDir('graph-push');
  let now = NOW;
  let created: Record<string, unknown> | undefined;
  let renewed: string | undefined;
  let deltaPath: string | undefined;
  let graphItems: unknown[] = [];
  const auth = requester((url, init) => {
    if (url === '/subscriptions' && init?.method === 'POST') {
      created = init.body as Record<string, unknown>;
      return { id: 'sub-1', expirationDateTime: String((init.body as { expirationDateTime: string }).expirationDateTime) };
    }
    if (url === '/subscriptions/sub-1' && init?.method === 'PATCH') {
      renewed = String((init.body as { expirationDateTime: string }).expirationDateTime);
      return { id: 'sub-1', expirationDateTime: renewed };
    }
    if (url.includes('/me/events/delta')) {
      deltaPath = url;
      return { value: graphItems, '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/events/delta?$deltatoken=1' };
    }
    throw new Error(`unexpected ${url}`);
  });
  const sync = new CalendarSync({
    dir,
    accounts: hub([microsoftAccount(auth)]),
    publicUrl: 'https://tunnel.example',
    now: () => now,
  });

  await sync.tick();
  assert.equal(created?.resource, '/me/events');
  assert.equal(created?.notificationUrl, sync.pushUrl('microsoft-1'));
  assert.equal(created?.changeType, 'created,updated,deleted');
  const pushUrl = new URL(String(sync.pushUrl('microsoft-1')));

  const validation = await sync.handlePush({ method: 'POST', url: new URL(`${pushUrl}?validationToken=abc%20123`), headers: {}, body: '' });
  assert.deepEqual([validation.status, validation.body], [200, 'abc 123']);

  const state = String(created?.clientState);
  const notify = (clientState: string) =>
    sync.handlePush({ method: 'POST', url: pushUrl, headers: {}, body: JSON.stringify({ value: [{ clientState, subscriptionId: 'sub-1' }] }) });
  assert.equal((await notify('wrong')).status, 401);

  graphItems = [
    {
      id: 'A1',
      subject: 'ประชุม',
      start: { dateTime: '2026-11-02T10:00:00.0000000' },
      end: { dateTime: '2026-11-02T11:00:00.0000000' },
      lastModifiedDateTime: '2026-11-01T07:00:00Z',
      createdDateTime: '2026-11-01T06:00:00Z',
      organizer: { emailAddress: { address: 'boss@example.com' } },
      attendees: [{ emailAddress: { address: 'me@example.com' } }],
    },
  ];
  assert.equal((await notify(state)).status, 202);
  await sync.idle();
  assert.deepEqual(
    sync.pending('microsoft').map((change) => [change.id, change.action, change.title, change.organizer, change.attendees]),
    [['A1', 'updated', 'ประชุม', 'boss@example.com', 'me@example.com']],
  );
  assert.match(String(deltaPath), /me\/events\/delta/);

  // A notification and its delta again: same lastModifiedDateTime is not a second change.
  await notify(state);
  await sync.idle();
  assert.equal(sync.pending('microsoft').length, 1);

  // Near expiry the tick renews instead of creating another subscription.
  now = new Date(NOW.getTime() + 2.5 * 86_400_000);
  await sync.tick();
  assert.ok(renewed, 'the subscription was renewed');
  const expires = Date.parse(renewed!);
  assert.ok(expires - now.getTime() >= 2.8 * 86_400_000, 'the new expiry is about three days out');
});

test('a change is not emitted twice when push and the safety-net poll race', async () => {
  const dir = calendarDir('race');
  let release: (() => void) | undefined;
  let watch: { address: string; token: string } | undefined;
  let deltaCalls = 0;
  // The watch body has the token; echo it so the notification passes verification.
  const realAuth = requester((url, init) => {
    if (url.endsWith('/events/watch')) {
      const body = init?.body as { address: string; token: string };
      watch = { address: body.address, token: body.token };
      return { id: 'chan', resourceId: 'res', expiration: String(NOW.getTime() + 7 * 86_400_000) };
    }
    deltaCalls++;
    if (deltaCalls === 2) return new Promise((resolve) => (release = () => resolve({ items: [googleEvent('same', '2026-11-01T08:00:00.000Z')], nextSyncToken: 's2' })));
    return { items: [], nextSyncToken: `s${deltaCalls}` };
  });
  const sync = new CalendarSync({ dir, accounts: hub([googleAccount(realAuth)]), publicUrl: 'https://tunnel.example', now: () => NOW });
  await sync.tick();
  const url = new URL(String(watch?.address));

  void sync.handlePush({
    method: 'POST',
    url,
    headers: { 'x-goog-channel-token': String(watch?.token), 'x-goog-channel-id': 'chan', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '2' },
    body: '',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await sync.tick();
  release?.();
  await sync.idle();
  assert.equal(sync.pending('google').length, 1, 'the push and the poll share one account sync');
  assert.equal(deltaCalls, 2);
});

test('the calendar trigger turns changes into n8n-style items and filters by type', async () => {
  const pool = new TriggerPool(path.join(tmp, 'pool'));
  const changes: CalendarChangeView[] = [
    {
      id: 'e1',
      source: 'google',
      account: 'google-1',
      action: 'created',
      title: 'A',
      start: '2026-11-02T09:00:00+07:00',
      end: '2026-11-02T10:00:00+07:00',
      allDay: false,
      location: '',
      organizer: 'me@example.com',
      attendees: '',
      link: '',
      status: 'confirmed',
      updatedAt: '2026-11-01T01:00:00Z',
      receivedAt: NOW.toISOString(),
      key: 'google:google-1:e1:updated:created',
    },
    {
      id: 'e2',
      source: 'google',
      account: 'google-1',
      action: 'deleted',
      title: 'B',
      start: '',
      end: '',
      allDay: true,
      location: '',
      organizer: '',
      attendees: '',
      link: '',
      status: 'cancelled',
      updatedAt: null,
      receivedAt: NOW.toISOString(),
      key: 'google:google-1:e2:deleted',
    },
  ];
  const deps: WorkflowRunnerDeps = {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    calendar: { pending: () => changes },
    state: new WorkflowState(path.join(tmp, 'state.json')),
    allowedDirs: [],
  };
  const workflow: WorkflowView = {
    name: 'flow',
    agent: 'mimi',
    title: 'Flow',
    description: '',
    enabled: true,
    trigger: { pool: 'calendar', config: { source: 'google', changeTypes: 'created', maxEvents: 20 } },
    webhook: null,
    nodes: [],
  };
  const items = await triggerItems(workflow, pool, deps);
  assert.deepEqual(items.map((item) => [item.json.Id, item.json.Action, item.json.Summary, item.json.Key]), [
    ['e1', 'created', 'A', 'google:google-1:e1:updated:created'],
  ]);
  assert.equal(items[0]!.json.Source, 'google');
  assert.equal(items[0]!.json.AllDay, false);
});

test('core: a calendar workflow gets its 15-minute safety-net schedule and runs without a change', async () => {
  const target = await makeTestCore();
  const saved = target.core.workflows.save({
    name: 'calendar-flow',
    agent: 'mimi',
    title: 'Calendar flow',
    description: '',
    enabled: true,
    trigger: { pool: 'calendar', config: { source: 'google', changeTypes: 'any', maxEvents: 20, everyMinutes: 15 } },
    webhook: null,
    nodes: [
      {
        id: 't',
        type: 'trigger_calendar',
        title: 'calendar',
        config: { source: 'google', changeTypes: 'any', maxEvents: 20, everyMinutes: 15 },
        links: { main: [] },
      },
    ],
  });
  target.core.syncWorkflowSchedule(saved);
  const schedule = target.core.triggers.byWorkflow('mimi/calendar-flow');
  assert.equal(schedule?.cron, '*/15 * * * *', 'the workflow poll is the safety net');

  target.core.db.prepare(`UPDATE triggers SET next_fire_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(schedule!.id);
  assert.equal(await target.core.scheduler.tick(), 1);
  assert.equal(target.core.triggers.get(schedule!.id)!.lastResult, 'no new calendar changes');
  assert.deepEqual(target.core.calendarSync.view().accounts, []);
  await target.cleanup();
});
