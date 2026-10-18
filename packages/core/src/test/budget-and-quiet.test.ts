import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PreferencesView } from '@mimi/shared';
import { AppSettings } from '../app/app-settings.ts';
import { createCore } from '../core.ts';
import { openDb } from '../db/db.ts';
import { runAgent } from '../loop/agent-loop.ts';
import { NotificationCenter } from '../notify/notifications.ts';
import { testCoreParts } from './core-helpers.ts';
import { collect, FakeBroker } from './helpers.ts';

test('quiet hours and push kinds decide what is pushed; the inbox keeps everything', () => {
  let prefs: PreferencesView = {};
  let now = new Date('2026-10-19T16:00:00Z'); // 23:00 in Bangkok
  const center = new NotificationCenter(openDb(':memory:'), {
    vapid: () => {
      throw new Error('not used');
    },
    subject: 'mailto:x@y',
    preferences: () => prefs,
    timezone: 'Asia/Bangkok',
    now: () => now,
  });
  assert.equal(center.shouldPush('reminder'), true, 'default kinds, no quiet hours');
  assert.equal(center.shouldPush('info'), false);
  prefs = { quietFrom: '22:00', quietTo: '07:00' };
  assert.equal(center.shouldPush('reminder'), false, 'quiet across midnight');
  assert.equal(center.shouldPush('approval'), true, 'approvals break through by default');
  prefs = { ...prefs, urgentApprovals: false };
  assert.equal(center.shouldPush('approval'), false);
  now = new Date('2026-10-19T02:00:00Z'); // 09:00 in Bangkok
  assert.equal(center.shouldPush('reminder'), true);
  prefs = { pushKinds: ['approval'] };
  assert.equal(center.shouldPush('reminder'), false);
  assert.equal(center.shouldPush('approval'), true);
  center.add({ kind: 'reminder', title: 't', body: 'b' });
  assert.equal(center.unread(), 1, 'not pushed, still in the inbox');
});

test('daily budget: once reached, agent runs stop with a clear message and one notice a day', async () => {
  const parts = testCoreParts();
  const app = AppSettings.load(path.join(parts.root, 'app-settings.json'));
  const core = await createCore(parts.config, new FakeBroker(true), { ...parts.coreOptions, app });
  try {
    app.setPreferences({ dailyBudgetUsd: 0.01 });
    const notices: string[] = [];
    core.listeners.notification = (notification) => notices.push(notification.title);
    // One expensive call today ($1 per 1k input tokens at this test price).
    core.deps.usage.logCall({
      runId: null,
      traceId: 't',
      agent: 'mimi',
      kind: 'chat',
      model: { ref: { provider: 'test', model: 'chat' }, name: 'chat', npm: '', baseURL: undefined, contextLimit: 1, outputLimit: undefined, cost: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }, imageInput: false, toolCall: false, textOutput: true, options: {} },
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 1,
    });
    assert.ok(core.spentToday() >= 0.01);
    await assert.rejects(collect(runAgent(core.deps, { agent: core.agents.get('mimi'), userText: 'hi' })), /spending limit is reached/);
    await assert.rejects(collect(runAgent(core.deps, { agent: core.agents.get('mimi'), userText: 'again' })), /spending limit/);
    assert.deepEqual(notices, ['ถึงงบรายวันแล้ว']);
    // No limit: runs go again.
    app.setPreferences({});
    const events = await collect(runAgent(core.deps, { agent: core.agents.get('mimi'), userText: 'ok now' }));
    assert.equal(events.at(-1)!.type, 'run-finish');
  } finally {
    await core.close();
    fs.rmSync(parts.root, { recursive: true, force: true });
  }
});
