import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { importOpenApi } from '../connectors/openapi.ts';
import { ConnectorRegistry } from '../connectors/registry.ts';

function fixture(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'fixtures/openapi', name), 'utf8');
}

function bearer(document: Record<string, unknown>, scheme: Record<string, unknown>): ConnectorSpec {
  const spec = {
    ...document,
    components: { securitySchemes: { auth: scheme } },
    security: [{ auth: [] }],
  };
  return importOpenApi(spec).spec;
}

const document: Record<string, unknown> = {
  openapi: '3.0.3',
  info: { title: 'Auth API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/items': {
      get: {
        operationId: 'listItems',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

test('openapi: petstore YAML becomes a valid connector draft', () => {
  const { spec, report } = importOpenApi(fixture('petstore.yaml'));

  assert.equal(spec.key, 'pet_store');
  assert.equal(spec.label, 'Pet Store');
  assert.equal(spec.baseUrl, 'https://petstore.example.com/v1');
  assert.equal(spec.auth.kind, 'apiKey');
  assert.deepEqual(spec.auth.extra, { header: 'X-API-Key', prefix: '' });
  assert.deepEqual(report.security, ['apiKey "X-API-Key" in header']);
  assert.deepEqual(
    report.operations.map((operation) => operation.key),
    ['list_pets', 'create_pet', 'get_pet', 'delete_pet'],
  );

  const list = spec.operations.find((operation) => operation.key === 'list_pets');
  assert.ok(list);
  assert.equal(list.method, 'GET');
  assert.deepEqual(list.fields.map((field) => field.key), ['limit', 'status']);
  assert.equal(list.fields[0]!.type, 'number');
  assert.deepEqual(list.fields[1]!.options, [
    { value: 'available', label: 'available' },
    { value: 'sold', label: 'sold' },
  ]);

  const create = spec.operations.find((operation) => operation.key === 'create_pet');
  assert.ok(create);
  assert.equal(create.bodyFormat, 'json');
  assert.deepEqual(create.fields.map((field) => [field.key, field.required]), [
    ['name', true],
    ['tag', false],
    ['vaccinated', false],
    ['age', false],
    ['metadata', false],
  ]);
  assert.equal(create.fields[2]!.type, 'boolean');
  assert.equal(create.fields[4]!.type, 'json');

  const remove = spec.operations.find((operation) => operation.key === 'delete_pet');
  assert.ok(remove);
  assert.equal(remove.method, 'DELETE');
  assert.deepEqual(remove.fields.map((field) => field.key), ['petId']);

  assert.doesNotThrow(() => new ConnectorRegistry([spec]));
});

test('openapi: unsupported parameters, security and schemas are reported', () => {
  const { spec, report } = importOpenApi(fixture('unsupported.yaml'));

  assert.equal(spec.auth.kind, 'none');
  assert.equal(spec.operations.length, 2);
  assert.equal(spec.operations[0]!.key, 'upload_file');
  assert.deepEqual(spec.operations[0]!.fields, []);
  assert.equal(spec.operations[1]!.key, 'create_thing');
  assert.deepEqual(spec.operations[1]!.response, { binary: true });

  const reasons = report.unsupported.map((issue) => `${issue.where}: ${issue.reason}`);
  assert.ok(reasons.some((entry) => entry.includes('cookie parameters')));
  assert.ok(reasons.some((entry) => entry.includes('optional header parameters')));
  assert.ok(reasons.some((entry) => entry.includes('only JSON and form-urlencoded bodies')));
  assert.ok(reasons.some((entry) => entry.includes('combined schemas')));
  assert.ok(reasons.some((entry) => entry.includes('apiKey in "cookie"')));
});

test('openapi: JSON input and key overrides work', () => {
  const { spec } = importOpenApi(JSON.stringify(document), {
    key: 'my_api',
    label: 'My API',
    category: 'custom',
  });
  assert.equal(spec.key, 'my_api');
  assert.equal(spec.label, 'My API');
  assert.equal(spec.category, 'custom');
  assert.equal(spec.operations[0]!.key, 'list_items');
});

test('openapi: maps apiKey query, basic, bearer and oauth2 auth', () => {
  const query = bearer(document, { type: 'apiKey', in: 'query', name: 'api_key' });
  assert.equal(query.auth.kind, 'apiKey');
  assert.deepEqual(query.auth.extra, { location: 'query', queryNames: { apiKey: 'api_key' } });

  const basic = bearer(document, { type: 'http', scheme: 'basic' });
  assert.equal(basic.auth.kind, 'basic');
  assert.deepEqual(basic.auth.fields.map((field) => field.type), ['string', 'secret']);

  const http = bearer(document, { type: 'http', scheme: 'bearer' });
  assert.equal(http.auth.kind, 'bearer');
  assert.equal(http.auth.fields[0]!.key, 'token');

  const oauth = bearer(document, {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: { read: 'Read items' },
      },
    },
  });
  assert.equal(oauth.auth.kind, 'oauth2');
  assert.deepEqual(oauth.auth.scopes, ['read']);
  assert.equal(oauth.auth.authorizeUrl, 'https://auth.example.com/authorize');

  const incomplete = importOpenApi({
    ...document,
    components: { securitySchemes: { auth: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token' } } } } },
    security: [{ auth: [] }],
  });
  assert.equal(incomplete.spec.auth.kind, 'bearer');
  assert.ok(incomplete.report.warnings.some((warning) => warning.includes('bearer token field')));
});

test('openapi: unsafe servers are rejected unless explicitly allowed', () => {
  const source = fixture('insecure-server.yaml');
  assert.throws(() => importOpenApi(source), /must use https/);
  assert.throws(() => importOpenApi(source, { allowHttp: true }), /local server/);
  const allowed = importOpenApi(source, { allowHttp: true, allowLocal: true });
  assert.equal(allowed.spec.baseUrl, 'http://localhost:3000/api');

  const httpsLocal = fixture('insecure-server.yaml').replace('http://localhost:3000', 'https://localhost:3000');
  assert.throws(() => importOpenApi(httpsLocal), /local server/);
  assert.equal(importOpenApi(httpsLocal, { allowLocal: true }).spec.baseUrl, 'https://localhost:3000/api');

  for (const host of ['192.168.1.20', '10.0.0.5', '169.254.169.254', '[::1]']) {
    const privateServer = fixture('insecure-server.yaml').replace('http://localhost:3000', `https://${host}`);
    assert.throws(() => importOpenApi(privateServer), /local server/, host);
  }

  const credentials = fixture('insecure-server.yaml').replace('http://localhost:3000', 'https://user:pass@api.example.com');
  const unsafe = importOpenApi(credentials);
  assert.equal(unsafe.spec.baseUrl, undefined);
  assert.ok(unsafe.report.unsupported.some((issue) => issue.reason.includes('credentials')));
});

test('openapi: invalid documents fail', () => {
  assert.throws(() => importOpenApi(fixture('invalid-swagger.yaml')), /OpenAPI 3\.x/);
  assert.throws(() => importOpenApi('not: [valid'), /could not parse/);
  assert.throws(() => importOpenApi({ openapi: '3.0.0', info: { title: 'No paths', version: '1' } }), /paths is required/);
  assert.throws(
    () =>
      importOpenApi({
        openapi: '3.0.0',
        info: { title: 'Empty', version: '1' },
        paths: { '/x': { parameters: [] } },
      }),
    /no supported operations/,
  );
});

test('openapi: auth fields never carry values', () => {
  const { spec } = importOpenApi(fixture('petstore.yaml'));
  for (const field of spec.auth.fields) {
    assert.equal(field.default, undefined);
    assert.equal(field.type, 'secret');
  }
  assert.equal(JSON.stringify(spec).includes('X-API-Key-secret-value'), false);
});
