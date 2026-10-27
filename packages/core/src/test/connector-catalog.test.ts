import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import { connectorTools } from '../connectors/tool-adapter.ts';
import { makeTestCore } from './core-helpers.ts';

/** Phase 3 catalog checks: the 50 installed services, their auth and their tool names. */

const registry = new ConnectorRegistry(connectorSpecs);
const tools = connectorTools(registry, new ConnectorRuntimeImpl({ registry, auth: { resolve: () => undefined } }));

test('catalog: fifty services have unique keys, labels and metadata', () => {
  assert.equal(connectorSpecs.length, 50);
  assert.equal(new Set(connectorSpecs.map((spec) => spec.key)).size, 50, 'unique keys');
  assert.equal(new Set(connectorSpecs.map((spec) => spec.label)).size, 50, 'unique labels (Quick Work families)');
  for (const spec of connectorSpecs) {
    assert.match(spec.key, /^[a-z][a-z0-9_]*$/, `${spec.key} is lower snake case`);
    assert.ok(spec.label && spec.category && spec.description, `${spec.key} has metadata`);
    assert.ok(spec.operations.length > 0, `${spec.key} has operations`);
    assert.equal(new Set(spec.operations.map((operation) => operation.key)).size, spec.operations.length, `${spec.key} operation keys are unique`);
    for (const operation of spec.operations) {
      assert.match(operation.key, /^[a-z][a-z0-9_]*$/, `${spec.key}.${operation.key} is lower snake case`);
      assert.equal(new Set(operation.fields.map((field) => field.key)).size, operation.fields.length, `${spec.key}.${operation.key} field keys are unique`);
    }
    assert.equal(new Set((spec.triggers ?? []).map((trigger) => trigger.key)).size, (spec.triggers ?? []).length, `${spec.key} trigger keys are unique`);
  }
});

test('catalog: every service declares usable required auth and never a default secret', () => {
  const kinds = new Set(['oauth2', 'oauth1', 'apiKey', 'basic', 'bearer', 'none']);
  for (const spec of connectorSpecs) {
    assert.ok(kinds.has(spec.auth.kind), `${spec.key} auth kind`);
    assert.equal(new Set(spec.auth.fields.map((field) => field.key)).size, spec.auth.fields.length, `${spec.key} auth field keys are unique`);
    for (const field of spec.auth.fields) {
      assert.ok(field.label, `${spec.key}.${field.key} has a label`);
      assert.equal(field.default, undefined, `${spec.key}.${field.key} stores no default`);
      if (field.type === 'secret') assert.ok(!field.options && !field.optionsFrom, `${spec.key}.${field.key} secret is free text`);
    }
    const secrets = spec.auth.fields.filter((field) => field.type === 'secret');

    if (spec.auth.kind === 'none') {
      assert.equal(spec.auth.fields.length, 0, `${spec.key} needs no credential`);
      continue;
    }
    if (spec.auth.kind === 'oauth2') {
      assert.match(spec.auth.authorizeUrl ?? '', /^https:\/\//, `${spec.key} authorize url`);
      assert.match(spec.auth.tokenUrl ?? '', /^https:\/\//, `${spec.key} token url`);
      assert.ok((spec.auth.scopes?.length ?? 0) > 0, `${spec.key} scopes`);
      if (spec.auth.extra?.provider === 'google') {
        assert.equal(spec.auth.fields.length, 0, `${spec.key} signs in with a Google account`);
        continue;
      }
      for (const key of ['clientId', 'clientSecret', 'refreshToken']) {
        assert.ok(spec.auth.fields.some((field) => field.key === key), `${spec.key} has ${key}`);
      }
    }
    assert.ok(spec.auth.fields.length > 0, `${spec.key} lists its credential fields`);
    assert.ok(spec.auth.fields.some((field) => field.required !== false), `${spec.key} has a required field`);

    if (spec.auth.kind === 'apiKey' || spec.auth.kind === 'bearer') {
      assert.ok(secrets.length > 0, `${spec.key} has a secret token field`);
    }
    if (spec.auth.kind === 'basic') {
      assert.ok(secrets.some((field) => field.key === 'password'), `${spec.key} has a secret password field`);
    }
  }
});

test('catalog: every operation makes one prefixed tool with a risk level', () => {
  const expected = connectorSpecs.reduce((total, spec) => total + spec.operations.length, 0);
  assert.equal(tools.length, expected);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, 'tool names are unique');
  for (const tool of tools) {
    assert.equal(tool.name, `${tool.connector}_${tool.operation}`, `${tool.name} prefix`);
    assert.ok(['read', 'write', 'delete', 'shell', 'network'].includes(tool.risk), `${tool.name} risk`);
  }
  assert.equal(registry.toolNames().length, tools.length);
  assert.equal(new Set(registry.toolNames()).size, tools.length);
});

test('catalog: no connector tool shadows a builtin tool', async () => {
  const target = await makeTestCore({});
  try {
    const views = target.core.tools.views();
    const connectors = views.filter((view) => view.connector);
    const builtins = views.filter((view) => !view.connector && !view.mcp);
    const mcp = views.filter((view) => view.mcp);
    assert.equal(connectors.length, 214);
    assert.ok(builtins.length > 0, 'the core registers builtin tools');
    assert.equal(new Set(builtins.map((view) => view.name)).size, builtins.length, 'builtin names are unique');
    const names = new Set(builtins.map((view) => view.name));
    for (const tool of tools) assert.ok(!names.has(tool.name), `${tool.name} shadows a builtin tool`);
    assert.equal(target.core.tools.names().length, connectors.length + builtins.length + mcp.length, 'no tool is lost to a silent overwrite');
    assert.equal(target.core.connectors.list().length, 50);
  } finally {
    await target.cleanup();
  }
});
