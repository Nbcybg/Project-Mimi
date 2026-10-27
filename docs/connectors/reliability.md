# Workflow reliability (Phase 4A)

Status: implemented. Files: `packages/core/src/workflows/run-queue.ts`,
`packages/core/src/workflows/idempotency.ts`,
`packages/core/src/workflows/runner.ts`, `packages/core/src/core.ts`,
`packages/core/src/server/server.ts`.
Tests: `packages/core/src/test/workflow-reliability.test.ts`.

## Execution queue

Every top-level workflow run goes through one `RunQueue`:

- manual runs, webhook runs, schedules, mail/poll triggers, chat triggers,
  error workflows' own runs (as separate runs), editor "run from node", and
  resumed parked runs;
- sub-workflows and error-workflow calls stay inline so a parent run cannot
  deadlock waiting for a slot it holds itself.

Order and limits:

- one FIFO list; the oldest run that fits all limits starts next, so a busy
  agent or workflow does not block other agents;
- global limit (default 8), per-agent limit (default 4), per-workflow limit
  (default 1);
- overrides: `MIMI_WORKFLOW_CONCURRENCY`, `MIMI_WORKFLOW_AGENT_CONCURRENCY`,
  `MIMI_WORKFLOW_RUN_CONCURRENCY` (positive integers);
- starting a run is a microtask, not a busy wait; the event loop keeps serving
  HTTP, sockets and triggers.

Cancellation:

- `RunQueue.cancel(id)`, `cancelAgent(agent)`, `cancelWorkflow(agent, name)`,
  and `close()` for shutdown;
- a queued run is removed and rejected with `RunCancelledError`;
- a running run gets an aborted `AbortSignal`, which reaches agents, tools,
  HTTP nodes, connectors and waits; its promise rejects immediately with
  `RunCancelledError`;
- `core.workflowQueue` exposes the queue; `core.close()` closes it.

## Idempotency

`IdempotencyStore` is a bounded, expiring set of keys:

- default TTL 24 hours, default 5000 keys, oldest keys dropped first;
- persisted to `data/workflow-idempotency.json` next to
  `workflow-state.json`, so a restart does not re-run a webhook;
- `claim(key)` is the atomic "first time?" check, `release(key)` removes a
  claim so a failed event can be retried, `has(key)` checks without claiming.

Webhooks:

- event ids are read case-insensitively from `Idempotency-Key`,
  `X-Mimi-Delivery`, `X-Webhook-Id`, `X-Event-Id`, `X-GitHub-Delivery`,
  `X-GitLab-Event-UUID`, `X-Shopify-Webhook-Id`, `X-Request-Id`;
- if no header is present, only known body fields are used:
  `event_id`, `eventId`, `delivery_id`, `deliveryId`, `idempotency_key`,
  `idempotencyKey`;
- the full payload is never hashed, so two real but identical events (for
  example two "ping" deliveries) still run;
- workflow webhooks are scoped as `webhook:<agent>/<workflow>:<event-id>`;
  plain trigger webhooks as `webhook:trigger:<id>:<event-id>`;
- a duplicate returns HTTP 200 with `{ "ok": true, "duplicate": true }` (or a
  run result containing `duplicate webhook event (skipped)`) and does not add a
  run-history row;
- the claim is released when starting the run throws (fetch/config error), but
  kept when the workflow itself ran and failed: a provider retry cannot loop a
  failing workflow forever.

Connector polls still use the workflow-state cursor plus the seen-id list
(`connectorPollResumeKey`, `WorkflowState.seen`). Mail polls use the same seen
list. Both are bounded to the newest 500 ids per workflow.

## Retrying writes

Two retry layers exist:

- connector runtime network retries: only `GET`/`DELETE`, HTTP 429, or
  operations explicitly marked `idempotent: true`;
- workflow node retries (`retries` + `retryWaitMs`): every connector attempt
  carries one stable `Idempotency-Key` header,
  `mimi-<execution-id>-<node-id>-<item-index>`, so providers that support the
  header deduplicate the write. Providers without support may still apply the
  write twice; keep `retries` at 0 for those operations, or mark the operation
  idempotent only when that is true.

The key is not logged and contains no secrets.

## Timeouts

Timeouts are opt-in; nothing changes for existing runs until they are set:

- per node: `RunOptions.nodeTimeoutMs` or `WorkflowRunnerDeps.nodeTimeoutMs`;
- per run: `RunOptions.runTimeoutMs` or `WorkflowRunnerDeps.runTimeoutMs`;
- environment defaults for the app: `MIMI_WORKFLOW_NODE_TIMEOUT_MS` and
  `MIMI_WORKFLOW_RUN_TIMEOUT_MS` (positive milliseconds; unset = no deadline).

A node timeout aborts that node's signal and is reported as
`node "<title>" timed out after <n>ms`, following the node's `onError` policy
(`stop`, `continue`, `branch`). A run timeout aborts the whole run and reports
`workflow run timed out after <n>ms`; the run is marked failed, later nodes do
not start, and the run still lands in history.

Timeouts are cooperative: nodes that honour `AbortSignal` (agents, tools,
HTTP, connectors, waits) stop promptly; a purely synchronous node finishes its
current call before the run sees the abort. A paused run (approval / long wait)
is not under a run timeout while parked; the deadline applies when it resumes.

## Execution cap

A single run may execute at most **1000 nodes**. This bounds cyclic or
runaway graphs. If work is still queued at the cap, the run fails with
`workflow stopped after 1000 node executions (possible loop)` instead of
returning a successful partial result. Split very large workflows rather than
approaching the cap.

## Known limits

- Queue limits are process-local; two app instances sharing a user folder do
  not share a queue (the SQLite database is still the single writer).
- Idempotency claims are process-local plus one JSON file; a crash between the
  provider's write and the claim's persistence can still repeat an event.
- Poll cursor advancement happens before items run; seen-id filtering prevents
  duplicates after a restart but a crash can lose an item that was fetched and
  never marked (at-most-once for connector polls).
- A run timeout cannot interrupt synchronous JavaScript (the sandbox and file
  nodes) mid-call.

## Verification

`workflow-reliability.test.ts` covers: per-workflow FIFO, independent agents,
the queue's global cap, cancelling queued and running runs, node timeout, run
timeout, the 1000-node execution cap, TTL/eviction/persistence of idempotency
keys, header/body event-id extraction, duplicate webhook through
`core.runWorkflow`, and stable `Idempotency-Key` on retried connector writes.
Typecheck and the full test suite must stay green.
