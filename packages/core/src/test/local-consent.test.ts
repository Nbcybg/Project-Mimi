import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { LineReader, LocalConsent, StdioConsentPrompt } from '@mimi/pc-agent';

test('read tools never ask; writes ask, and a task approval covers its family until it expires', async () => {
  let now = 1_000;
  let answer = true;
  const asked: string[] = [];
  const consent = new LocalConsent({
    ttlMs: 100,
    now: () => now,
    prompt: {
      async ask(request) {
        asked.push(request.tool);
        return answer;
      },
    },
  });
  const request = { id: 'one', summary: 'do it', traceId: 'trace' };

  assert.equal(await consent.allow({ ...request, tool: 'list_dir', risk: 'read' }), true);
  assert.deepEqual(asked, []);

  answer = false;
  assert.equal(await consent.allow({ ...request, tool: 'write_file', risk: 'write' }), false);
  assert.deepEqual(asked, ['write_file']);

  answer = true;
  assert.equal(await consent.allow({ ...request, tool: 'organize_files', risk: 'write', taskId: 'task-1' }), true);
  assert.equal(await consent.allow({ ...request, tool: 'undo_organize', risk: 'write', taskId: 'task-1' }), true);
  assert.deepEqual(asked, ['write_file', 'organize_files'], 'undo is the same family');
  assert.equal(await consent.allow({ ...request, tool: 'organize_files', risk: 'write', taskId: 'task-2' }), true);
  assert.deepEqual(asked, ['write_file', 'organize_files', 'organize_files'], 'another task asks again');

  now += 101;
  assert.equal(await consent.allow({ ...request, tool: 'organize_files', risk: 'write', taskId: 'task-1' }), true);
  assert.equal(asked.length, 4, 'the grant expired');
});

test('the desktop consent prompt exchanges a prefixed JSON question and answer', async () => {
  const input = new PassThrough();
  const output: string[] = [];
  const consent = new LocalConsent({
    prompt: new StdioConsentPrompt(new LineReader(input), (line) => output.push(line), 2_000),
  });

  const pending = consent.allow({
    id: 'request-1',
    tool: 'organize_files',
    risk: 'write',
    summary: 'ย้ายไฟล์',
    traceId: 'trace',
  });
  for (let i = 0; i < 20 && output.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(output.length, 1);
  assert.match(output[0]!, /^@@mimi-consent@@/);

  const request = JSON.parse(output[0]!.slice('@@mimi-consent@@'.length)) as { id: string };
  input.write(`${JSON.stringify({ type: 'consent-response', id: request.id, allow: true })}\n`);
  assert.equal(await pending, true);
  input.end();
});

test('a question nobody answers is refused after the timeout, the dialog is told to close and the core hears both ends', async () => {
  let aborted = false;
  const events: string[] = [];
  const consent = new LocalConsent({
    timeoutMs: 40,
    prompt: {
      ask(_request, signal) {
        signal?.addEventListener('abort', () => (aborted = true));
        return new Promise<boolean>(() => {}); // the user is away
      },
    },
    observer: {
      pending: (request, timeoutMs) => events.push(`pending:${request.id}:${timeoutMs}`),
      resolved: (request, outcome) => events.push(`resolved:${request.id}:${outcome}`),
    },
  });
  const request = { id: 'away', tool: 'write_file', risk: 'write' as const, summary: 'write', traceId: 't' };
  assert.equal(await consent.allow(request), false);
  assert.equal(aborted, true);
  assert.equal(consent.outcomeOf('away'), 'timeout');
  assert.deepEqual(events, ['pending:away:40', 'resolved:away:timeout']);

  // The next question is not stuck behind the one that timed out.
  const next = new LocalConsent({ timeoutMs: 1_000, prompt: { ask: async () => true }, observer: { resolved: (r, o) => events.push(`${r.id}:${o}`) } });
  assert.equal(await next.allow({ ...request, id: 'later' }), true);
  assert.equal(events.at(-1), 'later:allowed');
});

test('the stdio prompt tells the desktop app to close its dialog on timeout, and the abandoned wait does not eat the next answer', async () => {
  const input = new PassThrough();
  const output: string[] = [];
  const lines = new LineReader(input);
  const consent = new LocalConsent({ timeoutMs: 40, prompt: new StdioConsentPrompt(lines, (line) => output.push(line), 5_000) });
  const base = { tool: 'organize_files', risk: 'write' as const, summary: 'x', traceId: 't' };

  assert.equal(await consent.allow({ ...base, id: 'old' }), false);
  assert.ok(output.some((line) => line.startsWith('@@mimi-consent-cancel@@') && line.includes('"old"')), 'the desktop app was told to cancel');

  const second = new LocalConsent({ timeoutMs: 2_000, prompt: new StdioConsentPrompt(lines, (line) => output.push(line), 5_000) });
  const pending = second.allow({ ...base, id: 'new' });
  for (let i = 0; i < 20 && !output.some((line) => line.includes('"new"')); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  input.write(`${JSON.stringify({ type: 'consent-response', id: 'new', allow: true })}\n`);
  assert.equal(await pending, true, 'the stale wait was dropped, so this answer reaches the new question');
});
