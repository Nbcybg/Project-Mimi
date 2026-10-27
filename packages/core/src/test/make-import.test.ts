import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { importMake } from '../workflows/make-import.ts';

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/import', name), 'utf8'));

const options = { agent: 'mimi', existingNames: [] as string[], hasTool: () => true };

test('Make import: maps modules, connections, expressions and filters', () => {
  const { workflows, report } = importMake(fixture('make-lead-intake.blueprint.json'), options);
  const [workflow] = workflows;
  assert.ok(workflow);
  assert.equal(workflow.trigger.pool, 'webhook');
  assert.equal(workflow.enabled, false);
  assert.deepEqual(workflow.nodes.map((node) => node.type), ['http', 'filter', 'tool', 'connector', 'switch', 'code']);
  const byTitle = (title: string) => workflow.nodes.find((node) => node.title === title)!;

  assert.equal(byTitle('Fetch profile').config.url, 'https://api.example.com/v1/leads/{{ $trigger.json.id }}');
  assert.equal((byTitle('Fetch profile').config.headers as Record<string, string>).Accept, 'application/json');
  assert.deepEqual(byTitle('Has email').config.conditions, [
    { left: '{{ $node["Fetch profile"].json.email }}', operator: 'is_not_empty', right: '' },
  ]);
  assert.deepEqual(byTitle('Log lead').config, {
    tool: 'sheets_append',
    input: {
      range: 'Leads',
      values: [['{{ $node["Fetch profile"].json.name }}', '{{ $node["Fetch profile"].json.email }}']],
    },
  });
  assert.deepEqual(byTitle('Notify Slack').config, {
    connector: 'slack',
    operation: 'send_message',
    input: {
      channel: '#leads',
      text: 'New lead: {{ $node["Fetch profile"].json.name }}',
      unfurl_links: false,
    },
    allow: false,
  });
  assert.deepEqual(byTitle('Fallback').config, {
    mode: 'rules',
    cases: [{ left: true, operator: 'is_true', right: '' }],
  });
  assert.deepEqual(byTitle('Fallback').links, { case0: ['n6'] });

  assert.deepEqual(report.mapped, [
    {
      module: 'Notify Slack',
      connector: 'slack',
      operation: 'send_message',
      fields: ['channel', 'text', 'unfurl_links'],
      confidence: 'high',
    },
  ]);
  assert.deepEqual(report.connections, [
    { module: 'Log lead', connector: 'google_sheets', connectionId: '98765' },
    { module: 'Notify Slack', connector: 'slack', connectionId: '12345' },
  ]);
  assert.deepEqual(report.unsupported, []);
  assert.deepEqual(report.redacted, [{ module: 'Fetch profile', field: 'mapper.headers[0].Authorization' }]);
  assert.ok(!JSON.stringify(workflow).includes('demo-placeholder-token-not-real'));
  assert.ok(report.warnings.some((warning) => warning.includes('Mimi connection')));
});

test('Make import: keeps router cases, error branches and unsupported modules', () => {
  const { workflows, report } = importMake(fixture('make/branch-and-error.blueprint.json'), options);
  const [workflow] = workflows;
  assert.ok(workflow);
  assert.equal(workflow.trigger.pool, 'webhook');
  const byTitle = (title: string) => workflow.nodes.find((node) => node.title === title)!;

  assert.deepEqual(byTitle('Route by status').config.cases, [
    { left: '{{ $trigger.json.status }}', operator: 'equals', right: 'new' },
    { left: '{{ $trigger.json.status }}', operator: 'equals', right: 'vip' },
  ]);
  assert.deepEqual(byTitle('Route by status').links, { case0: ['n2'], case1: ['n3'] });
  assert.deepEqual(byTitle('Save VIP').config, {
    connector: 'airtable',
    operation: 'create_record',
    input: {
      baseId: 'app-demo',
      table: 'Leads',
      fields: { Email: '{{ $trigger.json.email }}', Name: '{{ $trigger.json.name }}' },
      typecast: false,
    },
    allow: false,
  });
  assert.equal(byTitle('Save VIP').onError, 'branch');
  assert.deepEqual(byTitle('Save VIP').links.error, ['n4']);
  assert.equal(byTitle('Error alert').config.connector, 'slack');
  assert.deepEqual(report.unsupported.map((entry) => [entry.module, entry.type]), [['Archive CSV', 'ftp:uploadFile']]);
  assert.deepEqual(
    report.mapped.map((entry) => [entry.module, entry.connector, entry.operation]),
    [
      ['Sales alert', 'slack', 'send_message'],
      ['Save VIP', 'airtable', 'create_record'],
      ['Error alert', 'slack', 'send_message'],
    ],
  );
});

test('Make import: rejects input without a flow and keeps names unique', () => {
  assert.throws(() => importMake({ name: 'No flow' }, options), /flow/);
  assert.throws(() => importMake([], options), /Make blueprint/);

  const { workflows } = importMake(fixture('make-lead-intake.blueprint.json'), {
    ...options,
    existingNames: ['lead-intake'],
  });
  assert.equal(workflows[0]!.name, 'lead-intake-2');
});
