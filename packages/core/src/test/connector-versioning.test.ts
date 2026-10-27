import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectorRequest, ConnectorSpec, WorkflowView } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { type WorkflowRunnerDeps, WorkflowState, runWorkflow } from '../workflows/runner.ts';

function spec(version: string, operation = 'read', operationPath = `/v${version}/read`): ConnectorSpec {
  return {
    key: 'demo',
    version,
    label: 'Demo',
    category: 'test',
    description: 'Versioned test connector',
    baseUrl: 'https://api.example.test',
    auth: { kind: 'none', fields: [] },
    operations: [{
      key: operation,
      label: operation,
      method: 'GET',
      path: operationPath,
      fields: [],
      risk: 'read',
    }],
  };
}

function runtime(specs: ConnectorSpec[], urls: string[]): ConnectorRuntimeImpl {
  const fetchFn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ items: [{ id: '1' }] });
  }) as typeof fetch;
  return new ConnectorRuntimeImpl({ registry: new ConnectorRegistry(specs), fetchFn });
}

test('registry: keeps versions, chooses latest by semver and rejects duplicates', () => {
  const registry = new ConnectorRegistry([spec('1.0.0'), spec('1.10.0'), spec('1.2.0')]);
  assert.deepEqual(registry.versions('demo'), ['1.10.0', '1.2.0', '1.0.0']);
  assert.equal(registry.get('demo')?.version, '1.10.0');
  assert.equal(registry.get('demo', '1.2.0')?.version, '1.2.0');
  assert.equal(registry.get('demo', '9.9.9'), undefined);
  assert.deepEqual(registry.list().map((entry) => entry.version), ['1.10.0']);
  assert.deepEqual(registry.listAll().map((entry) => entry.version).sort(), ['1.0.0', '1.10.0', '1.2.0']);
  assert.deepEqual(registry.toolNames(), ['demo_read']);
  assert.deepEqual(registry.views()[0]?.versions, ['1.10.0', '1.2.0', '1.0.0']);
  assert.throws(() => registry.register(spec('1.10.0')), /already registered/);
  assert.throws(() => registry.register(spec('latest')), /semver/);
});

test('runtime: a pinned workflow keeps its old version after a connector update', async () => {
  const urls: string[] = [];
  const client = runtime([spec('1.0.0'), spec('2.0.0')], urls);

  const pinned = await client.execute({ connector: 'demo', operation: 'read', input: {}, version: '1.0.0' });
  assert.equal(urls.at(-1), 'https://api.example.test/v1.0.0/read');
  assert.equal(pinned.version, '1.0.0');
  assert.equal(pinned.deprecated, true);
  assert.equal(pinned.latestVersion, '2.0.0');

  const latest = await client.execute({ connector: 'demo', operation: 'read', input: {} });
  assert.equal(urls.at(-1), 'https://api.example.test/v2.0.0/read');
  assert.equal(latest.version, '2.0.0');
  assert.equal(latest.deprecated, undefined);

  await assert.rejects(
    () => client.execute({ connector: 'demo', operation: 'read', input: {}, version: '3.0.0' }),
    /version "3\.0\.0" is not installed.*1\.0\.0, 2\.0\.0|Installed versions/,
  );
});

test('runtime: an operation removed from the latest version stays usable when pinned', async () => {
  const urls: string[] = [];
  const client = runtime([spec('1.0.0', 'read'), spec('3.0.0', 'new_read', '/v3/new')], urls);
  const pinned = await client.execute({ connector: 'demo', operation: 'read', input: {}, version: '1.0.0' });
  assert.equal(pinned.items.length, 1);
  await assert.rejects(
    () => client.execute({ connector: 'demo', operation: 'read', input: {} }),
    /demo" v3\.0\.0 has no operation "read"/,
  );
});

test('workflow runner: the connector node sends its pinned version and records it', async () => {
  const requests: ConnectorRequest[] = [];
  const registry = new ConnectorRegistry([spec('1.0.0'), spec('2.0.0')]);
  const deps: WorkflowRunnerDeps = {
    runAgent: async () => '',
    tool: () => undefined,
    connector: {
      get: (key, version) => registry.get(key, version),
      execute: async (request) => {
        requests.push(request);
        return { items: [], text: 'ok', version: '1.0.0', deprecated: true, latestVersion: '2.0.0' };
      },
    },
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(os.tmpdir(), `mimi-version-${process.pid}-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [],
  };
  const flow: WorkflowView = {
    name: 'pinned',
    agent: 'mimi',
    title: 'Pinned',
    description: '',
    enabled: true,
    trigger: { pool: 'manual', config: {} },
    webhook: null,
    nodes: [{
      id: 'n1',
      type: 'connector',
      title: 'read',
      config: { connector: 'demo', operation: 'read', version: '1.0.0' },
      links: { main: [] },
    }],
  };
  const run = await runWorkflow(flow, [{ json: {} }], deps);
  assert.equal(run.ok, true, run.result);
  assert.equal(requests[0]?.version, '1.0.0');
  assert.equal(run.nodes[0]?.trace?.connectorVersion, '1.0.0');
  assert.equal(run.nodes[0]?.trace?.deprecated, true);
  assert.equal(run.nodes[0]?.trace?.latestVersion, '2.0.0');
});
