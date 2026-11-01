import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserSecretTools } from '../tools/browser-secret-tools.ts';

const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: ['/tmp'] };

test('browser_fill_secret reads the vault, passes the value to the PC and never returns it', async () => {
  const calls: Array<{ tool: string; input: unknown }> = [];
  const tool = createBrowserSecretTools({
    secret: (name) => (name === 'CARD_CVC' ? '123' : undefined),
    pc: {
      online: true,
      allowedDirs: ['/tmp'],
      execute: async (name, input) => {
        calls.push({ tool: name, input });
        return 'Filled e9 from the vault. Now: Checkout - https://example.com/pay';
      },
    },
    localPcTools: false,
  })[0]!;
  assert.equal(tool.name, 'browser_fill_secret');
  assert.equal(tool.alwaysAsk, true, 'the UI offers only "this once"');
  assert.match(tool.summarize({ ref: 'e9', secret: 'CARD_CVC' }), /CARD_CVC/);
  assert.doesNotMatch(tool.summarize({ ref: 'e9', secret: 'CARD_CVC' }), /123/);

  const output = await tool.execute(tool.inputSchema.parse({ ref: 'e9', secret: 'CARD_CVC', submit: true }), context);
  assert.doesNotMatch(output, /123/);
  assert.deepEqual(calls, [{ tool: 'browser_fill_secret', input: { ref: 'e9', value: '123', submit: true } }]);

  await assert.rejects(tool.execute(tool.inputSchema.parse({ ref: 'e9', secret: 'MISSING' }), context), /No vault secret named "MISSING"/);
  assert.throws(() => tool.inputSchema.parse({ ref: 'e9', secret: 'bad name!' }), /Invalid|too|match/i);
});

test('browser_fill_secret explains an offline PC', async () => {
  const offline = createBrowserSecretTools({ secret: () => 'x', localPcTools: false })[0]!;
  await assert.rejects(offline.execute(offline.inputSchema.parse({ ref: 'e9', secret: 'S' }), context), /PC offline/);
});
