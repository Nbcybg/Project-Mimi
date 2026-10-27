# Connector service template

Use this as a starting point for a new native connector. The frozen schema is
[`contract.md`](contract.md); this page only shows a complete data-only spec, a
registration checklist and the tests to add.

## Spec

```ts
import type { ConnectorField, ConnectorSpec } from '@mimi/shared';

const cursorField: ConnectorField = {
  key: 'cursor',
  label: 'Cursor',
  type: 'string',
  required: false,
  description: 'Opaque cursor returned by the previous page.',
};

export const acmeConnector: ConnectorSpec = {
  key: 'acme',
  version: '1.0.0',
  label: 'Acme',
  category: 'productivity',
  description: 'Read and create items in an Acme workspace.',
  baseUrl: 'https://api.acme.example/v1',
  auth: {
    kind: 'bearer',
    fields: [
      {
        key: 'token',
        label: 'API token',
        type: 'secret',
        required: true,
        placeholder: 'acme_...',
        description: 'Create a token in the Acme workspace settings.',
      },
    ],
    scopes: ['items:read', 'items:write'],
  },
  operations: [
    {
      key: 'list_items',
      label: 'List items',
      description: 'List items in the workspace.',
      method: 'GET',
      path: '/items',
      risk: 'read',
      fields: [
        { key: 'limit', label: 'Limit', type: 'number', required: false, default: 50 },
        cursorField,
      ],
      paginated: true,
      response: { itemsPath: 'data' },
    },
    {
      key: 'create_item',
      label: 'Create item',
      description: 'Create one item in the workspace.',
      method: 'POST',
      path: '/items',
      risk: 'write',
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
        { key: 'notes', label: 'Notes', type: 'string', required: false },
      ],
      body: { item: { name: '{{name}}', notes: '{{notes}}' } },
      response: { itemsPath: 'data' },
    },
  ],
  triggers: [
    {
      key: 'new_items',
      label: 'New items',
      description: 'Poll for items created since the last tick.',
      kind: 'poll',
      operation: 'list_items',
      input: { limit: 50 },
      idField: 'id',
      cursor: { responsePath: 'next', param: 'cursor' },
      sample: { id: 'sample_item', name: 'Sample item' },
    },
  ],
  pagination: {
    mode: 'cursor',
    cursorParam: 'cursor',
    itemsPath: 'data',
    nextPath: 'next',
    maxPages: 20,
    maxItems: 1000,
  },
  rateLimit: { requests: 10, perMs: 1000, burst: 10 },
};
```

This is metadata only. Do not put a request function, a token or a file path
inside a spec. The runtime adds auth, HTTP, retries, pagination, rate limiting,
timeouts and redaction.

## Register

Edit `packages/core/src/connectors/services/index.ts`:

1. `import { acmeConnector } from './acme.ts';`
2. `export { acmeConnector } from './acme.ts';`
3. Add `acmeConnector` to `connectorSpecs`.

Then restart the core. The connector becomes visible in the catalog, its
operations become `<key>_<operation>` tools, and its poll trigger becomes
`connector:acme:new_items`.

## Tests to add

Use `fakeFetch` from `packages/core/src/test/helpers/fake-fetch.ts`; no test may
call a real provider.

- Registry validation: unique key, unique tool names, every `{{field}}` in a
  body has a declared field, no secret values in views.
- Request mapping: method, path, query defaults, headers and body template.
- Response mapping: `itemsPath`, binary responses if used, and a readable
  provider error with the token removed.
- Auth: missing connection is refused; connection lookup and default account
  work; a wrong credential field is reported.
- Pagination: at least one multi-page path, including `maxPages`/`maxItems`.
- Rate limit: a simulated clock shows the expected wait, not a real sleep.
- Trigger: a poll uses `idField` and returns the cursor; a webhook verifies its
  signature if one is declared.
- Versioning: adding `1.1.0` keeps a workflow pinned to `1.0.0` on the old
  operation.
- Tool adapter: input validation, risk and `untrustedInput`.

Catalog expectations are exact: `packages/core/src/test/connector-catalog.test.ts`
and the platform tests assert 50 services and 214 operations. When adding a new
service, update those expected counts in the same change and keep the operation
count accurate.

Run:

```powershell
npm.cmd run typecheck
node --test packages/core/src/test/connector-catalog.test.ts
node --test packages/core/src/test/connector-runtime.test.ts
npm.cmd test
```

## Review checklist

- The key and every operation key are lower snake case.
- `risk` is correct: reads are `read`; writes/deletes/network effects are not.
- `untrustedInput` is set for content that may carry third-party instructions.
- Credential fields are `type: 'secret'`; no default token is provided.
- `baseUrl` is HTTPS and the host is public. The runtime guard still applies.
- Pagination cannot loop forever: bounds are set or intentionally defaulted.
- Trigger samples are synthetic and contain no personal data.
- The version is set and a future breaking change gets a new version rather than
  editing an old one in place.
