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
