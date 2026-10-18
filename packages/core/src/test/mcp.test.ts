import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { callResultText } from '../mcp/client.ts';
import { McpHub, mcpToolName } from '../mcp/hub.ts';

/** A tiny MCP server over stdio: two pages of tools, an echo, an error, and a ping to the client. */
const FAKE_SERVER = `
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
console.log('server log line that is not JSON');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
      send({ id: 'srv-1', method: 'ping' });
    } else if (message.method === 'tools/list') {
      if (!message.params.cursor) {
        send({ id: message.id, result: { tools: [{ name: 'echoText', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } }], nextCursor: 'p2' } });
      } else {
        send({ id: message.id, result: { tools: [{ name: 'fail', description: 'Fails', inputSchema: { type: 'object', properties: {} } }, { name: 'env', inputSchema: { type: 'object' } }] } });
      }
    } else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === 'echoText') send({ id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + args.text }] } });
      else if (name === 'env') send({ id: message.id, result: { content: [{ type: 'text', text: [process.env.TOKEN, process.env.OPENAI_API_KEY ?? 'none'].join(',') }] } });
      else send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'broken on purpose' }] } });
    } else if (message.id === 'srv-1') {
      process.stderr.write('ping answered ' + JSON.stringify(message.result) + '\\n');
    }
  }
});
`;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-mcp-'));
}

const ctx = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [] };

test('mcp names: camelCase to snake case, safe characters, at most 64', () => {
  assert.equal(mcpToolName('files', 'readFile'), 'mcp_files_read_file');
  assert.equal(mcpToolName('gh', 'list issues!'), 'mcp_gh_list_issues');
  assert.ok(mcpToolName('x', 'a'.repeat(100)).length <= 64);
});

test('mcp results: text parts joined, other kinds described, errors thrown', () => {
  assert.equal(callResultText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }), 'a\n[image image/png, 3 bytes]');
  assert.equal(callResultText({ structuredContent: { ok: 1 } }), '{"ok":1}');
  assert.throws(() => callResultText({ isError: true, content: [{ type: 'text', text: 'no' }] }), /no/);
});

test('mcp stdio: a server is saved, its tools listed (all pages) and called; secrets reach only its env', async () => {
  const dir = tempDir();
  const script = path.join(dir, 'fake server.mjs'); // a space, to check quoting on Windows
  fs.writeFileSync(script, FAKE_SERVER);
  process.env.OPENAI_API_KEY ??= 'must-not-leak';
  const hub = new McpHub({
    configPath: path.join(dir, 'tools', 'mcp.json'),
    cachePath: path.join(dir, 'data', 'mcp-tools.json'),
    secret: (name) => (name === 'FAKE_TOKEN' ? 'tok-123' : undefined),
  });
  try {
    assert.throws(() => hub.save({ name: 'Bad_Name', enabled: true, transport: 'stdio', command: 'x' }), /lowercase/);
    hub.save({ name: 'fake', enabled: true, transport: 'stdio', command: process.execPath, args: [script], env: { TOKEN: '{{secret.FAKE_TOKEN}}' } });
    const view = await hub.refresh('fake');
    assert.equal(view.error, undefined);
    assert.deepEqual(view.tools.map((tool) => [tool.name, tool.risk]), [
      ['mcp_fake_echo_text', 'read'],
      ['mcp_fake_fail', 'write'],
      ['mcp_fake_env', 'write'],
    ]);
    assert.deepEqual(hub.expand('mcp_fake'), ['mcp_fake_echo_text', 'mcp_fake_fail', 'mcp_fake_env']);

    const echo = hub.get('mcp_fake_echo_text')!;
    assert.equal(echo.untrustedInput, true);
    assert.equal(echo.inputSchema.safeParse({}).success, false, 'the server schema is enforced');
    assert.equal(await echo.execute({ text: 'สวัสดี' }, ctx), 'echo: สวัสดี');
    await assert.rejects(hub.get('mcp_fake_fail')!.execute({}, ctx), /broken on purpose/);
    assert.equal(await hub.get('mcp_fake_env')!.execute({}, ctx), 'tok-123,none');

    // A new hub (restart) knows the tools from the cache and connects on the first call.
    await hub.close();
    const again = new McpHub({ configPath: path.join(dir, 'tools', 'mcp.json'), cachePath: path.join(dir, 'data', 'mcp-tools.json'), secret: () => undefined });
    assert.equal(await again.get('mcp_fake_echo_text')!.execute({ text: 'x' }, ctx), 'echo: x');
    // Turned off: its tools are gone from the pool.
    again.save({ ...again.server('fake')!, enabled: false });
    assert.equal(again.get('mcp_fake_echo_text'), undefined);
    assert.equal(again.remove('fake'), true);
    assert.deepEqual(again.views(), []);
    await again.close();
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp stdio: a command that does not start is reported, not thrown', async () => {
  const dir = tempDir();
  const hub = new McpHub({ configPath: path.join(dir, 'mcp.json'), cachePath: path.join(dir, 'cache.json'), secret: () => undefined });
  try {
    hub.save({ name: 'broken', enabled: true, transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] });
    const view = await hub.refresh('broken');
    assert.match(view.error ?? '', /exited|not running/);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp http: session header kept, answers as JSON or as an SSE stream, headers from the vault', async () => {
  const seen: Array<{ method?: string; session?: string; auth?: string; version?: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'DELETE') return void res.writeHead(204).end();
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
      seen.push({ method: message.method, session: req.headers['mcp-session-id'] as string, auth: req.headers.authorization, version: req.headers['mcp-protocol-version'] as string });
      if (message.id === undefined) return void res.writeHead(202).end();
      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-9' });
        return void res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }));
      }
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'shout', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }));
      }
      // tools/call answers as a stream, with a progress notification first.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(message.params?.arguments?.text).toUpperCase() }] } })}\n\n`);
      // Left open: the client stops reading once its answer is in.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = tempDir();
  const hub = new McpHub({ configPath: path.join(dir, 'mcp.json'), cachePath: path.join(dir, 'cache.json'), secret: (name) => (name === 'HTTP_KEY' ? 'k1' : undefined) });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    hub.save({ name: 'web', enabled: true, transport: 'http', url, headers: { authorization: 'Bearer {{secret.HTTP_KEY}}' }, untrusted: false });
    const view = await hub.refresh('web');
    assert.equal(view.error, undefined);
    const shout = hub.get('mcp_web_shout')!;
    assert.equal(shout.untrustedInput, false);
    assert.equal(await shout.execute({ text: 'hi' }, ctx), 'HI');
    assert.equal(seen[0]!.session, undefined);
    assert.ok(seen.slice(1).every((entry) => entry.session === 'sess-9' && entry.version === '2025-06-18'));
    assert.ok(seen.every((entry) => entry.auth === 'Bearer k1'));
    assert.throws(() => hub.save({ name: 'nourl', enabled: true, transport: 'http', url: 'ftp://x' }), /URL/);
  } finally {
    await hub.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool pool: MCP tools are listed, picked one by one or as a whole server, and shown with their server', async () => {
  const { ToolPool } = await import('../tools/pool.ts');
  const { ToolRegistry } = await import('../tools/registry.ts');
  const { ToolStore } = await import('../tools/tool-store.ts');
  const { SecretStore } = await import('../app/secrets.ts');
  const dir = tempDir();
  const cachePath = path.join(dir, 'cache.json');
  // The same layout as the app: the MCP file sits under the tools folder without breaking it.
  const hub = new McpHub({ configPath: path.join(dir, 'tools', 'mcp', 'servers.json'), cachePath, secret: () => undefined });
  try {
    hub.save({ name: 'notes', enabled: true, transport: 'stdio', command: 'unused' });
    fs.writeFileSync(cachePath, JSON.stringify({ notes: { tools: [{ name: 'find', annotations: { readOnlyHint: true } }, { name: 'add' }], checkedAt: new Date().toISOString() } }));
    const pool = new ToolPool(new ToolRegistry(), new ToolStore(path.join(dir, 'tools')), new SecretStore(path.join(dir, 'secrets.json')), hub);
    assert.deepEqual(pool.names(), ['mcp_notes_add', 'mcp_notes_find']);
    assert.deepEqual(pool.select(['mcp_notes', 'mcp_notes_find']).map((tool) => tool.name), ['mcp_notes_find', 'mcp_notes_add']);
    assert.deepEqual(pool.views().map((view) => [view.name, view.mcp, view.risk]), [
      ['mcp_notes_find', 'notes', 'read'],
      ['mcp_notes_add', 'notes', 'write'],
    ]);
    assert.throws(() => pool.select(['mcp_other']), /Unknown tool/);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
