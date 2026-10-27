# Run history and observability (Phase 4B)

Status: implemented. Core: `packages/core/src/workflows/run-history.ts`,
`packages/core/src/workflows/redact.ts`, node trace in
`packages/core/src/workflows/runner.ts`. UI:
`packages/core/src/server/web/feature-workflows.js`.
Tests: `packages/core/src/test/workflow-history.test.ts`.

## What a run records

Every top-level run gets one row in `workflow_runs` (SQLite), newest first in
the editor:

| Field | Meaning |
| --- | --- |
| `id` | Run id, used by the run detail and "run from this node". |
| `workflow` | `<agent>/<name>`. |
| `agent` | Agent owning the workflow. |
| `trigger` / `mode` | `manual`, `schedule`, `webhook`, `mail`, `poll`, `tool`, … |
| `ok` | Final status. |
| `result` | Short human summary; errors are prefixed `error:`. |
| `startedAt`, `durationMs` | Wall-clock start and duration. |
| `nodeCount` | Number of nodes that ran (or waited). |
| `nodes` | Per-node `status`, error, attempts, trace, input and output. |

Node entries keep the first 20 input/output items, with an `_omitted` marker
for the rest. A run larger than 400 KB is cut to 2 items per node, then to 0,
so the database stays bounded. The newest **50 runs per workflow** are kept;
older rows are deleted when a new one is stored. Deleting a workflow deletes
its runs.

A paused run stores everything except later nodes; when it resumes, the paused
node is replaced with its real result and the remaining nodes are appended.

## Redaction

`redact.ts` is used before storing and again when reading old rows, so the UI
never shows credentials even from history written by older versions:

- values under secret-looking keys become `[redacted]`:
  `authorization`, `proxy-authorization`, `apiKey`/`api_key`, `accessToken`,
  `refreshToken`, `token`, `secret`, `password`, `passwd`, `credential`,
  `cookie`, `privateKey`, `clientSecret` (case-insensitive, nested objects and
  arrays included);
- secret-shaped strings are replaced in summaries and errors:
  `Bearer …`, `Basic …`, `Token …`, `xox[baprs]-…`, `sk-…`, and
  `api_key=…` / `token=…` / `secret=…` / `password=…`;
- connector runtimes still redact resolved credentials before an error leaves
  the connector; this is the second line of defence;
- traces contain no credentials: only connector key, operation key, a
  correlation id, and an application/provider error code.

Redaction is intentionally broad. If a workflow needs to show a value whose
key looks secret (for example a public `tokenCount`), rename the field or
store it outside run history.

## Node trace

Connector nodes record:

```json
{
  "connector": "slack",
  "operation": "send_message",
  "requestId": "<execution-id>:<node-id>",
  "errorCode": "invalid_auth"
}
```

- `requestId` is a correlation id made from the run and node, not a provider
  credential or response header.
- `errorCode` comes from an error's `code` property or a `code=`/`errorCode=`
  token in the message. It is shown next to the error, not as the error text.
- `attempts` is stored when a node retried at least once; the error also says
  `(N attempts)`.
- Non-connector nodes get the correlation id only; they have no connector
  trace to show.

## UI

The workflow editor's result panel is the run detail:

- header: run id, mode/trigger, start time, duration, agent;
- each node: status, type, retry count, redacted error with a **copy error**
  button, connector/operation, error code, request id, and collapsible
  input/output JSON;
- history list: newest first, status filter (all / ok / error), trigger chip,
  duration, node count and summary; clicking a row loads that stored run;
- paused runs show the approval/wait banner.

The history is per workflow, so the "workflow" filter is the editor you are
in. The list is bounded to 50 rows per workflow; the "load more" button only
reveals the already-loaded rows.

## Limits

- Run history is local to the database. It is not a distributed trace store.
- There is no live tail: the panel refreshes when a run broadcasts its result.
- Errors from synchronous nodes are redacted, but a node can still put a
  secret into its JSON output under a non-secret key; the key-based allowlist
  cannot detect every case.
- Request ids are correlation ids, not provider request ids, because connector
  responses do not expose headers to the runner yet.
- Node input/output is data, not an audit log; it is trimmed and bounded.

## Verification

`workflow-history.test.ts` covers: newest-first ordering, duration, bounded
node items, 50-run rotation, agent/trigger fields, idempotent redaction of
errors and nested input, copied trace/attempts, and a real runner connector
failure that records connector/operation, error code, attempts and a redacted
message. Full typecheck and test suite must stay green.
