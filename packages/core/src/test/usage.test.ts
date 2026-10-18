import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../db/db.ts';
import { estimateCost } from '../providers/pricing.ts';
import type { ModelCost, ModelInfo } from '../providers/registry.ts';
import { UsageLogger } from '../usage/logger.ts';
import { costByDayAndAgent, formatCallsTable, formatCostTable, recentCalls } from '../usage/report.ts';

const cost: ModelCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const model: ModelInfo = {
  ref: { provider: 'deepseek', model: 'm' },
  name: 'm',
  npm: '@ai-sdk/deepseek',
  baseURL: undefined,
  textOutput: true,
  contextLimit: 100_000,
  outputLimit: undefined,
  cost,
  imageInput: false,
  toolCall: true,
  options: {},
};
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('cost: cached input is billed at the cache-read rate', () => {
  // 600k uncached * $1 + 400k cached * $0.1 + 500k output * $2, per 1M
  near(estimateCost(cost, { inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 500_000 }), 1.64);
});

test('cost: cache writes are billed at the cache-write rate', () => {
  // 100k uncached * $1 + 400k read * $0.1 + 500k written * $1.25
  near(
    estimateCost(cost, { inputTokens: 1_000_000, cachedTokens: 400_000, cacheWriteTokens: 500_000, outputTokens: 0 }),
    0.765,
  );
});

test('cost: prompts over 200k tokens use the higher tier when the model has one', () => {
  const tiered: ModelCost = { ...cost, over200k: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 } };
  near(estimateCost(tiered, { inputTokens: 100_000, cachedTokens: 0, outputTokens: 0 }), 0.1);
  near(estimateCost(tiered, { inputTokens: 300_000, cachedTokens: 0, outputTokens: 0 }), 0.6);
});

test('cost: models without a known price estimate to zero', () => {
  assert.equal(estimateCost(null, { inputTokens: 1000, cachedTokens: 0, outputTokens: 1000 }), 0);
});

test('logger writes one usage row per call and closes the run', () => {
  const db = openDb(':memory:');
  const logger = new UsageLogger(db);
  const runId = logger.startRun({ traceId: 't1', agent: 'mimi', model: model.ref });

  const snapshot = logger.logCall({
    runId,
    traceId: 't1',
    agent: 'mimi',
    kind: 'chat',
    model,
    inputTokens: 1000,
    cachedTokens: 400,
    cacheWriteTokens: 100,
    outputTokens: 500,
    durationMs: 12,
  });
  logger.logCall({ runId: null, traceId: 't1', agent: 'mimi', kind: 'memory', model, inputTokens: 50, cachedTokens: 0, outputTokens: 5, durationMs: 3 });
  logger.finishRun(runId, { status: 'stop', rounds: 1, usage: snapshot, durationMs: 15 });

  const rows = db.prepare('SELECT * FROM usage_log ORDER BY id').all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { cached: rows[0]!.cached_tokens, written: rows[0]!.cache_write_tokens, kind: rows[0]!.capability },
    { cached: 400, written: 100, kind: 'chat' },
  );
  assert.deepEqual({ run: rows[1]!.run_id, kind: rows[1]!.capability }, { run: null, kind: 'memory' });
  const run = db.prepare('SELECT status, rounds FROM agent_runs').get() as Record<string, unknown>;
  assert.deepEqual(run, { status: 'stop', rounds: 1 });

  const calls = recentCalls(db, 5);
  assert.deepEqual(calls.map((call) => call.kind), ['memory', 'chat']);
  assert.match(formatCallsTable(calls), /deepseek\/m.*40%/);
});

test('report groups by local day and agent', () => {
  const db = openDb(':memory:');
  const insert = db.prepare(
    `INSERT INTO usage_log (trace_id, agent, capability, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, created_at)
     VALUES ('t', ?, 'chat', 'deepseek', 'm', ?, ?, ?, ?, ?)`,
  );
  const iso = new Date(Date.now() - 3_600_000).toISOString();
  insert.run('mimi', 100, 10, 50, 0.01, iso);
  insert.run('mimi', 200, 20, 50, 0.02, iso);
  insert.run('tim', 300, 30, 0, 0.5, iso);

  const rows = costByDayAndAgent(db, '+00:00');
  assert.equal(rows.length, 2);
  const mimi = rows.find((row) => row.agent === 'mimi')!;
  assert.deepEqual(
    { calls: mimi.calls, input: mimi.inputTokens, output: mimi.outputTokens, cached: mimi.cachedTokens },
    { calls: 2, input: 300, output: 30, cached: 100 },
  );
  near(mimi.costUsd, 0.03);

  const table = formatCostTable(rows);
  assert.match(table, /mimi/);
  assert.match(table, /33%/);
  assert.match(table, /total: \$0\.5300/);
  assert.equal(formatCostTable([]), 'No usage recorded yet.');
});
