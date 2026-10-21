import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { FlowItem, ToolDefinition, WorkflowNode, WorkflowView } from '@mimi/shared';
import { z } from 'zod';
import { defineTool } from '../tools/registry.ts';
import { runWorkflowNode, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-sheets-')));
const allowed = path.join(tmp, 'allowed');
fs.mkdirSync(allowed);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const workflow = (): WorkflowView => ({
  name: 'flow',
  agent: 'mimi',
  title: 'Flow',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  nodes: [],
});

interface Call {
  name: string;
  input: unknown;
  settings: unknown;
}

function fakeTool(name: string, risk: 'read' | 'write', calls: Call[]): ToolDefinition {
  return defineTool({
    name,
    description: '',
    risk,
    target: 'core',
    inputSchema: z.object({}).passthrough(),
    summarize: () => '',
    async execute(input, _context, settings) {
      calls.push({ name, input, settings });
      return 'ok';
    },
  });
}

function deps(calls: Call[], risk: 'read' | 'write' = 'read'): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: (name) => {
      const readable = name === 'sheets_info' || name === 'sheets_read';
      const writable = name === 'sheets_append' || name === 'sheets_write';
      if (readable || writable) return fakeTool(name, writable ? 'write' : 'read', calls);
      return undefined;
    },
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [allowed],
    timezone: 'Asia/Bangkok',
  };
}

const node = (config: WorkflowNode['config']): WorkflowNode => ({ id: 's1', type: 'sheets', config, links: { main: [] } });
const run = (n: WorkflowNode, d: WorkflowRunnerDeps, items: FlowItem[] = [{ json: { base: 1 } }]) =>
  runWorkflowNode(workflow(), n, items, d);

test('sheets node: read passes the account and spreadsheet to the base tool', async () => {
  const calls: Call[] = [];
  const result = await run(
    node({
      account: 'google-a',
      spreadsheetId: 'https://docs.google.com/spreadsheets/d/abc/edit',
      operation: 'read',
      range: 'Sheet1!A1:B2',
    }),
    deps(calls),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls[0]!.settings, {
    account: 'google-a',
    spreadsheetId: 'https://docs.google.com/spreadsheets/d/abc/edit',
  });
  assert.deepEqual(calls[0]!.input, { range: 'Sheet1!A1:B2' });
  assert.equal(result.outputs.main![0]!.json.base, 1);
  assert.equal(result.outputs.main![0]!.json.text, 'ok');
});

test('sheets node: writing needs the node to allow it, then sends the rows', async () => {
  const blocked: Call[] = [];
  const denied = await run(
    node({ spreadsheetId: 'abc', operation: 'append', range: 'Sheet1!A1', values: [['x', 1]] }),
    deps(blocked),
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /อนุญาต/);
  assert.equal(blocked.length, 0);

  const calls: Call[] = [];
  const result = await run(
    node({ spreadsheetId: 'abc', operation: 'append', range: 'Sheet1!A1', values: [['x', 1]], allow: true }),
    deps(calls),
  );
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls[0]!.input, { range: 'Sheet1!A1', values: [['x', 1]] });
  assert.deepEqual(calls[0]!.settings, { account: undefined, spreadsheetId: 'abc' });
});

test('sheets node: info needs no range; unknown operations fail', async () => {
  const calls: Call[] = [];
  const info = await run(node({ spreadsheetId: 'abc', operation: 'info' }), deps(calls));
  assert.equal(info.ok, true, info.error);
  assert.deepEqual(calls[0]!.input, {});

  const bad = await run(node({ spreadsheetId: 'abc', operation: 'delete' }), deps([]));
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /unknown operation/);
});
