import type { Capability, RunFinishReason, UsageSnapshot } from '@mimi/shared';
import type { Db } from '../db/db.ts';
import { estimateCost, type TokenUsage } from '../providers/pricing.ts';
import type { ModelInfo, ModelRef } from '../providers/registry.ts';

/** What a model call was for. Background jobs are logged next to chat calls. */
export type UsageKind = Capability | 'memory';

export interface RunStart {
  traceId: string;
  agent: string;
  model: ModelRef;
}

export interface CallRecord extends TokenUsage {
  /** Null for background jobs that are not part of an agent run. */
  runId: number | null;
  traceId: string;
  agent: string;
  kind: UsageKind;
  model: ModelInfo;
  durationMs: number;
}

export interface RunEnd {
  status: RunFinishReason;
  rounds: number;
  usage: UsageSnapshot;
  durationMs: number;
  error?: string;
}

/** Writes `agent_runs` (one row per run) and `usage_log` (one row per model call). */
export class UsageLogger {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  startRun(run: RunStart): number {
    const result = this.db
      .prepare(`INSERT INTO agent_runs (trace_id, agent, provider, model) VALUES (?, ?, ?, ?)`)
      .run(run.traceId, run.agent, run.model.provider, run.model.model);
    return Number(result.lastInsertRowid);
  }

  /** Records one model call and returns its usage with the cost estimate filled in. */
  logCall(call: CallRecord): UsageSnapshot {
    const costUsd = estimateCost(call.model.cost, call);
    this.db
      .prepare(
        `INSERT INTO usage_log
           (run_id, trace_id, agent, capability, provider, model,
            input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.runId,
        call.traceId,
        call.agent,
        call.kind,
        call.model.ref.provider,
        call.model.ref.model,
        call.inputTokens,
        call.outputTokens,
        call.cachedTokens,
        call.cacheWriteTokens ?? 0,
        costUsd,
        call.durationMs,
      );
    return {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedTokens: call.cachedTokens,
      costUsd,
    };
  }

  finishRun(runId: number, end: RunEnd): void {
    this.db
      .prepare(
        `UPDATE agent_runs
            SET status = ?, rounds = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
                cost_usd = ?, duration_ms = ?, error = ?
          WHERE id = ?`,
      )
      .run(
        end.status,
        end.rounds,
        end.usage.inputTokens,
        end.usage.outputTokens,
        end.usage.cachedTokens,
        end.usage.costUsd,
        end.durationMs,
        end.error ?? null,
        runId,
      );
  }
}
