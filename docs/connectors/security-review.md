# Connector and workflow security review (Phase 4D)

Status: implemented. Scope: connector runtime, OpenAPI import, OAuth
connections, workflow HTTP/poll traffic, custom HTTP tools, MCP and shell
permissions, secret storage and run-history redaction.

Threat model: a workflow, an imported spec or a model-driven tool call must
not reach loopback, the LAN, a router, or a cloud metadata address, and
credentials must not leak into redirects, errors, logs or run history. The
person who installs a connector or MCP server is trusted to choose its
destination; an agent using it is not.

## Summary

| ID | Severity | Finding | Status | Owner |
| --- | --- | --- | --- | --- |
| SEC-4D-01 | High | Connector runtime fetched the spec `baseUrl` without the local-network guard and followed redirects blindly. | Fixed | Connector runtime |
| SEC-4D-02 | High | Workflow HTTP nodes and poll triggers guarded only the first URL; redirects could reach the LAN. Redirects could also forward `Authorization`/API-key headers to another origin. | Fixed | Workflow runtime |
| SEC-4D-03 | Medium | Custom HTTP tools had no local-network guard. | Fixed | Tool pool |
| SEC-4D-04 | Medium | Concurrent OAuth refreshes raced; providers that rotate refresh tokens could invalidate the second request. | Fixed | OAuth connections |
| SEC-4D-05 | Medium | OAuth token endpoints came from connector specs and were fetched without a guard. | Fixed | OAuth connections |
| SEC-4D-06 | Low | OpenAPI import only recognised `localhost`/`127.*`; other private literals were accepted as servers. | Fixed | OpenAPI import |
| SEC-4D-07 | Low | DNS is resolved by the guard and again by `fetch`, so a hostile resolver could rebind between the check and the request. | Accepted residual | Runtime/platform |
| SEC-4D-08 | Low | PKCE is opt-in (`extra.pkce`); some providers do not support it. OAuth state is always 128-bit random and the callback is loopback-only. | Accepted residual | Connector auth |
| SEC-4D-09 | Low | Disconnecting a connection clears local secrets but does not call a provider revocation endpoint. Users must revoke at the provider. | Accepted residual | Connector auth |
| SEC-4D-10 | Low | MCP HTTP URLs and shell commands are trusted configuration; local MCP servers are a supported use case. | Accepted residual | Tool pool/MCP |

No open critical or high findings.

## Fixes

### Safe outbound HTTP (SEC-4D-01, SEC-4D-02)

`packages/core/src/workflows/net-guard.ts` now exports `safeFetch`:

- checks the destination with `assertPublicUrl` before every hop;
- follows at most five redirects and re-checks each new URL;
- refuses loopback, private, carrier-grade NAT/Tailscale, link-local and
  metadata addresses, including IPv4-mapped IPv6;
- strips credential-shaped headers (`authorization`, cookies, `x-api-key`,
  `*-token`, `*-secret`, `*-key`, ...) when a redirect changes origin;
- keeps the method/body for 307/308 and downgrades 301/302 POST and 303 to GET;
- supports an injected `fetchFn`/`lookup` for tests, and `allowLocal` only when
  the caller explicitly opts in.

The connector runtime uses it for every request, including pagination and
retries. The HTTP node and poll trigger use it instead of guarding only the
initial URL. A real runtime always uses the global `fetch`, so production is
guarded; a test fake without a `lookup` is the only bypass.

Tests: `packages/core/src/test/connector-security.test.ts`,
`packages/core/src/test/security.test.ts` (HTTP redirect to the LAN).

### Custom HTTP tools (SEC-4D-03)

Custom HTTP tools now use `safeFetch` and deny private destinations by
default. A tool that is meant to talk to a NAS, Home Assistant or another LAN
service must set `config.allowLocal: true`; the custom-tool editor exposes this
as **Allow local network (LAN)**. This is a deliberate breaking change for
existing LAN tools: re-save them with the checkbox ticked.

Shell tools remain `risk: 'shell'` and are still refused in the same agent as
untrusted-content tools; MCP tools default to `risk: 'write'` and
`untrustedInput: true` unless the server says otherwise.

Test: `connector-security.test.ts` (`custom HTTP tools`).

### OAuth (SEC-4D-04, SEC-4D-05)

`ConnectorConnections` keeps one in-flight refresh promise per connection, so
parallel runs share one token request and one rotated refresh token. Token
refreshes and the generic authorization-code exchange now go through
`safeFetch`; a bad or imported spec cannot point a token request at a private
address. The local callback only accepts `/callback`, requires the exact
random `state`, and listens on `127.0.0.1` with a timeout.

Tests: `connector-security.test.ts` (`concurrent token refreshes`,
`OAuth token endpoints`), `connector-auth.test.ts`.

### OpenAPI import (SEC-4D-06)

Server literals are now checked with `isPrivateAddress`, not just
`localhost`/`127.*`. DNS names that resolve to private addresses are still
accepted at import time (import is synchronous) but are blocked by
`safeFetch` at execution time.

Test: `connector-openapi.test.ts` (`unsafe servers`).

## Verified controls

- Secret values are stored in the machine-local vault, written with mode
  `0600`; connector views and tool views never include values.
- Run history and node errors are redacted on write and on read
  (`workflows/redact.ts`), including legacy rows.
- Connector runtime errors redact resolved credentials before returning.
- Write operations need explicit node/tool consent; the permission gate
  (`read` auto, `write`/`network`/`delete`/`shell` ask unless overridden)
  still applies.
- An agent cannot combine an untrusted-content tool with a shell tool.
- OAuth state is random; PKCE uses S256 when enabled.
- Cross-origin redirects no longer carry credential-shaped headers.
- MCP servers are classified write/untrusted by default and every side effect
  goes through the permission broker.

## Residual risks and follow-ups

- **DNS rebinding (SEC-4D-07).** `assertPublicUrl` resolves the host, then
  `fetch` resolves it again. Redirects are re-checked, but the first hop has a
  small TOCTOU window. A future change can pin the resolved address with a
  custom undici dispatcher; until then keep the app on a trusted resolver.
- **PKCE (SEC-4D-08).** Enable `extra.pkce` for every provider that supports
  it; state protection is always on.
- **Revocation (SEC-4D-09).** Add provider revocation URLs if they become
  available in the connector contract.
- **MCP/shell configuration (SEC-4D-10).** These are user-installed
  capabilities and intentionally may use localhost. Treat MCP servers like
  installed programs.
- Redaction is pattern-based; an unusual secret shape that is not under a
  secret key and does not match a token pattern can still appear in history.
  Do not place secrets in non-secret fields.

## Evidence

- `packages/core/src/test/connector-security.test.ts` - 7 tests.
- `packages/core/src/test/security.test.ts` - initial and redirect guards,
  code sandbox, permission gate.
- `packages/core/src/test/connector-openapi.test.ts` - private server
  import checks.
- `packages/core/src/test/connector-auth.test.ts` - refresh/sign-in flows.
- `npm.cmd test` - full suite passing (528 tests).
- `npm.cmd run typecheck` - clean.

## Manual checks still needed

- Tick **Allow local network (LAN)** on an existing custom HTTP tool and
  confirm it still reaches its LAN service.
- Disconnect and reconnect one OAuth connector; confirm a refresh happens
  once and the old refresh token is not replayed.
- On macOS, run the manual UI smoke lists under `docs/connectors/` and the
  G4 build check; Windows cannot run `build:mac`.
