import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { importN8n } from '../workflows/n8n-import.ts';

type Obj = Record<string, unknown>;

const fixtures = {
  n8n: 'n8n-lead-intake.json',
  make: 'make-lead-intake.blueprint.json',
  zapier: 'zapier-lead-intake.zapfile.json',
} as const;

const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/import', name), 'utf8'));
}

test('import fixtures: every file is valid JSON and stays synthetic', () => {
  const raw = Object.values(fixtures).map((name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/import', name), 'utf8'));
  for (const text of raw) assert.doesNotThrow(() => JSON.parse(text));
  const all = raw.join('\n');
  assert.doesNotMatch(all, /xox[abp]-[A-Za-z0-9-]{20,}/);
  assert.doesNotMatch(all, /sk_live_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}/);
  assert.doesNotMatch(all, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
});

const MAKE_SUPPORTED = new Set([
  'gateway:CustomWebHook',
  'http:ActionSendData',
  'builtin:BasicFilter',
  'builtin:BasicRouter',
  'google-sheets:addRow',
]);

function inspectMake(raw: unknown) {
  assert.ok(isObj(raw), 'blueprint must be an object');
  assert.equal(typeof raw.name, 'string');
  assert.ok(Array.isArray(raw.flow), 'blueprint.flow must be an array');

  const modules: Array<{ id: number; module: string; name: string; branch: string }> = [];
  let routeCount = 0;

  const walk = (flow: unknown[], branch: string): void => {
    for (const entry of flow) {
      assert.ok(isObj(entry), 'every Make module must be an object');
      const metadata = isObj(entry.metadata) ? entry.metadata : {};
      const designer = isObj(metadata.designer) ? metadata.designer : {};
      modules.push({
        id: num(entry.id),
        module: str(entry.module),
        name: str(designer.name) || str(entry.module),
        branch,
      });
      for (const route of arr(entry.routes)) {
        routeCount++;
        assert.ok(isObj(route));
        walk(arr(route.flow), `${branch}/route${routeCount}`);
      }
      if (isObj(entry.onerror)) walk(arr(entry.onerror.flow), `${branch}/error`);
    }
  };

  walk(raw.flow, 'main');

  const connectionIds: number[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isObj(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '__IMTCONN__' && typeof item === 'number') connectionIds.push(item);
      visit(item);
    }
  };
  visit(raw.flow);

  const refs = new Set<string>();
  for (const match of JSON.stringify(raw.flow).matchAll(/\{\{\s*(\d+)\./g)) refs.add(match[1]!);

  return {
    name: raw.name,
    modules,
    routeCount,
    connectionIds,
    refs: [...refs],
    unsupported: modules.filter((entry) => !MAKE_SUPPORTED.has(entry.module)),
  };
}

type ZapStep = {
  id: number;
  action: string;
  selectedApi: string;
  authenticationId: string | null;
  parentId: number | null;
  params: Obj;
};

const ZAPIER_SUPPORTED = new Set(['WebHookAPI', 'GoogleSheetsV2API', 'FilterAPI', 'SlackAPI']);

function inspectZapier(raw: unknown) {
  assert.ok(isObj(raw), 'zapfile must be an object');
  assert.ok(isObj(raw.metadata));
  assert.equal(num(raw.metadata.version), 2);
  assert.ok(Array.isArray(raw.zaps), 'zapfile.zaps must be an array');

  return raw.zaps.map((zap) => {
    assert.ok(isObj(zap), 'every zap must be an object');
    assert.ok(isObj(zap.nodes), 'every zap must have a nodes object');
    const steps: ZapStep[] = Object.values(zap.nodes).map((node) => {
      assert.ok(isObj(node), 'every zap step must be an object');
      return {
        id: num(node.id),
        action: str(node.action),
        selectedApi: str(node.selected_api),
        authenticationId: typeof node.authentication_id === 'string' ? node.authentication_id : null,
        parentId: typeof node.parent_id === 'number' ? node.parent_id : null,
        params: isObj(node.params) ? node.params : {},
      };
    });

    const byParent = new Map<number | null, ZapStep[]>();
    for (const step of steps) byParent.set(step.parentId, [...(byParent.get(step.parentId) ?? []), step]);
    const ordered: ZapStep[] = [];
    const queue = [...(byParent.get(null) ?? [])];
    while (queue.length > 0) {
      const step = queue.shift()!;
      ordered.push(step);
      queue.push(...(byParent.get(step.id) ?? []));
    }
    assert.equal(ordered.length, steps.length, 'every Zap step is reachable through parent_id');

    const mappingRefs = new Set<string>();
    for (const match of JSON.stringify(zap.nodes).matchAll(/\{\{\s*(\d+)__([A-Za-z0-9_]+)\s*\}\}/g)) {
      mappingRefs.add(`${match[1]}__${match[2]}`);
    }

    return {
      title: str(zap.title),
      steps: ordered,
      unsupported: ordered.filter((step) => !ZAPIER_SUPPORTED.has(step.selectedApi)),
      authRefs: ordered
        .filter((step) => step.authenticationId !== null)
        .map((step) => `${step.selectedApi}:${step.authenticationId}`),
      mappingRefs: [...mappingRefs],
    };
  });
}

test('n8n fixture: importer maps the supported path, redacts auth and reports Slack', () => {
  const { workflows, report } = importN8n(readFixture(fixtures.n8n), {
    agent: 'mimi',
    existingNames: [],
    hasTool: (name) => name === 'gmail_send' || name === 'sheets_append',
  });

  assert.deepEqual(report.source, ['Lead intake']);
  assert.equal(workflows.length, 1);
  const [workflow] = workflows;
  assert.ok(workflow);
  assert.equal(workflow.trigger.pool, 'webhook');
  assert.deepEqual(workflow.nodes.map((node) => node.type), ['http', 'tool', 'tool', 'code', 'set']);
  assert.deepEqual(
    workflow.nodes.filter((node) => node.type === 'tool').map((node) => node.config.tool),
    ['gmail_send', 'sheets_append'],
  );
  assert.deepEqual(report.unsupported.map((entry) => entry.node), ['Notify Slack']);
  assert.match(report.unsupported[0]!.reason, /no Mimi node/);
  assert.deepEqual(report.redacted.map((entry) => entry.field), ['headerParameters.parameters[0].Authorization']);
  assert.ok(!JSON.stringify(workflows).includes('demo-placeholder-token-not-real'), 'the placeholder header never reaches a workflow');
});

test('Make fixture: blueprint walk finds branch modules, connection refs and unsupported modules', () => {
  const make = inspectMake(readFixture(fixtures.make));

  assert.equal(make.name, 'Lead intake');
  assert.deepEqual(make.modules.map((entry) => entry.module), [
    'gateway:CustomWebHook',
    'http:ActionSendData',
    'builtin:BasicFilter',
    'google-sheets:addRow',
    'slack:sendMessage',
    'builtin:BasicRouter',
    'code:ExecuteCode',
  ]);
  assert.equal(make.routeCount, 1);
  assert.equal(make.modules.at(-1)!.branch, 'main/route1');
  assert.deepEqual(make.connectionIds, [98765, 12345]);
  assert.deepEqual(make.refs, ['1', '2']);
  assert.deepEqual(make.unsupported.map((entry) => entry.module), ['slack:sendMessage', 'code:ExecuteCode']);
});

test('Zapier fixture: step graph orders by parent_id, keeps mappings and reports unsupported apps', () => {
  const [zap] = inspectZapier(readFixture(fixtures.zapier));
  assert.ok(zap);
  assert.equal(zap.title, 'Lead intake');
  assert.deepEqual(zap.steps.map((step) => step.selectedApi), [
    'WebHookAPI',
    'GoogleSheetsV2API',
    'FilterAPI',
    'SlackAPI',
    'CodeAPI',
    'AirtableAPI',
  ]);
  assert.deepEqual(zap.unsupported.map((step) => step.selectedApi), ['CodeAPI', 'AirtableAPI']);
  assert.deepEqual(zap.authRefs, ['GoogleSheetsV2API:123456', 'SlackAPI:-', 'AirtableAPI:987654']);
  assert.deepEqual(zap.mappingRefs.sort(), ['1__email', '1__name']);
});
