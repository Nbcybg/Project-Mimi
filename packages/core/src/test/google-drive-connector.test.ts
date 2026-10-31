import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { googleDriveConnector } from '../connectors/services/google-drive.ts';
import { fakeFetch } from './helpers/fake-fetch.ts';

const registry = new ConnectorRegistry([googleDriveConnector]);

function runtime(fetchFn: typeof fetch) {
  return new ConnectorRuntimeImpl({ registry, auth: { resolve: () => ({ accessToken: 'drive-token' }) }, fetchFn });
}

test('google_drive connector: upload, rename and share through operations', async () => {
  const api = fakeFetch(() => Response.json({ id: 'file-1', name: 'notes.txt', mimeType: 'text/plain' }));
  const drive = runtime(api.fetchFn);

  await drive.execute({
    connector: 'google_drive',
    operation: 'upload_file',
    input: { content: Buffer.from('hello drive').toString('base64'), mimeType: 'text/plain' },
  });
  const upload = api.calls.at(-1)!;
  assert.equal(new URL(upload.url).pathname, '/upload/drive/v3/files');
  assert.equal(new URL(upload.url).searchParams.get('uploadType'), 'media');
  assert.equal(upload.headers.get('content-type'), 'text/plain');
  assert.equal(Buffer.from(upload.bodyBytes!).toString('utf8'), 'hello drive');

  await drive.execute({ connector: 'google_drive', operation: 'rename_file', input: { fileId: 'file-1', name: 'renamed.txt' } });
  assert.deepEqual(JSON.parse(api.calls.at(-1)!.body!), { name: 'renamed.txt' });

  await drive.execute({
    connector: 'google_drive',
    operation: 'share_file',
    input: { fileId: 'file-1', emailAddress: 'friend@example.com' },
  });
  assert.deepEqual(JSON.parse(api.calls.at(-1)!.body!), { type: 'user', role: 'reader', emailAddress: 'friend@example.com' });

  await drive.execute({ connector: 'google_drive', operation: 'share_anyone', input: { fileId: 'file-1', role: 'writer' } });
  assert.deepEqual(JSON.parse(api.calls.at(-1)!.body!), { type: 'anyone', role: 'writer' });
});
