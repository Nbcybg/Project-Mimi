# Connector versioning (Phase 4C)

Status: implemented. Files: `packages/shared/src/connectors.ts`,
`packages/core/src/connectors/registry.ts`,
`packages/core/src/connectors/runtime.ts`,
`packages/core/src/workflows/runner.ts`, connector node fields in
`packages/core/src/server/web/feature-workflows.js`.
Tests: `packages/core/src/test/connector-versioning.test.ts`.

## Version field

`ConnectorSpec.version` is a semver string (`1`, `1.2`, `1.2.3` are not all
accepted; use `x.y.z`). A spec without a version is registered as
`1.0.0`, so the existing 50 connectors keep working unchanged.

Versions describe the connector definition: operation paths, fields, auth
metadata and triggers. They are independent of
`CONNECTOR_CONTRACT_VERSION`, which versions the shape of the spec itself.

## Registry

`ConnectorRegistry` keeps `key -> version -> spec`:

- the same key may be registered at several versions;
- the same key **and** version is rejected (`already registered`);
- a malformed version is rejected before it reaches the runtime;
- `get(key)` returns the latest version by numeric semver order (so
  `1.10.0` is newer than `1.9.0`);
- `get(key, version)` returns exactly that version, or `undefined`;
- `versions(key)` lists installed versions newest first;
- `list()` returns one spec per key (the latest), and `listAll()` returns
  every installed version for diagnostics;
- tool names (`<connector>_<operation>`) exist only for the latest version, so
  two versions cannot create duplicate tools; an older version with an
  operation the latest no longer has cannot expose that operation as a tool;
- duplicate tool names across different connectors are still rejected.

`ConnectorView` (what the settings screen receives) includes `version` and
`versions`. It never includes credentials or spec internals beyond the existing
operation metadata.

## Runtime selection

`ConnectorRequest.version` is optional:

| Request | Spec used |
| --- | --- |
| `{ connector: "slack", operation: "send_message" }` | latest installed |
| `{ ..., version: "1.2.0" }` | exactly `1.2.0` |
| unknown version | readable `ConnectorError`: `Connector "slack" version "9.9.9" is not installed. Installed versions: ...` |
| operation missing in that version | readable error naming the version and listing its operations |

The result carries `version`; when an older version ran it also carries
`deprecated: true` and `latestVersion`. Workflow connector nodes copy those
fields into the run trace, and the run detail shows
`v<version> · ⚠ version เก่า — latest v<latest>`. A deprecation warning never
blocks a run.

## Workflows

A connector node may pin a version in its config:

```json
{
  "type": "connector",
  "config": { "connector": "slack", "operation": "send_message", "version": "1.2.0" }
}
```

- empty/missing `version`: the latest installed version is used at run time;
- a pinned version keeps running even after newer versions are registered,
  including when the latest removed or renamed an operation;
- new workflows therefore get the latest behavior by default; use the
  **Connector version** select in the node editor to pin one;
- the editor's operation list comes from the latest version. A workflow pinned
  to an old version whose operation is gone will still fail at run time with a
  message naming the version and its available operations. That is intentional:
  the editor shows the target version, the pinned run shows the reality;
- saved workflows without a version are not rewritten. They follow the latest
  version (the pre-4C behavior) until someone pins them.

## Migration and deprecation

1. Add the new spec under a new `version` and keep the old spec registered.
2. Run the versioning test/typecheck; the old workflows still resolve their
   pinned version.
3. The old version is reported as deprecated whenever it actually runs. Review
   the run detail, then edit the node's version (or clear it for latest).
4. Only remove an old spec after every workflow that pins it has been migrated.
   Removing it is a hard error with the installed-version list, never a silent
   fallback to a different version.

There is no automatic migration of node configs, because changing an operation
version can change fields and safety (risk/idempotency). Migration is explicit.

## Limits

- Tool/agent calls use the latest version; `ConnectorRequest.version` is
  available to workflow nodes and direct runtime callers, not to the model's
  dynamic tool surface.
- The editor's operation metadata is the latest version; it does not switch its
  operation list to the pinned version yet.
- Semver is numeric `x.y.z` only; prerelease/build tags are not ordered.
- Installed versions live in memory with the registry; the app ships one spec
  set, so "installing" a version means registering it in code.
- Triggers use the latest version; connector webhook verification resolves the
  latest spec for the trigger key.

## Verification

`connector-versioning.test.ts` covers: semver ordering, latest vs pinned
resolution, duplicate/invalid version rejection, latest-only tool names,
deprecated result metadata, a pinned workflow surviving an update, an operation
removed from the latest still working when pinned, the unknown-version error,
and the runner sending/recording the node's pinned version.
