import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { importZapier } from '../workflows/zapier-import.ts';

const read = (relative: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/import', relative), 'utf8'));

const options = { agent: 'mimi', existingNames: [] as string[], hasTool: () => true };

test('Zapier import: orders steps, maps connectors/tools and reports unsupported steps', () => {
  const { workflows, report } = importZapier(read('zapier-lead-intake.zapfile.json'), options);
  const [workflow] = workflows;
  assert.ok(workflow);
  assert.equal(workflow.trigger.pool, 'webhook');
  assert.equal(workflow.enabled, false);
  assert.deepEqual(workflow.nodes.map((node) => node.type), ['tool', 'filter', 'connector', 'code', 'connector']);
  const byTitle = (title: string) => workflow.nodes.find((node) => node.title === title)!;

  assert.deepEqual(byTitle('GoogleSheetsV2API: append_row').config, {
    tool: 'sheets_append',
    input: {
      range: 'Leads',
      values: [['{{ $trigger.json.email }}', '{{ $trigger.json.name }}']],
    },
  });
  assert.deepEqual(byTitle('FilterAPI: filter').config, {
    combinator: 'and',
    conditions: [{ left: '{{ $trigger.json.email }}', operator: 'is_not_empty', right: '' }],
  });
  assert.deepEqual(byTitle('SlackAPI: channel_message').config, {
    connector: 'slack',
    operation: 'send_message',
    input: { channel: '#leads', text: 'New lead: {{ $trigger.json.name }}', unfurl_links: false },
    allow: false,
  });
  assert.equal(byTitle('CodeAPI: run_python').type, 'code');
  assert.deepEqual(byTitle('AirtableAPI: create_record').config, {
    connector: 'airtable',
    operation: 'create_record',
    input: { baseId: 'app-demo', table: 'Leads', typecast: false },
    allow: false,
  });

  assert.deepEqual(report.unsupported.map((entry) => [entry.step, entry.api, entry.action]), [
    ['CodeAPI: run_python', 'CodeAPI', 'run_python'],
  ]);
  assert.deepEqual(
    report.mapped.map((entry) => [entry.step, entry.connector, entry.operation, entry.confidence]),
    [
      ['SlackAPI: channel_message', 'slack', 'send_message', 'high'],
      ['AirtableAPI: create_record', 'airtable', 'create_record', 'medium'],
    ],
  );
  assert.deepEqual(report.connections, [
    { step: 'GoogleSheetsV2API: append_row', connector: 'google_sheets', authenticationId: '123456' },
    { step: 'SlackAPI: channel_message', connector: 'slack' },
    { step: 'AirtableAPI: create_record', connector: 'airtable', authenticationId: '987654' },
  ]);
  assert.ok(report.warnings.some((warning) => warning.includes('required fields missing')));
});

test('Zapier import: redacts headers, maps HTTP and keeps multiple Zaps apart', () => {
  const { workflows, report } = importZapier(read('zapier/secure-webhook.zapfile.json'), options);
  assert.equal(workflows.length, 2);
  assert.deepEqual(workflows.map((workflow) => workflow.trigger.pool), ['webhook', 'manual']);
  const [secure, scheduled] = workflows;
  assert.ok(secure);
  assert.ok(scheduled);
  const http = secure.nodes.find((node) => node.title === 'Send to CRM')!;
  assert.deepEqual(http.config, {
    method: 'POST',
    url: 'https://api.example.com/v1/leads',
    headers: {
      Authorization: '<<ใส่ค่าเอง: ค่าลับไม่ถูกนำเข้า>>',
      Accept: 'application/json',
    },
    body: { email: '{{ $trigger.json.email }}' },
  });
  assert.ok(!JSON.stringify(workflows).includes('demo-placeholder-token-not-real'));
  assert.deepEqual(report.redacted, [{ step: 'Send to CRM', field: 'params.headers[0].Authorization' }]);
  assert.deepEqual(report.unsupported.map((entry) => [entry.step, entry.api]), [['Zendesk ticket', 'ZendeskAPI']]);
  assert.deepEqual(
    report.workflows.map((entry) => [entry.title, entry.trigger]),
    [
      ['Secure webhook', 'webhook'],
      ['Scheduled digest', 'manual'],
    ],
  );
  assert.ok(report.warnings.some((warning) => warning.includes('ScheduleAPI')));
  assert.deepEqual(scheduled.nodes.map((node) => node.type), ['connector']);
});

test('Zapier import: accepts a single Zap, flattens branches, and rejects unreadable input', () => {
  const single = {
    title: 'Single Zap',
    nodes: [
      {
        id: 1,
        type_of: 'read',
        action: 'catch_hook',
        selected_api: 'WebHookAPI',
        params: {},
      },
      {
        id: 2,
        type_of: 'write',
        action: 'channel_message',
        selected_api: 'SlackAPI',
        parent_id: 1,
        params: { channel: '#a', text: 'A {{1__name}}' },
      },
      {
        id: 3,
        type_of: 'write',
        action: 'channel_message',
        selected_api: 'SlackAPI',
        parent_id: 1,
        params: { channel: '#b', text: 'B {{1__name}}' },
      },
    ],
  };
  const { workflows, report } = importZapier(single, { ...options, existingNames: ['single-zap'] });
  assert.equal(workflows[0]!.name, 'single-zap-2');
  assert.deepEqual(workflows[0]!.nodes.map((node) => node.config.input), [
    { channel: '#a', text: 'A {{ $trigger.json.name }}', unfurl_links: false },
    { channel: '#b', text: 'B {{ $trigger.json.name }}', unfurl_links: false },
  ]);
  assert.ok(report.warnings.some((warning) => warning.includes('branches')));

  assert.throws(() => importZapier({}, options), /no "zaps"|no steps/i);
  assert.throws(() => importZapier([], options), /no Zaps/i);
});
