import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONNECTOR_CONTRACT_VERSION,
  NODE_TYPES,
  type ConnectorField,
  type ConnectorSpec,
  type ConnectorView,
  type ToolSettingField,
  type ToolView,
  type WorkflowNode,
} from '@mimi/shared';

const channelField: ConnectorField = {
  key: 'channel',
  label: 'channel',
  type: 'select',
  required: true,
  optionsFrom: { connector: 'slack', operation: 'list_channels', labelField: 'name', valueField: 'id' },
};

const slack: ConnectorSpec = {
  key: 'slack',
  label: 'Slack',
  category: 'communication',
  description: 'ส่งข้อความและอ่านประวัติช่องของ Slack workspace',
  baseUrl: 'https://slack.com/api',
  auth: {
    kind: 'apiKey',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        type: 'secret',
        required: true,
        placeholder: 'xoxb-…',
        description: 'สร้างที่ Slack app → OAuth & Permissions',
      },
    ],
    scopes: ['chat:write', 'channels:read', 'channels:history'],
  },
  operations: [
    {
      key: 'send_message',
      label: 'ส่งข้อความ',
      description: 'ส่งข้อความเข้า channel ด้วย bot',
      method: 'POST',
      path: '/chat.postMessage',
      risk: 'write',
      fields: [channelField, { key: 'text', label: 'ข้อความ', type: 'string', required: true }],
      response: { itemsPath: 'message' },
    },
    {
      key: 'list_channels',
      label: 'ดูรายชื่อ channel',
      method: 'GET',
      path: '/conversations.list',
      risk: 'read',
      fields: [{ key: 'limit', label: 'จำนวน', type: 'number', default: 100 }],
      response: { itemsPath: 'channels' },
    },
    {
      key: 'list_messages',
      label: 'อ่านข้อความใน channel',
      method: 'GET',
      path: '/conversations.history',
      risk: 'read',
      untrustedInput: true,
      fields: [channelField, { key: 'limit', label: 'จำนวน', type: 'number', default: 50 }],
      response: { itemsPath: 'messages' },
    },
  ],
  triggers: [{ key: 'events', label: 'Slack Events', kind: 'webhook', events: ['message.channels', 'app_mention'] }],
  pagination: { mode: 'cursor', cursorParam: 'cursor', nextPath: 'response_metadata.next_cursor', itemsPath: 'channels' },
  rateLimit: { requests: 1, perMs: 1000, burst: 1 },
};

/** Mirrors what the runtime will send to the web client: metadata only, no credentials. */
function viewOf(spec: ConnectorSpec, connected = false): ConnectorView {
  return {
    key: spec.key,
    label: spec.label,
    category: spec.category,
    description: spec.description,
    ...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }),
    auth: {
      kind: spec.auth.kind,
      fields: spec.auth.fields,
      ...(spec.auth.scopes === undefined ? {} : { scopes: spec.auth.scopes }),
      ...(spec.auth.authorizeUrl === undefined ? {} : { authorizeUrl: spec.auth.authorizeUrl }),
      connected,
    },
    operations: spec.operations.map((operation) => ({
      key: operation.key,
      label: operation.label,
      ...(operation.description === undefined ? {} : { description: operation.description }),
      method: operation.method,
      path: operation.path,
      fields: operation.fields,
      risk: operation.risk,
      ...(operation.untrustedInput === undefined ? {} : { untrustedInput: operation.untrustedInput }),
      ...(operation.response === undefined ? {} : { response: operation.response }),
    })),
    ...(spec.triggers === undefined ? {} : { triggers: spec.triggers }),
    ...(spec.pagination === undefined ? {} : { pagination: spec.pagination }),
    ...(spec.rateLimit === undefined ? {} : { rateLimit: spec.rateLimit }),
  };
}

test('connector contract version is frozen at 1', () => {
  assert.equal(CONNECTOR_CONTRACT_VERSION, 1);
});

test('connector spec: unique keys, valid tool names and complete references', () => {
  assert.match(slack.key, /^[a-z][a-z0-9_]*$/);
  assert.equal(slack.auth.kind, 'apiKey');

  const operationKeys = new Set<string>();
  for (const operation of slack.operations) {
    assert.ok(!operationKeys.has(operation.key), `duplicate operation ${operation.key}`);
    operationKeys.add(operation.key);
    assert.match(`${slack.key}_${operation.key}`, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/);
    if (!/^https?:\/\//.test(operation.path)) assert.ok(operation.path.startsWith('/'));

    const fieldKeys = new Set<string>();
    for (const field of operation.fields) {
      assert.ok(!fieldKeys.has(field.key), `duplicate field ${field.key}`);
      fieldKeys.add(field.key);
      if (field.type === 'select') assert.ok(field.options || field.optionsFrom, `select ${field.key} has no choices`);
      if (field.optionsFrom) {
        assert.ok(
          slack.operations.some((candidate) => candidate.key === field.optionsFrom!.operation),
          `optionsFrom points at an unknown operation: ${field.optionsFrom.operation}`,
        );
      }
    }
  }

  assert.ok(slack.triggers?.some((trigger) => trigger.kind === 'webhook'));
  assert.equal(slack.pagination?.mode, 'cursor');
  assert.ok((slack.rateLimit?.requests ?? 0) > 0);
});

test('connector auth secrets are metadata only and views stay credential-free', () => {
  const token = slack.auth.fields.find((field) => field.key === 'botToken');
  assert.equal(token?.type, 'secret');
  assert.equal(token?.default, undefined);

  const view = viewOf(slack);
  assert.equal(view.auth.connected, false);
  for (const field of view.auth.fields) {
    if (field.type === 'secret') assert.equal(field.default, undefined);
  }
  assert.doesNotMatch(JSON.stringify(view), /xoxb-[A-Za-z0-9-]{8,}/);
  assert.equal(view.operations.length, slack.operations.length);
  assert.equal(view.operations.find((operation) => operation.key === 'list_messages')?.untrustedInput, true);
});

test('workflow uses one generic connector node type with no service-specific fields', () => {
  const matching = NODE_TYPES.filter((nodeType) => nodeType.type === 'connector');
  assert.equal(matching.length, 1);
  const nodeType = matching[0]!;
  assert.deepEqual(nodeType.fields.map((field) => field.key), ['connector', 'operation', 'account', 'input', 'allow']);
  assert.equal(nodeType.fields.find((field) => field.key === 'connector')?.required, true);
  assert.equal(nodeType.fields.find((field) => field.key === 'operation')?.required, true);
  assert.deepEqual(nodeType.outputs, [{ key: 'main', label: 'main' }]);
  assert.equal(NODE_TYPES.filter((nodeType) => nodeType.type.startsWith('slack')).length, 0);

  const node: WorkflowNode = {
    id: 'send_to_slack',
    type: 'connector',
    config: {
      connector: 'slack',
      operation: 'send_message',
      input: { channel: 'C01234567', text: '{{ $json.text }}' },
    },
    links: { main: [] },
  };
  assert.equal(node.type, 'connector');
});

test('ToolSettingField keeps legacy shapes and gains select options', () => {
  const legacy: ToolSettingField = { key: 'sheetId', label: 'Sheet', type: 'string', required: true };
  const account: ToolSettingField = { key: 'account', label: 'Account', type: 'account', service: 'google' };
  const select: ToolSettingField = {
    key: 'channel',
    label: 'Channel',
    type: 'select',
    required: true,
    options: [{ value: 'C01234567', label: '#general' }],
    optionsFrom: { connector: 'slack', operation: 'list_channels', labelField: 'name', valueField: 'id' },
  };

  assert.equal(legacy.type, 'string');
  assert.equal(account.service, 'google');
  assert.equal(select.options?.[0]?.value, 'C01234567');
  assert.equal(select.optionsFrom?.operation, 'list_channels');
});

test('ToolView carries connector metadata used by Quick Work families', () => {
  const tool: ToolView = {
    name: 'slack_send_message',
    description: 'ส่งข้อความ',
    risk: 'write',
    target: 'core',
    builtin: false,
    settings: [],
    connector: 'slack',
    operation: 'send_message',
    familyLabel: 'Slack',
  };

  assert.equal(`${tool.connector}_${tool.operation}`, tool.name);
  assert.equal(tool.familyLabel, 'Slack');
});
