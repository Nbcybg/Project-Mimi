# OpenAPI import (MVP)

`packages/core/src/connectors/openapi.ts` turns an OpenAPI 3.x document into a
`ConnectorSpec` draft plus a human-readable report. Importing is offline: the
parser never calls a server, never writes credentials, and never registers the
draft in the connector registry.

```ts
import { importOpenApi } from './connectors/openapi.ts';

const { spec, report } = importOpenApi(yamlOrJson, {
  key: 'pet_store',        // optional; derived from info.title
  label: 'Pet Store',      // optional
  category: 'imported',    // optional
  allowHttp: false,        // http server URLs are rejected by default
  allowLocal: false,       // localhost / 127.x / ::1 are rejected by default
  validate: true,          // run ConnectorRegistry validation before returning
});
```

Input can be a JSON string, a YAML string, or an already parsed object.
Swagger 2.0 is rejected.

## What is mapped

- `info.title`, `info.version`, `info.description`
- `servers[0].url` plus server variable defaults
- `paths` and `get`, `post`, `put`, `patch`, `delete`
- Operation key from `operationId`, otherwise `<method>_<path>`
- Path-level and operation-level parameters
  - `path` and `query` become fields
  - required `header` parameters become fields wired through `operation.headers`
  - duplicate parameter keys are reported
- JSON request bodies and object properties
  - required properties become required fields
  - `string`, `number`, `integer`, `boolean`, object and array types
  - enums become `select` fields
  - nested objects and arrays become `json` fields
- `application/x-www-form-urlencoded` bodies via `bodyFormat: 'form'`
- First 2xx JSON response
  - array response: the whole body becomes items
  - object response: `x-mimi-items-path` selects the item array
  - non-JSON download responses set `response.binary`
- Security requirement at the document root
  - `apiKey` in header or query
  - `http` basic and bearer
  - `oauth2` authorization-code flow with both URLs
- Query parameters on write operations are listed in `operation.query`, so the
  runtime keeps them in the URL instead of the JSON body.

Every field with an enum becomes a select, and primitive schema defaults or
examples become field defaults. Secret values are never imported: auth fields
are declarations only and always resolve from the vault at runtime.

## Safety

- HTTPS is required unless `allowHttp` is explicitly true.
- Local hosts (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) and other private,
  link-local or metadata IP literals are rejected unless `allowLocal` is true.
- Server URLs containing username or password are rejected.
- External `$ref` values are rejected; only local `#/...` references are read.
- Import returns data only. No network request is made and no spec is persisted.

These options exist for tests and local development. Do not enable them for
documents from an untrusted source.

## Report

```ts
interface OpenApiImportReport {
  title: string;
  version: string;
  server?: string;
  operations: Array<{ key: string; label: string; method: string; path: string }>;
  unsupported: Array<{ where: string; reason: string }>;
  warnings: string[];
  security: string[];
}
```

`unsupported` names the operation, parameter, body property, security scheme or
server field that could not be represented. Imported operations keep going when
one field fails, so users can review the report and add missing pieces by hand.

## Limitations (MVP)

- Swagger 2.0, `openIdConnect`, mutual TLS and cookie auth are not supported.
- `oneOf`, `anyOf`, `allOf`, external `$ref`, multipart bodies and top-level
  array bodies are reported and skipped.
- Optional header parameters are not imported because the runtime cannot send a
  header conditionally.
- Only one security scheme is represented per connector. A requirement that
  combines schemes is reported and the first scheme is used.
- OAuth2 without a complete authorization-code flow is imported as a bearer
  access-token field, with a warning.
- Pagination, rate limits, triggers and response `itemsPath` inference beyond
  `x-mimi-items-path` are not derived from OpenAPI documents.
- Imported specs are drafts. They are not written into the built-in services or
  exposed in the app until a persistence/registration flow is added.
