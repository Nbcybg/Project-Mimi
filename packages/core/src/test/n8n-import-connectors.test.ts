import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { importN8n } from '../workflows/n8n-import.ts';

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/import/n8n', name), 'utf8'));

const options = { agent: 'mimi', existingNames: [], hasTool: () => false };

test('n8n connector mapping: top services become connector nodes with mapped inputs', () => {
  const { workflows, report } = importN8n(fixture('top-services.json'), options);
  const [workflow] = workflows;
  assert.ok(workflow);
  assert.equal(workflow.trigger.pool, 'webhook');
  assert.deepEqual(workflow.nodes.map((node) => node.type), ['connector', 'connector', 'connector', 'connector', 'connector', 'code']);
  const byTitle = (title: string) => workflow.nodes.find((node) => node.title === title)!;

  assert.deepEqual(byTitle('Post update').config, {
    connector: 'slack',
    operation: 'send_message',
    input: { channel: '#ops', text: 'New lead: {{ $json.name }}' },
    allow: false,
  });
  assert.deepEqual(byTitle('Create page').config, {
    connector: 'notion',
    operation: 'create_page',
    input: { databaseId: 'db-demo', properties: { Name: '{{ $json.name }}', Email: '{{ $json.email }}' } },
    allow: false,
  });
  assert.deepEqual(byTitle('Save lead').config, {
    connector: 'airtable',
    operation: 'create_record',
    input: { baseId: 'appDemo', table: 'Leads', fields: { Email: '{{ $json.email }}', Name: '{{ $json.name }}' } },
    allow: false,
  });
  assert.deepEqual(byTitle('Open issue').config, {
    connector: 'github',
    operation: 'create_issue',
    input: { owner: 'acme', repo: 'widgets', title: 'Lead {{ $json.name }}', body: 'Email: {{ $json.email }}' },
    allow: false,
  });
  assert.deepEqual(byTitle('Create contact').config, {
    connector: 'hubspot',
    operation: 'create_contact',
    input: { properties: { email: '{{ $json.email }}' } },
    allow: false,
  });

  assert.deepEqual(
    report.mapped.map((entry) => [entry.node, entry.connector, entry.operation, entry.confidence]),
    [
      ['Post update', 'slack', 'send_message', 'high'],
      ['Create page', 'notion', 'create_page', 'high'],
      ['Save lead', 'airtable', 'create_record', 'high'],
      ['Open issue', 'github', 'create_issue', 'high'],
      ['Create contact', 'hubspot', 'create_contact', 'high'],
    ],
  );
  assert.deepEqual(report.connections, [
    { node: 'Post update', connector: 'slack', credentialType: 'slackApi', credentialName: 'Slack Ops' },
    { node: 'Create page', connector: 'notion', credentialType: 'notionApi', credentialName: 'Notion Workspace' },
    { node: 'Save lead', connector: 'airtable', credentialType: 'airtableTokenApi', credentialName: 'Airtable Leads' },
    { node: 'Open issue', connector: 'github', credentialType: 'githubApi', credentialName: 'GitHub Main' },
    { node: 'Create contact', connector: 'hubspot', credentialType: 'hubspotApi', credentialName: 'HubSpot Main' },
  ]);
  assert.deepEqual(report.unsupported.map((entry) => entry.node), ['Archive lead']);
  assert.match(report.unsupported[0]!.reason, /no Mimi node/);
  assert.ok(report.warnings.some((warning) => /Slack Ops/.test(warning)));
  assert.ok(!JSON.stringify(workflows).includes('credentials'));
});

test('n8n app triggers: Slack, GitHub, Linear and Todoist become connector trigger pools', () => {
  const { workflows, report } = importN8n(
    {
      name: 'App triggers',
      nodes: [
        { name: 'Slack events', type: 'n8n-nodes-base.slackTrigger', parameters: {} },
        { name: 'GitHub events', type: 'n8n-nodes-base.githubTrigger', parameters: {} },
        { name: 'Linear issues', type: 'n8n-nodes-base.linearTrigger', parameters: { pollTimes: { item: [{ mode: 'everyX', value: 10, unit: 'minutes' }] } } },
        { name: 'Todoist tasks', type: 'n8n-nodes-base.todoistTrigger', parameters: {} },
        { name: 'Slack done', type: 'n8n-nodes-base.noOp', parameters: {} },
        { name: 'GitHub done', type: 'n8n-nodes-base.noOp', parameters: {} },
        { name: 'Linear done', type: 'n8n-nodes-base.noOp', parameters: {} },
        { name: 'Todoist done', type: 'n8n-nodes-base.noOp', parameters: {} },
      ],
      connections: {
        'Slack events': { main: [[{ node: 'Slack done' }]] },
        'GitHub events': { main: [[{ node: 'GitHub done' }]] },
        'Linear issues': { main: [[{ node: 'Linear done' }]] },
        'Todoist tasks': { main: [[{ node: 'Todoist done' }]] },
      },
    },
    options,
  );
  assert.deepEqual(
    workflows.map((workflow) => [workflow.trigger.pool, workflow.trigger.config]),
    [
      ['connector:slack:events', { signingSecretName: 'SLACK_SIGNING_SECRET' }],
      ['connector:github:events', { secretName: 'GITHUB_WEBHOOK_SECRET' }],
      ['connector:linear:new_issues', { everyMinutes: 10 }],
      ['connector:todoist:new_tasks', { everyMinutes: 15 }],
    ],
  );
  assert.equal(report.workflows.length, 4);
  assert.ok(report.warnings.some((warning) => /Slack trigger/.test(warning)));
  assert.ok(report.warnings.some((warning) => /GitHub trigger/.test(warning)));
});

test('n8n connector mapping: an unknown operation stays an unsupported placeholder', () => {
  const { workflows, report } = importN8n(
    {
      name: 'Unknown operation',
      nodes: [
        { name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        { name: 'Archive', type: 'n8n-nodes-base.slack', parameters: { resource: 'message', operation: 'archive' } },
      ],
      connections: { Manual: { main: [[{ node: 'Archive' }]] } },
    },
    options,
  );
  const archive = workflows[0]!.nodes.find((node) => node.title === 'Archive')!;
  assert.equal(archive.type, 'code');
  assert.match(String(archive.config.code), /not converted/);
  assert.deepEqual(report.mapped, []);
  assert.deepEqual(report.unsupported, [{ node: 'Archive', type: 'slack', reason: 'no connector operation mapping for resource "message" / operation "archive"' }]);
});
