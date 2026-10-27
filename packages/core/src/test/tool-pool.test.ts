import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { CustomToolSpec } from '@mimi/shared';
import { z } from 'zod';
import { SecretStore } from '../app/secrets.ts';
import { buildCustomTool, renderTemplate, resolveSettings } from '../tools/custom-tools.ts';
import { ToolPool } from '../tools/pool.ts';
import { defineTool, ToolRegistry } from '../tools/registry.ts';
import { ToolStore } from '../tools/tool-store.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-tools-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sheet = defineTool({
  name: 'sheets_read',
  description: 'Read a range from the configured spreadsheet.',
  risk: 'read',
  target: 'core',
  untrustedInput: true,
  settings: [{ key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true }],
  inputSchema: z.object({ range: z.string() }),
  summarize: (input) => `Read ${input.range}`,
  async execute(input, _context, settings) {
    return `${settings?.spreadsheetId} ${input.range}`;
  },
});

function makePool(dirName: string): ToolPool {
  return new ToolPool(
    new ToolRegistry().register(sheet),
    new ToolStore(path.join(tmp, dirName)),
    new SecretStore(path.join(tmp, dirName, 'secrets.json')),
  );
}

const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [tmp] };

test('templates read input, settings and secrets, and bare names prefer input', () => {
  process.env.MIMI_TEST_SECRET = 's3cret';
  const scope = { input: { id: 7 }, settings: { base: 'https://api.example.com' }, secret: (name: string) => process.env[name] };
  assert.equal(renderTemplate('{{settings.base}}/items/{{input.id}}', scope), 'https://api.example.com/items/7');
  assert.equal(renderTemplate('{{id}}/{{base}}', scope), '7/https://api.example.com');
  assert.equal(renderTemplate('key={{secret.MIMI_TEST_SECRET}}', scope), 'key=s3cret');
  assert.equal(renderTemplate('missing={{nope}}', scope), 'missing=');
});

test('required settings are enforced and defaults fill the gaps', () => {
  const fields = [
    { key: 'id', label: 'Id', type: 'string' as const, required: true },
    { key: 'limit', label: 'Limit', type: 'number' as const, default: 10 },
    { key: 'note', label: 'Note', type: 'string' as const, required: false },
  ];
  assert.deepEqual(resolveSettings(fields, { id: 'a' }, 'x'), { id: 'a', limit: 10 });
  assert.deepEqual(resolveSettings(fields, { id: 'a', note: 'n' }, 'x'), { id: 'a', limit: 10, note: 'n' });
  assert.throws(() => resolveSettings(fields, { limit: 5 }, 'x'), /needs its settings/);
  assert.throws(() => resolveSettings(fields, {}, 'x'), /needs its settings/);
});

test('a preset resolves to a named tool that runs the base tool with its settings', async () => {
  const pool = makePool('preset');
  const saved = pool.savePreset({ name: 'manager_sheet', tool: 'sheets_read', label: 'Manager Sheet', settings: { spreadsheetId: 'S1' } });
  assert.equal(saved.name, 'manager_sheet');
  const tool = pool.get('manager_sheet');
  assert.ok(tool);
  assert.equal(tool.name, 'manager_sheet');
  assert.match(tool.description, /Manager Sheet/);
  assert.match(tool.description, /spreadsheetId=S1/);
  assert.equal(await tool.execute({ range: 'A1:B2' }, context, {}), 'S1 A1:B2');
  // The pool lists both the base tool and the preset as selectable names.
  assert.ok(pool.names().includes('sheets_read'));
  assert.ok(pool.names().includes('manager_sheet'));
  const view = pool.views().find((entry) => entry.name === 'sheets_read');
  assert.deepEqual(view?.presets, ['manager_sheet']);
});

test('a preset cannot skip required settings and cannot shadow an existing tool', () => {
  const pool = makePool('validate');
  assert.throws(() => pool.savePreset({ name: 'broken', tool: 'sheets_read', settings: {} }), /Fill in/);
  assert.throws(() => pool.savePreset({ name: 'sheets_read', tool: 'sheets_read', settings: { spreadsheetId: 'x' } }), /existing tool/);
  assert.throws(() => pool.savePreset({ name: 'ghost', tool: 'nope', settings: {} }), /Unknown tool/);
});

test('custom tools are files: save, rename (presets follow), delete (presets go too)', () => {
  const pool = makePool('custom');
  const spec: CustomToolSpec = {
    name: 'my_api',
    description: 'Call my API',
    kind: 'http',
    params: [{ key: 'id', type: 'string' }],
    settings: [{ key: 'base', label: 'Base URL', type: 'string', required: true }],
    config: { method: 'GET', url: '{{settings.base}}/{{input.id}}' },
  };
  pool.saveCustom(spec);
  assert.ok(fs.existsSync(path.join(tmp, 'custom', 'my_api.json')));
  assert.equal(pool.get('my_api')?.risk, 'read');
  pool.savePreset({ name: 'prod_api', tool: 'my_api', settings: { base: 'https://prod' } });

  pool.saveCustom({ ...spec, name: 'my_api2' }, 'my_api');
  assert.equal(pool.get('my_api'), undefined);
  assert.ok(pool.get('my_api2'));
  assert.equal(pool.presetViews()[0]?.tool, 'my_api2', 'presets follow the rename');

  const orphans = pool.deleteCustom('my_api2');
  assert.deepEqual(orphans, ['prod_api']);
  assert.equal(pool.presetViews().length, 0);
  assert.equal(pool.get('my_api2'), undefined);
});

test('an HTTP custom tool renders its request and reports failures', async () => {
  const tool = buildCustomTool({
    name: 'rates',
    description: 'Exchange rates',
    kind: 'http',
    params: [{ key: 'date', type: 'string' }],
    settings: [{ key: 'base', label: 'Base URL', type: 'string', required: true }],
    config: { method: 'GET', url: '{{settings.base}}/rates/{{input.date}}', headers: { 'x-static': 'on' }, allowLocal: true },
  });
  const original = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response('{"rate":36.5}', { status: 200 });
    }) as typeof fetch;
    const ok = await tool.execute({ date: '2026-10-13' }, context, { base: 'https://api.example.com' });
    assert.equal(seen[0]!.url, 'https://api.example.com/rates/2026-10-13');
    assert.equal((seen[0]!.init?.headers as Record<string, string>)['x-static'], 'on');
    assert.equal(ok, '{"rate":36.5}');

    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await assert.rejects(tool.execute({ date: 'x' }, context, { base: 'https://api.example.com' }), /HTTP 500/);
  } finally {
    globalThis.fetch = original;
  }
});

test('untrusted tools and shell tools still cannot share an agent', () => {
  const pool = makePool('conflict');
  pool.saveCustom({
    name: 'fetch_it',
    description: 'Read the web',
    kind: 'http',
    params: [],
    settings: [],
    config: { method: 'GET', url: 'https://example.com' },
  });
  pool.saveCustom({ name: 'run_it', description: 'Run something', kind: 'shell', params: [], settings: [], config: { command: 'echo hi' } });
  assert.throws(() => pool.select(['fetch_it', 'run_it']), /cannot have both/);
  assert.equal(pool.select(['run_it']).length, 1);
});
