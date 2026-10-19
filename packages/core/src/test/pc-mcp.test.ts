import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { closeMcpSessions, PcAgent } from '@mimi/pc-agent';
import { startServer } from '../server/server.ts';
import { buildCustomTool } from '../tools/custom-tools.ts';
import { makePcRunner, PC_OFFLINE } from '../tools/executor.ts';
import { testCoreParts } from './core-helpers.ts';

const TOKEN = 'pc-mcp-token';

/** A tiny MCP server over stdio: one tool that echoes, one that reveals its environment. */
const FAKE_SERVER = `
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [
      { name: 'echoText', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
      { name: 'where', description: 'Environment', inputSchema: { type: 'object' } },
    ] } });
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      const text = name === 'echoText' ? 'echo: ' + args.text : [process.env.PC_MCP_TOKEN, process.env.PC_MCP_LEAK ?? 'none', process.cwd()].join('|');
      send({ id: message.id, result: { content: [{ type: 'text', text }] } });
    }
  }
});
`;

test('MCP servers and shell tools set to run on the PC go through the PC agent', async (t) => {
  const parts = testCoreParts({});
  const server = await startServer({ ...parts.config, token: TOKEN, host: '127.0.0.1', port: 0, localPcTools: false }, parts.coreOptions);
  const pcDir = fs.realpathSync.native(fs.mkdtempSync(path.join(parts.root, 'pc-')));
  fs.writeFileSync(path.join(pcDir, 'server.js'), FAKE_SERVER);
  process.env.PC_MCP_TOKEN = 'secret-from-vault';
  process.env.PC_MCP_LEAK = 'must-not-reach-the-server';
  let agent: PcAgent | undefined;
  t.after(async () => {
    agent?.stop();
    await closeMcpSessions();
    await server.close();
    delete process.env.PC_MCP_TOKEN;
    delete process.env.PC_MCP_LEAK;
    fs.rmSync(parts.root, { recursive: true, force: true });
  });

  const mcp = server.core.tools.mcp!;
  mcp.save({
    name: 'pcsrv',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [path.join(pcDir, 'server.js')],
    cwd: pcDir,
    env: { PC_MCP_TOKEN: '{{secret.PC_MCP_TOKEN}}' },
    untrusted: false,
    runsOn: 'pc',
  });

  // No PC agent connected and the core is not on the user's machine: it says so.
  const offline = await mcp.refresh('pcsrv');
  assert.match(offline.error ?? '', /PC offline/);
  const runner = makePcRunner(server.pc, false);
  assert.equal(runner.mode(), 'offline');
  const shellSpec = { name: 'where_pc', description: 'cwd', kind: 'shell' as const, params: [], settings: [], config: { command: `node -e "console.log('cwd=' + process.cwd())"`, cwd: pcDir, runsOn: 'pc' } };
  const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [parts.root] };
  await assert.rejects(buildCustomTool(shellSpec, undefined, runner).execute({}, context, {}), new RegExp(PC_OFFLINE.slice(0, 20)));

  agent = new PcAgent({ url: `ws://127.0.0.1:${server.port}/ws`, token: TOKEN, allowedDirs: [pcDir], name: 'test-pc', reconnect: false });
  agent.start();
  const deadline = Date.now() + 5000;
  while (!server.pc.online && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runner.mode(), 'remote');

  // The server runs on the PC; its tools are listed and callable from the core.
  const online = await mcp.refresh('pcsrv');
  assert.equal(online.error, undefined, online.error);
  assert.deepEqual(online.tools.map((tool) => tool.name), ['mcp_pcsrv_echo_text', 'mcp_pcsrv_where']);
  const echo = mcp.get('mcp_pcsrv_echo_text')!;
  assert.equal(await echo.execute({ text: 'สวัสดี' }, context, {}), 'echo: สวัสดี');
  const where = (await mcp.get('mcp_pcsrv_where')!.execute({}, context, {})).split('|');
  assert.deepEqual(where.slice(0, 2), ['secret-from-vault', 'none'], 'a secret reaches the server; the core\'s other keys do not');
  assert.equal(path.resolve(where[2]!), pcDir);
  assert.equal(server.core.tools.names().includes('mcp_session'), false, 'the PC agent\'s internal tool is not offered to agents');

  // A server may only run in a folder the PC allows.
  mcp.save({ name: 'pcsrv', enabled: true, transport: 'stdio', command: process.execPath, args: [path.join(pcDir, 'server.js')], cwd: parts.root, untrusted: false, runsOn: 'pc' });
  assert.match((await mcp.refresh('pcsrv')).error ?? '', /outside the allowed folders/);

  // A shell tool set to run on the PC uses the PC agent's shell, in the PC's folders.
  const viaPc = await buildCustomTool(shellSpec, undefined, runner).execute({}, context, {});
  assert.match(viaPc, new RegExp(`cwd=${pcDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  const outside = { ...shellSpec, config: { ...shellSpec.config, cwd: parts.root } };
  await assert.rejects(buildCustomTool(outside, undefined, runner).execute({}, context, {}), /outside the allowed folders/);
  // On the machine of the core itself ("local") it simply runs here, as before.
  const local = makePcRunner(undefined, true);
  assert.equal(local.mode(), 'local');
  const here = await buildCustomTool({ ...shellSpec, config: { ...shellSpec.config, cwd: parts.root } }, undefined, local).execute({}, context, {});
  assert.match(here, /cwd=/);
});
