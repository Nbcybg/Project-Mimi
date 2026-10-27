import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import { importMake } from '../workflows/make-import.ts';
import { importN8n, REDACTED } from '../workflows/n8n-import.ts';
import { runWorkflow, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { WorkflowStore } from '../workflows/workflow-store.ts';
import { importZapier } from '../workflows/zapier-import.ts';

/**
 * Phase 3 matrix: every importer (n8n, Make, Zapier) is checked against the same
 * five points - happy path, unsupported steps, unreadable input, secret
 * redaction and the connection report - plus one end-to-end run of an imported
 * workflow. Coverage gaps are listed at the bottom of this file.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-migration-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/import', name), 'utf8'));

const options = { agent: 'mimi', existingNames: [] as string[], hasTool: () => true };

interface MigrationReport {
  source: string[];
  warnings: string[];
  unsupported: Array<Record<string, string>>;
  redacted: Array<Record<string, string>>;
  mapped: Array<Record<string, unknown>>;
  connections: Array<Record<string, unknown>>;
}
type Result = { workflows: WorkflowView[]; report: MigrationReport };

const platforms = [
  {
    name: 'n8n',
    lead: 'n8n-lead-intake.json',
    subject: 'node',
    connectionField: 'credentialType',
    run: (raw: unknown) => importN8n(raw, options) as unknown as Result,
  },
  {
    name: 'Make',
    lead: 'make-lead-intake.blueprint.json',
    subject: 'module',
    connectionField: 'connectionId',
    run: (raw: unknown) => importMake(raw, options) as unknown as Result,
  },
  {
    name: 'Zapier',
    lead: 'zapier-lead-intake.zapfile.json',
    subject: 'step',
    connectionField: 'authenticationId',
    run: (raw: unknown) => importZapier(raw, options) as unknown as Result,
  },
] as const;

const specs = new Map(connectorSpecs.map((spec) => [spec.key, spec]));
/** Builtin tool services that also appear as connection targets (they are not connectors). */
const TOOL_SERVICES = new Set(['google_sheets']);
const connectorNodes = (workflow: WorkflowView) =>
  workflow.nodes.filter((node) => node.type === 'connector') as Array<WorkflowView['nodes'][number] & { config: Record<string, unknown> }>;

test('migration matrix: every platform imports disabled workflows with catalog-valid connector nodes', () => {
  for (const platform of platforms) {
    const { workflows, report } = platform.run(fixture(platform.lead));
    assert.ok(workflows.length > 0, `${platform.name} imports at least one workflow`);
    assert.deepEqual(report.source, ['Lead intake'], `${platform.name} report source`);

    for (const workflow of workflows) {
      assert.equal(workflow.enabled, false, `${platform.name} workflow stays disabled`);
      assert.equal(workflow.webhook, null, `${platform.name} workflow has no webhook until enabled`);
      assert.ok(workflow.nodes.length > 0, `${platform.name} workflow has nodes`);

      for (const node of connectorNodes(workflow)) {
        const connector = String(node.config.connector);
        const operation = String(node.config.operation);
        assert.equal(node.config.allow, false, `${platform.name} connector node needs consent`);
        const spec = specs.get(connector);
        assert.ok(spec, `${platform.name} uses a connector that is installed: ${connector}`);
        assert.ok(spec.operations.some((entry) => entry.key === operation), `${platform.name} uses a real operation: ${connector}.${operation}`);
      }
    }

    assert.ok(
      report.mapped.some((entry) => entry.confidence === 'high' || entry.confidence === 'medium'),
      `${platform.name} maps at least one step with confidence`,
    );
    assert.ok(!JSON.stringify(workflows).includes('credential'), `${platform.name} imports no credential objects`);
  }
});

test('migration matrix: the connection report names real connectors and platform credential ids', () => {
  const [n8n, make, zapier] = platforms.map((platform) => platform.run(fixture(platform.lead)).report);
  assert.deepEqual(n8n!.connections, [{ node: 'Notify Slack', connector: 'slack' }]);
  assert.deepEqual(make!.connections, [
    { module: 'Log lead', connector: 'google_sheets', connectionId: '98765' },
    { module: 'Notify Slack', connector: 'slack', connectionId: '12345' },
  ]);
  assert.deepEqual(zapier!.connections, [
    { step: 'GoogleSheetsV2API: append_row', connector: 'google_sheets', authenticationId: '123456' },
    { step: 'SlackAPI: channel_message', connector: 'slack' },
    { step: 'AirtableAPI: create_record', connector: 'airtable', authenticationId: '987654' },
  ]);

  for (const platform of platforms) {
    const { report } = platform.run(fixture(platform.lead));
    for (const entry of report.mapped) {
      const spec = specs.get(String(entry.connector));
      assert.ok(spec, `${platform.name} mapped connector is installed: ${String(entry.connector)}`);
      assert.ok(spec.operations.some((operation) => operation.key === entry.operation), `${platform.name} mapped operation is real`);
    }
    for (const entry of report.connections) {
      const connector = String(entry.connector);
      assert.ok(specs.has(connector) || TOOL_SERVICES.has(connector), `${platform.name} connection target exists: ${connector}`);
      assert.ok(entry[platform.subject], `${platform.name} connection row names its ${platform.subject}`);
    }
    const withId = report.connections.filter((entry) => entry.connector !== 'slack');
    for (const entry of withId) {
      assert.ok(
        entry[platform.connectionField] === undefined || typeof entry[platform.connectionField] === 'string',
        `${platform.name} ${platform.connectionField} is only ever a referenced id`,
      );
    }
  }
});

test('migration matrix: unsupported steps become stop-with-explanation placeholders', () => {
  const n8nPython = platforms[0]!.run({
    name: 'placeholders',
    nodes: [
      { name: 'Manual', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      { name: 'Python bit', type: 'n8n-nodes-base.code', parameters: { language: 'python', pythonCode: 'return items' } },
    ],
    connections: { Manual: { main: [[{ node: 'Python bit' }]] } },
  });
  const cases: Array<[string, Result, string]> = [
    ['n8n', n8nPython, 'Python code'],
    ['Make', platforms[1]!.run(fixture('make/branch-and-error.blueprint.json')), 'ftp:uploadFile'],
    ['Zapier', platforms[2]!.run(fixture('zapier-lead-intake.zapfile.json')), 'Python code'],
  ];

  for (const [name, { workflows, report }, reason] of cases) {
    assert.equal(report.unsupported.length, 1, `${name} reports the unsupported step`);
    const entry = report.unsupported[0]!;
    assert.ok(String(entry.reason).includes(reason), `${name} reason mentions ${reason}`);
    const title = entry.node ?? entry.module ?? entry.step;
    const node = workflows.flatMap((workflow) => workflow.nodes).find((candidate) => candidate.title === title);
    assert.ok(node, `${name} keeps a node for "${title}"`);
    assert.equal(node.type, 'code', `${name} placeholder is a code node`);
    assert.match(String(node.config.code), /^throw new Error\(/, `${name} placeholder stops the run`);
    const escapedReason = JSON.stringify(String(entry.reason)).slice(1, -1);
    assert.ok(String(node.config.code).includes(`was not converted: ${escapedReason}`), `${name} placeholder explains why`);
    assert.ok(String(node.config.code).includes(String(entry.type ?? entry.api ?? '')), `${name} placeholder names the source type`);
  }
});

test('migration matrix: malformed input is rejected before anything is written', () => {
  assert.throws(() => JSON.parse('{"nodes": ['), SyntaxError, 'the wire contract is JSON');
  const n8nError = /not an n8n workflow|Nothing to import/;
  const makeError = /not a Make blueprint|no "flow"/;
  for (const [name, run] of platformRun([platforms[0]!, platforms[1]!])) {
    assert.throws(() => run({}), name === 'n8n' ? n8nError : makeError);
    assert.throws(() => run([]), name === 'n8n' ? n8nError : makeError);
    assert.throws(() => run(42), name === 'n8n' ? n8nError : makeError);
  }
  assert.throws(() => platforms[1]!.run({ name: 'No flow' }), /flow/);
  assert.throws(() => platforms[2]!.run({}), /no "zaps"|no steps/i);
  assert.throws(() => platforms[2]!.run([]), /no Zaps/i);
  assert.throws(() => platforms[2]!.run(42), /not a Zapier export/i);
});

function platformRun(list: ReadonlyArray<(typeof platforms)[number]>): Array<[string, (raw: unknown) => Result]> {
  return list.map((platform) => [platform.name, platform.run]);
}

test('migration matrix: secret-shaped fields are redacted and never written', () => {
  const n8n = platforms[0]!.run(fixture('n8n-lead-intake.json'));
  const make = platforms[1]!.run(fixture('make-lead-intake.blueprint.json'));
  const zapier = platforms[2]!.run(fixture('zapier/secure-webhook.zapfile.json'));

  assert.deepEqual(n8n.report.redacted, [{ node: 'Fetch profile', field: 'headerParameters.parameters[0].Authorization' }]);
  const n8nHttp = n8n.workflows[0]!.nodes.find((node) => node.title === 'Fetch profile')!;
  assert.equal((n8nHttp.config.headers as Record<string, string>).Authorization, REDACTED);

  assert.deepEqual(make.report.redacted, [{ module: 'Fetch profile', field: 'mapper.headers[0].Authorization' }]);
  const makeHttp = make.workflows[0]!.nodes.find((node) => node.title === 'Fetch profile')!;
  assert.equal((makeHttp.config.headers as Record<string, string>).Authorization, REDACTED);

  assert.deepEqual(zapier.report.redacted, [{ step: 'Send to CRM', field: 'params.headers[0].Authorization' }]);
  const zapierHttp = zapier.workflows[0]!.nodes.find((node) => node.title === 'Send to CRM')!;
  assert.equal((zapierHttp.config.headers as Record<string, string>).Authorization, REDACTED);

  for (const result of [n8n, make, zapier]) {
    assert.ok(!JSON.stringify(result.workflows).includes('demo-placeholder-token-not-real'), 'no secret reaches a workflow');
    assert.ok(!JSON.stringify(result.report).includes('demo-placeholder-token-not-real'), 'no secret reaches a report');
    assert.match(REDACTED, /ไม่ถูกนำเข้า/);
  }
});

test('migration regression: an imported n8n workflow saves to the store and runs through the connector runtime', async () => {
  const { workflows } = platforms[0]!.run({
    name: 'run check',
    nodes: [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
      { name: 'Notify Slack', type: 'n8n-nodes-base.slack', parameters: { resource: 'message', operation: 'post', channel: '#alerts', text: 'hi {{ $json.name }}' } },
    ],
    connections: { Webhook: { main: [[{ node: 'Notify Slack' }]] } },
  });
  const [imported] = workflows as [WorkflowView];
  assert.ok(imported);
  assert.equal(imported.trigger.pool, 'webhook');

  const store = new WorkflowStore(path.join(tmp, 'migration-flows'));
  store.save(imported);
  const stored = store.get('mimi', imported.name)!;
  assert.equal(stored.enabled, false);
  assert.equal(stored.trigger.pool, 'webhook');

  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true, message: { text: 'sent', ts: '1.0' } });
  }) as typeof fetch;
  const registry = new ConnectorRegistry(connectorSpecs);
  const runtime = new ConnectorRuntimeImpl({ registry, auth: { resolve: () => ({ botToken: 'xoxb-migration-test-token' }) }, fetchFn });
  const deps: WorkflowRunnerDeps = {
    runAgent: async () => '',
    tool: () => undefined,
    connector: runtime,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, 'migration-state.json')),
    allowedDirs: [],
    permissions: { slack_send_message: 'allow' },
  };
  const run = await runWorkflow({ ...stored, webhookKey: 'x' } as WorkflowView, [{ json: { name: 'Ann' } }], deps, undefined, 'webhook');
  assert.equal(run.ok, true, run.result);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.channel, '#alerts');
  assert.equal(bodies[0]!.text, 'hi Ann');
});

/*
 * Coverage gaps (recorded, not fixed here):
 * - The catalog UI (feature-tools.js) has no DOM test; its behavior is covered by
 *   docs/connectors/longtail-ui.md's smoke checklist.
 * - OpenAPI spec import has no server message or persistence yet, so no test can
 *   exercise an imported connector end to end (see the integration request in
 *   docs/connectors/longtail-ui.md).
 * - n8n apply-to-fields / per-field credential mapping is not part of the report
 *   matrix; the unit suite (n8n-import.test.ts) covers the details.
 */
