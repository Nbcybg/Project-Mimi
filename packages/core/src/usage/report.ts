import type { Db } from '../db/db.ts';

export interface CostRow {
  day: string;
  agent: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/**
 * Cost per day and per agent, newest day first. Days follow the given UTC offset
 * (e.g. "+07:00") so they line up with the user's calendar.
 */
export function costByDayAndAgent(db: Db, utcOffset = '+00:00', days = 30): CostRow[] {
  return db
    .prepare(
      `SELECT date(created_at, @offset)   AS day,
              agent,
              COUNT(*)                    AS calls,
              SUM(input_tokens)           AS inputTokens,
              SUM(output_tokens)          AS outputTokens,
              SUM(cached_tokens)          AS cachedTokens,
              SUM(cost_usd)               AS costUsd
         FROM usage_log
        WHERE created_at >= datetime('now', @since)
        GROUP BY day, agent
        ORDER BY day DESC, agent`,
    )
    .all({ offset: utcOffset, since: `-${days} days` }) as CostRow[];
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

export function formatCostTable(rows: CostRow[]): string {
  if (rows.length === 0) return 'No usage recorded yet.';
  const header = ['day', 'agent', 'calls', 'input', 'cached', 'cache%', 'output', 'cost (USD)'];
  const body = rows.map((row) => [
    row.day,
    row.agent,
    String(row.calls),
    String(row.inputTokens),
    String(row.cachedTokens),
    row.inputTokens > 0 ? `${Math.round((row.cachedTokens / row.inputTokens) * 100)}%` : '-',
    String(row.outputTokens),
    row.costUsd.toFixed(4),
  ]);
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const widths = header.map((title, col) =>
    Math.max(title.length, ...body.map((cells) => cells[col]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, col) => pad(cell, widths[col]!, col >= 2)).join('  ');
  return [
    line(header),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...body.map(line),
    '',
    `total: $${total.toFixed(4)}`,
  ].join('\n');
}

export interface CallRow {
  createdAt: string;
  agent: string;
  kind: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The most recent model calls, newest first: tokens and cache hit rate per call. */
export function recentCalls(db: Db, limit = 20): CallRow[] {
  return db
    .prepare(
      `SELECT created_at                AS createdAt,
              agent,
              capability                AS kind,
              provider || '/' || model  AS model,
              input_tokens              AS inputTokens,
              cached_tokens             AS cachedTokens,
              output_tokens             AS outputTokens,
              cost_usd                  AS costUsd
         FROM usage_log
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(limit) as CallRow[];
}

export function formatCallsTable(rows: CallRow[]): string {
  if (rows.length === 0) return 'No usage recorded yet.';
  const header = ['time (UTC)', 'agent', 'kind', 'model', 'input', 'cached', 'cache%', 'output', 'cost (USD)'];
  const body = rows.map((row) => [
    row.createdAt.slice(0, 19).replace('T', ' '),
    row.agent,
    row.kind,
    row.model,
    String(row.inputTokens),
    String(row.cachedTokens),
    row.inputTokens > 0 ? `${Math.round((row.cachedTokens / row.inputTokens) * 100)}%` : '-',
    String(row.outputTokens),
    row.costUsd.toFixed(5),
  ]);
  const widths = header.map((title, col) =>
    Math.max(title.length, ...body.map((cells) => cells[col]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, col) => pad(cell, widths[col]!, col >= 4)).join('  ');
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(line)].join(
    '\n',
  );
}
