import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PcConsentOutcome } from '@mimi/shared';
import { type PendingConsent, PcHub } from '../server/pc-hub.ts';

const socket = () => ({ send() {}, close() {} });
const pending = (id: string, timeoutMs = 60_000) => ({
  type: 'consent-pending' as const,
  id,
  tool: 'write_file',
  risk: 'write',
  summary: 'เขียนไฟล์',
  agent: 'mimi',
  thread: 's-1',
  timeoutMs,
});

test('a question on the PC screen is listed until it ends, and every end is announced once', () => {
  const hub = new PcHub();
  const seen: string[] = [];
  hub.onConsent = (event) => seen.push(event.kind === 'pending' ? `pending:${event.request.id}` : `done:${event.request.id}:${event.outcome}`);
  const link = socket();
  hub.attach(link, { type: 'hello', role: 'pc', token: 't', allowedDirs: [], tools: [] });

  hub.consentPending(pending('a'));
  hub.consentPending(pending('b'));
  assert.deepEqual(hub.pendingConsents().map((entry: PendingConsent) => entry.id), ['a', 'b']);
  assert.ok(hub.pendingConsents()[0]!.expiresAt - hub.pendingConsents()[0]!.askedAt === 60_000);

  hub.consentEnded('a', 'allowed');
  hub.consentEnded('a', 'allowed'); // a second end is a no-op
  assert.deepEqual(seen, ['pending:a', 'pending:b', 'done:a:allowed']);

  // The PC agent going away ends what is still open, as "gone".
  hub.detach(link);
  assert.deepEqual(seen.slice(3), ['done:b:gone']);
  assert.equal(hub.pendingConsents().length, 0);
});

test('a result for the call also closes its question; one the PC never closes stays listed only for its timeout plus a short grace', async () => {
  const hub = new PcHub();
  const outcomes: PcConsentOutcome[] = [];
  hub.onConsent = (event) => {
    if (event.kind === 'done') outcomes.push(event.outcome);
  };
  hub.attach(socket(), { type: 'hello', role: 'pc', token: 't', allowedDirs: [], tools: [] });
  hub.consentPending(pending('r'));
  hub.handleResult({ type: 'tool-result', id: 'r', ok: true, output: '' });
  assert.deepEqual(outcomes, ['allowed']);

  hub.consentPending(pending('stuck', 5));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(hub.pendingConsents().length, 1, 'still listed during the grace period');
});
