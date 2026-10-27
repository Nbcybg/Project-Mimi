# Connector E2E and Performance - Phase 4E

Date: 2026-10-23

Scope: fake-fetch E2E workflows and local performance/stress measurements for the connector runtime. The initial workstream changed no production code; the integration fix for `PERF-4E-01` is recorded below.

## Environment

- Windows 10.0.26200, AMD Ryzen 5 4500 (6-core)
- Node.js v24.18.0, npm 11.16.0
- Commands run from the repository root
- All network calls use `fakeFetch` or an injected `fetchFn`; no real connector API is called

## E2E coverage

File: `packages/core/src/test/e2e/connector-workflow.e2e.test.ts`

| Test | What it proves | Observed |
| --- | --- | --- |
| Webhook trigger -> connector -> if -> tool -> respond | A saved webhook workflow starts from `triggerItems`, sends Slack through the real connector runtime + fake Slack API, branches on the message, calls a tool, and returns a custom response | Pass, 45ms |
| Failed run -> error workflow | `makeTestCore` runs a broken workflow, then executes its `errorWorkflow` with `{{ $json.error }}` | Pass, 107ms |
| Imported n8n workflow -> run | `importN8n` converts a manual trigger/set/respond flow, then the converted workflow runs and returns its response | Pass, 4ms |

Command:

```powershell
node --test packages/core/src/test/e2e/connector-workflow.e2e.test.ts
```

Result: 3/3 passing.

## Performance results

File: `packages/core/src/test/connector-performance.test.ts`

Command:

```powershell
node --test packages/core/src/test/connector-performance.test.ts
```

| Measurement | Result | Notes |
| --- | --- | --- |
| 50 connectors register/list | 4.5ms | 214 operations/routes listed |
| 100-node graph x 1,000 items | 852.8ms | All 100 nodes executed; 97.3MB heap delta; final node processed 1,000 items |
| Pagination: 20 pages / 1,000 items | 28.1ms | 20 HTTP calls via fake fetch |
| Queue: 100 runs | 167.9ms | Peak concurrency 8, all 100 completed in order |
| Rate limit: 30 requests at 10/s | 20 waits of 100ms (simulated) | No real waiting; clock/sleep injected |
| Node timeout: 10ms | 24.9ms | Slow tool was cut off and the run failed with the timeout error |

Result: 5/5 passing. All tests finish well under the 60s limit (suite about 1.2s).

## Findings

### PERF-4E-01 (resolved): node-execution cap raised, no silent truncation

- Original finding: `packages/core/src/workflows/runner.ts` used
  `MAX_NODES = 60`. A 100-node chain returned `ok: true` after 60 nodes, so
  downstream nodes never ran and no error was emitted.
- Fix: `MAX_NODES` is now **1000**, enough for the 100-node benchmark and
  normal large workflows. If the queue still has work at the cap, the run now
  fails with:
  `workflow stopped after 1000 node executions (possible loop)`.
- This keeps a bound on runaway/cyclic graphs instead of removing the safety
  limit, but no longer reports a truncated run as successful.
- Regression test: `packages/core/src/test/workflow-reliability.test.ts`,
  "runner: the node-execution cap fails a runaway workflow explicitly".
- Benchmark updated: the 100-node graph now executes all 100 nodes.

### Other observations

- Connector registration and pagination are inexpensive relative to workflow execution; 50 connectors and 1,000 paginated items are far below the one-second/three-second test budgets.
- The queue test confirms the global concurrency default (8) is enforced; per-agent/per-workflow limits are covered by the existing reliability tests.
- The rate limiter uses token-bucket refill at `requests / perMs`, so 10 requests/second waits 100ms per token after the burst. This is expected.
- Memory is a coarse `heapUsed` delta, not a retained-memory profile. It is suitable for spotting large regressions, not for precise allocation accounting.

## Coverage gaps

- Browser/UI smoke tests are still manual; this suite exercises the core runtime only.
- Queue behavior under real long-running runs, cancellation races, and multi-process contention is not covered here.
- Real provider latency, rate limits, and payload sizes are intentionally excluded; use staging credentials for a separate soak test.
- The 1000-node cap is tested at the boundary; a production workflow approaching it is still a design smell and should be split.

## Reproduction and acceptance

- E2E: trigger -> connector -> if -> tool -> respond, error workflow, and import -> run are all covered.
- Performance: 50 connectors, 100-node graph, 1,000 items, 20-page pagination, 100 queued runs, rate limit, and node timeout are covered.
- `PERF-4E-01` is resolved; the full suite and the boundary regression test must stay green.
