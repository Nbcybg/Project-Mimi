import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolFileOutput } from '@mimi/shared';
import { z } from 'zod';
import { ToolFileExecutor } from '../chat/tool-files.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import { defineTool } from '../tools/registry.ts';
import { makeTestCore } from './core-helpers.ts';

const screenshot = defineTool({
  name: 'browser_screenshot',
  description: 'test',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({}),
  summarize: () => 'shot',
  execute: async () => '',
});
const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [] };

test('a file answered by a PC tool becomes a chat attachment; text answers pass through', async () => {
  const core = await makeTestCore({});
  let answer = toolFileOutput({ name: 'page.png', mime: 'image/png', data: Buffer.from('PNGBYTES').toString('base64') });
  const inner: ToolExecutor = { execute: async () => answer };
  const executor = new ToolFileExecutor(inner, core.core.attachments);

  const said = await executor.execute(screenshot, {}, context);
  const id = /attachment ([\w-]+)\./.exec(said)?.[1];
  assert.ok(id, said);
  const stored = core.core.attachments.get(id!);
  assert.deepEqual({ name: stored?.name, mime: stored?.mime }, { name: 'page.png', mime: 'image/png' });
  assert.equal(core.core.attachments.read(id!)?.toString(), 'PNGBYTES');
  assert.match(said, /send_file \(attachment_id: "/);

  answer = 'Clicked a "More".';
  assert.equal(await executor.execute(screenshot, {}, context), 'Clicked a "More".');
  answer = '\u0000mimi-file\u0000{not json';
  assert.equal(await executor.execute(screenshot, {}, context), answer, 'a broken file answer is left as text');
  await core.cleanup();
});
