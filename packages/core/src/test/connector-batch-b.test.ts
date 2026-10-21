import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import type { ConnectorAuthResolver } from '../connectors/types.ts';
import { fakeFetch, fixtureBody } from './helpers/fake-fetch.ts';

const registry = new ConnectorRegistry(connectorSpecs);
const tokenAuth: ConnectorAuthResolver = {
  resolve(connector) {
    const spec = registry.get(connector);
    const field = spec?.auth.fields[0];
    return spec?.auth.kind === 'oauth2'
      ? { accessToken: 'access-token-test' }
      : field
        ? { [field.key]: 'token-test' }
        : {};
  },
};

type Input = Record<string, unknown>;

const samples: Record<string, Record<string, Input>> = {
  google_tasks: {
    list_tasklists: {},
    list_tasks: { tasklist: '@default' },
    create_task: { tasklist: '@default', title: 'Call back' },
    complete_task: { tasklist: '@default', task: 'task1' },
  },
  google_forms: {
    get_form: { formId: 'form1' },
    list_responses: { formId: 'form1' },
    create_form: { title: 'Lead form' },
    get_response: { formId: 'form1', responseId: 'response1' },
  },
  hubspot: {
    search_contacts: { query: 'ada' },
    create_contact: { properties: { email: 'ada@example.com' } },
    list_deals: {},
    create_deal: { properties: { dealname: 'New deal' } },
    list_tickets: {},
    update_contact: { contactId: '1', properties: { firstname: 'Ada' } },
  },
  stripe: {
    list_customers: {},
    create_customer: { email: 'ada@example.com' },
    list_payments: {},
    create_payment_link: { priceId: 'price_1' },
    refund_payment: { paymentIntent: 'pi_1', amount: 100, reason: 'requested_by_customer' },
  },
  github: {
    list_repos: {},
    get_file: { owner: 'octo', repo: 'hello', path: 'README.md' },
    create_issue: { owner: 'octo', repo: 'hello', title: 'Bug' },
    list_issues: { owner: 'octo', repo: 'hello' },
    create_comment: { owner: 'octo', repo: 'hello', issueNumber: 1, body: 'thanks' },
    update_issue: { owner: 'octo', repo: 'hello', issueNumber: 1, state: 'closed' },
  },
};

function expectedPath(spec: ConnectorSpec, operation: ConnectorSpec['operations'][number], input: Input): string {
  const path = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => encodeURIComponent(String(input[key])));
  return new URL(`${spec.baseUrl!.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`).pathname;
}

for (const [service, cases] of Object.entries(samples)) {
  test(`batch B: ${service} operations reach the right endpoint`, async () => {
    const spec = registry.get(service)!;
    const api = fakeFetch(() => Response.json(fixtureBody()));
    const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });
    for (const [operationKey, input] of Object.entries(cases)) {
      const operation = spec.operations.find((entry) => entry.key === operationKey);
      assert.ok(operation, `${service}.${operationKey} exists`);
      await runtime.execute({ connector: service, operation: operationKey, input });
      const call = api.calls.at(-1)!;
      assert.equal(call.method, operation.method, `${service}.${operationKey} method`);
      assert.equal(new URL(call.url).pathname, expectedPath(spec, operation, input), `${service}.${operationKey} path`);
      const expectedToken = spec.auth.kind === 'oauth2' ? 'access-token-test' : 'token-test';
      const prefix = typeof spec.auth.extra?.prefix === 'string' ? spec.auth.extra.prefix : 'Bearer ';
      assert.equal(call.headers.get('authorization'), `${prefix}${expectedToken}`, `${service}.${operationKey} auth`);
    }
    assert.equal(api.calls.length, Object.keys(cases).length);
  });
}

test('batch B: Google OAuth, Stripe form encoding and GitHub headers', async () => {
  const api = fakeFetch(() => Response.json(fixtureBody()));
  const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });

  await runtime.execute({ connector: 'google_tasks', operation: 'list_tasks', input: { tasklist: '@default' } });
  assert.equal(api.calls[0]!.headers.get('authorization'), 'Bearer access-token-test');
  assert.equal(new URL(api.calls[0]!.url).searchParams.get('showCompleted'), 'true');

  await runtime.execute({
    connector: 'stripe',
    operation: 'create_payment_link',
    input: { priceId: 'price_1', quantity: '2', metadata: { tier: 'pro' } },
  });
  assert.equal(api.calls[1]!.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(api.calls[1]!.body!);
  assert.equal(form.get('line_items[0][price]'), 'price_1');
  assert.equal(form.get('line_items[0][quantity]'), '2');
  assert.equal(form.get('metadata[tier]'), 'pro');

  await runtime.execute({ connector: 'github', operation: 'list_issues', input: { owner: 'octo', repo: 'hello' } });
  assert.equal(api.calls[2]!.headers.get('accept'), 'application/vnd.github+json');
  assert.equal(api.calls[2]!.headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(new URL(api.calls[2]!.url).searchParams.get('state'), 'open');
});
