import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDriveTools } from '../microsoft/drive.ts';
import { MicrosoftAuth } from '../microsoft/auth.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-onedrive-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('onedrive_upload sends the file bytes and keeps the local name for a folder destination', async () => {
  const tokenFile = path.join(dir, 'ms-token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'refresh-1' }));
  const calls: Array<{ url: string; method: string; auth: string | null; type: string | null; body: Uint8Array | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body as Uint8Array | null;
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization'), type: headers.get('content-type'), body });
    if (url.includes('/token')) return Response.json({ access_token: 'token-1', expires_in: 3600 });
    return Response.json({ id: 'f1', name: 'note.txt', size: 5, file: { mimeType: 'text/plain' }, webUrl: 'https://onedrive.test/f1' });
  }) as typeof fetch;
  const auth = new MicrosoftAuth({ credentials: () => ({ clientId: 'id', tenant: 'common' }), tokenFile, fetchFn });
  const tools = Object.fromEntries(createDriveTools(auth).map((tool) => [tool.name, tool]));

  const folder = path.join(dir, 'docs');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'note.txt'), 'hello');
  const result = await tools.onedrive_upload!.execute({ path: 'note.txt', destination: 'Documents/' }, {
    traceId: 't',
    thread: 'main',
    agent: 'mimi',
    allowedDirs: [folder],
  });

  assert.match(result, /Uploaded: \[id f1\] note\.txt/);
  const upload = calls.at(-1)!;
  assert.equal(upload.method, 'PUT');
  assert.match(upload.url, /\/me\/drive\/root:\/Documents\/note\.txt:\/content$/);
  assert.equal(upload.type, 'text/plain');
  assert.equal(Buffer.from(upload.body!).toString('utf8'), 'hello');
});
