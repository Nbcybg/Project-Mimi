# OpenAPI import (MVP)

`packages/core/src/connectors/openapi.ts` turns an OpenAPI 3.x document into a
`ConnectorSpec` draft plus a human-readable report. Parsing is offline: the
parser never calls a server, never writes credentials, and never registers the
draft in the connector registry. The app's import flow (below) stores and
registers a checked draft.

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
- Every operation is marked `untrustedInput: true`.
- `importOpenApi` returns data only. No network request is made; persisting is
  the job of the import store (see "Importing in the app").

These options exist for tests and local development. Do not enable them for
documents from an untrusted source; the app's import never does.

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
- Pagination is inferred only for GET operations that look like lists (an array
  response or `x-mimi-items-path`) and use common names: `page` plus a size
  parameter (`per_page`, `pageSize`, `limit`, …), or a cursor/page token plus a
  next path (`nextPageToken`, `nextCursor`, `paging.next`, `links.next`, …).
  Anything more unusual must be added by hand.
- Rate limits are read only from the `x-mimi-rate-limit` extension
  (`{ requests, perMs, burst? }`); OpenAPI has no standard rate-limit field.
- Triggers are still not derived from OpenAPI documents, and response
  `itemsPath` inference beyond `x-mimi-items-path` is not done.

## Importing in the app

Hub > Node & Tools > **+ นำเข้า OpenAPI** sends the document to the core, which
previews it, and on confirm stores and registers it. The parser above is shared;
`packages/core/src/connectors/imported.ts` adds the store and the checks.

### Messages

| Client | Meaning |
| --- | --- |
| `connector-import-preview` `{ source, key?, label?, replace?, reqId? }` | Parse and check; nothing is written. |
| `connector-import-save` (same fields) | Check again, then store and register. `replace: true` overwrites an earlier import with the same key. |
| `connector-import-delete` `{ key, reqId? }` | Remove an imported connector, its tools and its file. |

Each answer is `connector-import-report` `{ reqId, action, saved, key?, report?, errors }`.
`report` (`ConnectorImportReportView`) lists server, auth, operations with
risk, tool names, unsupported parts, warnings and whether saving replaces an
earlier import. `errors` says why the document was refused; when it is not
empty nothing changed. A save broadcasts `tools` and `connector-connections`.

### What the server accepts

- JSON text only (YAML is refused; convert it first), at most 2 MB.
- `allowHttp` / `allowLocal` are never set: the server must be absolute https
  and not localhost, a private, link-local or metadata address.
- The key may not be one of the 50 native connector keys, and the generated
  tool names (`<key>_<operation>`) may not collide with any existing tool.
- At most 50 imported connectors and 200 operations per connector.

### Trust settings that are always applied

`hardenImported` runs on every import and again on every file read at start-up,
so a hand-edited file cannot relax them:

- `category: 'imported'` and the default version (an import never shadows a
  native connector version).
- Risk from the method: `GET` = read, `DELETE` = delete, everything else =
  write. `confirmPhrase` is dropped.
- `untrustedInput: true` on every operation: an API response is third-party
  text, so an agent cannot hold an imported tool together with a shell tool.
- Operation paths must be relative to the connector's server (no absolute
  URLs), and triggers are dropped.
- `auth.extra` keeps only `header`, `prefix`, `location` and `queryNames`, so an
  import can never borrow the Google account tokens (`provider`). Auth field
  defaults are removed; credentials always come from Hub > Accounts.

The connector runtime's own SSRF guard (DNS check against private addresses on
every request) still applies.

### Storage

`user/connectors/imported/<key>.json`:

```json
{ "format": 1, "importedAt": "…", "title": "Pet Store", "apiVersion": "1.0.0", "spec": { … } }
```

Files are written to a temporary name and renamed. At start-up the core loads
them after the 50 native specs; a file that is not JSON, is too large, has a
name that does not match its key, uses a native key, fails the checks or whose
tools clash is skipped with a log line (`imported connector skipped: …`) and
the core starts normally. The native catalog stays at 50.

Removing a connector does not remove its connections from Hub > Accounts, and
agents that list its tools must drop them (an unknown tool is a config error).
