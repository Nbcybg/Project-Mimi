# Connector platform

Status: 50 native connectors / 214 operations, with workflow runs, run history,
connector versioning, guarded outbound HTTP, and n8n / Make / Zapier / OpenAPI
import helpers. The schema is frozen at contract version 1; see
[`contract.md`](contract.md).

This page is the index and the practical guide for adding or operating a
connector. The frozen contract remains the source of truth for field shapes.

## Guides

| Topic | Document |
| --- | --- |
| Schema, runtime contract, tool names | [`contract.md`](contract.md) |
| New connector template and test checklist | [`template-service.md`](template-service.md) |
| Auth kinds and the 50-service matrix | [`auth-matrix.md`](auth-matrix.md) |
| Workflow node wiring and runtime setup | [`integration.md`](integration.md) |
| Run queue, idempotency and timeouts | [`reliability.md`](reliability.md) |
| Run history, redaction and traces | [`observability.md`](observability.md) |
| Connector versions and pinned workflows | [`versioning.md`](versioning.md) |
| SSRF, redirects and credential handling | [`security-review.md`](security-review.md) |
| E2E, performance and known bottlenecks | [`performance.md`](performance.md) |
| n8n / Make / Zapier migration | [`n8n-mapping.md`](n8n-mapping.md), [`make-import.md`](make-import.md), [`zapier-import.md`](zapier-import.md) |
| Migration dialog | [`migration-ui.md`](migration-ui.md) |
| OpenAPI drafts | [`openapi-import.md`](openapi-import.md) |
| Release gate | [`release-checklist.md`](release-checklist.md) |

## Add a connector

1. Copy the shape from [`template-service.md`](template-service.md).
2. Add one file under `packages/core/src/connectors/services/` named after the
   lower-snake key, for example `acme_crm.ts`, exporting `acmeCrmConnector`.
   A spec is data only: no `fetch`, no storage, no secrets and no side effects.
3. Register it in `packages/core/src/connectors/services/index.ts`:
   import it, export it, and add it to `connectorSpecs`.
4. Keep the key unique (`/^[a-z][a-z0-9_]*$/`). Every operation becomes the
   tool `<connector>_<operation>`; tool names must not collide.
5. Use `auth.fields` only as a credential schema. Values belong in the vault
   and are resolved by `ConnectorConnections`/OAuth accounts at run time.
6. Add a `version: '1.0.0'` when the spec may change later. Saved workflows
   without a version follow the latest version; a pinned workflow keeps its
   version (see [`versioning.md`](versioning.md)).
7. Run typecheck and the connector tests before opening a PR:
   `npm.cmd run typecheck`, then the targeted tests and the full suite.

A useful rule: if a service needs custom request signing, multipart streaming
or a non-HTTP transport, check the existing runtime first. Simplifying that
into a generic spec field is a contract change, not a one-off service patch.

## Auth and connections

There are three account models:

- **Connector connection** for `apiKey`, `bearer`, `basic`, and non-Google
  `oauth2` services. Create it in **Hub > Accounts > Connector connections**;
  one connection can be the default for that service. A workflow node can name
  a connection with `account`; otherwise the default is used.
- **Google account** for Google connectors. One Google account can serve
  Gmail, Drive, Docs, YouTube, Search Console, Chat, Slides and Classroom.
  Scopes come from the connector spec.
- **Legacy vault key / env** is the last fallback for older installs. Do not
  build new flows around it.

Secrets live in the machine vault, never in the spec, workflow JSON, logs, run
history or error text. OAuth refresh is serialized per connection. The OAuth
token endpoint and every connector request use the guarded fetch; private and
local destinations are refused unless a trusted local tool explicitly opts in.
See [`security-review.md`](security-review.md) for residual risks.

## Triggers

Connector triggers are derived from `spec.triggers` by
`packages/core/src/connectors/trigger-adapter.ts` and exposed as
`connector:<key>:<trigger>` in the trigger picker.

- **Webhook**: the runtime verifies the provider signature when `signature` is
  declared. Keep the signing secret in the vault. Replayed event ids are
  dropped by the workflow idempotency store.
- **Poll**: the runtime calls `trigger.operation` on a schedule, uses `idField`
  to skip seen items and passes `trigger.cursor.param` back on the next tick.
  `everyMinutes` is added by the picker when the trigger does not declare it.

The workflow node is always the generic `connector` node; there is no
service-specific node type. Add a trigger to the spec rather than adding
connector-specific fields to the workflow engine.

## Import

All importers run locally and never call a provider or save during preview:

- n8n, Make and Zapier convert app steps into native `connector` nodes, mark
  unsupported steps as stop-with-explanation placeholders, and save workflows
  **disabled** with `webhook: null`.
- Credential values are never imported. Attach a connection after import.
- Imported connector nodes start with `allow: false` for write operations.
- OpenAPI import produces a `ConnectorSpec` draft and a report only. It does
  not persist or register the draft until the integration request in
  [`longtail-ui.md`](longtail-ui.md) is implemented.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `connector "x" is not installed` | The key is in `connectorSpecs`, the file is registered in `services/index.ts`, and the build was restarted. |
| `not connected` / missing credential | Hub > Accounts has a connection for that exact service and field names; the node's `account` is valid. |
| 401 / 403, or `invalid_auth` | Reconnect the account, check scopes and whether the provider requires a bot/tenant-specific token. Errors are redacted; never paste a token into a workflow. |
| Private URL refused | This is the SSRF guard. Use `allowLocal` only for a trusted custom HTTP tool or a local import/test, never for a public connector. See [`security-review.md`](security-review.md). |
| Webhook returns 401/403 | The trigger signature secret is missing or wrong, the timestamp is outside tolerance, or the provider uses a different signed payload. |
| Duplicate webhook runs | The provider does not send a known event-id header/body field; add a supported id or dedupe inside the workflow. |
| Connector version error | A pinned version was removed. Clear the node's version to use latest, or register the pinned version again. |
| An imported workflow is not firing | Imported workflows are disabled and have no webhook until enabled. |
| OpenAPI imported draft is not in the catalog | Expected until persistence/runtime registration is implemented; see [`longtail-ui.md`](longtail-ui.md). |
| A long workflow stops early | The runner caps executions at 1000 nodes and now fails explicitly with `workflow stopped after 1000 node executions (possible loop)`; split the workflow or check for a cycle. |
| Test failure mentions a real API | Tests must use `fakeFetch` or an injected `fetchFn`; no test may call a provider. |

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
node --test packages/core/src/test/e2e/connector-workflow.e2e.test.ts
node --test packages/core/src/test/connector-performance.test.ts
```

As of 2026-10-24: typecheck clean, full suite 528/528, E2E 3/3, performance
5/5. The release gate also requires macOS packaging, Docker verification and
manual UI/security checks; see [`release-checklist.md`](release-checklist.md).
