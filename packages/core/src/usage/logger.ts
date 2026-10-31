import type { Capability, RunFinishReason, UsageSnapshot } from '@mimi/shared';
import type { Db } from '../db/db.ts';
import { estimateCost, type TokenUsage } from '../providers/pricing.ts';
import type { ModelInfo, ModelRef } from '../providers/registry.ts';

/** What a model call was for. Background jobs are logged next to chat calls. */
export type UsageKind = Capability | 'memory' | 'embedding';

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

export interface ToolCallRecord {
  traceId: string;
  agent: string;
  tool: string;
  risk: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  lastError?: string;
}

/** Writes `agent_runs` (one row per run) and `usage_log` (one row per model call). */
export class UsageLogger {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    // The per-call tool log is for recent diagnosis, not an archive.
    db.prepare(`DELETE FROM tool_calls WHERE datetime(created_at) < datetime('now', '-90 days')`).run();
  }

  /** Estimated cost of every call since `sinceIso` (a UTC timestamp). */
  spentSince(sinceIso: string): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_log WHERE created_at >= ?').get(sinceIso) as { total: number }).total;
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

  /** One row per tool call, so the Overseer can see what is used and what fails. */
  logToolCall(call: ToolCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (trace_id, agent, tool, risk, ok, duration_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(call.traceId, call.agent, call.tool, call.risk, call.ok ? 1 : 0, Math.round(call.durationMs), call.error?.slice(0, 500) ?? null);
  }

  /** Tool use and failure counts since `days` ago, busiest first. */
  toolStats(days = 7): ToolStat[] {
    const rows = this.db
      .prepare(
        `SELECT tool,
                COUNT(*) AS calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
                AVG(duration_ms) AS avgMs
           FROM tool_calls
          WHERE datetime(created_at) >= datetime('now', ?)
          GROUP BY tool
          ORDER BY calls DESC, tool`,
      )
      .all(`-${Math.max(1, Math.floor(days))} days`) as Array<{ tool: string; calls: number; errors: number; avgMs: number }>;
    return rows.map((row) => {
      const last = this.db
        .prepare(`SELECT error FROM tool_calls WHERE tool = ? AND ok = 0 AND error IS NOT NULL ORDER BY id DESC LIMIT 1`)
        .get(row.tool) as { error: string } | undefined;
      return {
        tool: row.tool,
        calls: Number(row.calls),
        errors: Number(row.errors),
        errorRate: row.calls > 0 ? Number(row.errors) / Number(row.calls) : 0,
        avgMs: Math.round(Number(row.avgMs) || 0),
        ...(last?.error ? { lastError: last.error } : {}),
      };
    });
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
