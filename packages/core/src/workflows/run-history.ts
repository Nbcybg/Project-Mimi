import type { FlowItem, WorkflowRunNodeView, WorkflowRunRecord, WorkflowRunResult, WorkflowRunSummary } from '@mimi/shared';
import type { Db } from '../db/db.ts';

/** Runs kept per workflow; older ones are dropped as new ones come in. */
const KEEP_PER_WORKFLOW = 50;
/** Items kept per node input/output, and the size a stored run may reach before it is cut harder. */
const ITEMS_PER_NODE = 20;
const MAX_RUN_BYTES = 400_000;

interface RunRow {
  id: number;
  workflow: string;
  mode: string;
  ok: number;
  result: string;
  started_at: string;
  duration_ms: number;
  node_count: number;
  nodes?: string;
}

const summaryOf = (row: RunRow): WorkflowRunSummary => ({
  id: row.id,
  workflow: row.workflow,
  mode: row.mode,
  ok: row.ok === 1,
  result: row.result,
  startedAt: row.started_at,
  durationMs: row.duration_ms,
  nodeCount: row.node_count,
});

/** Keeps the first `limit` items and says how many were left out. */
function cut(items: FlowItem[], limit: number): FlowItem[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), { json: { _omitted: `${items.length - limit} more items not stored` } }];
}

function trimmed(nodes: WorkflowRunNodeView[], limit: number): WorkflowRunNodeView[] {
  return nodes.map((node) => ({ ...node, input: cut(node.input, limit), output: cut(node.output, limit) }));
}

/** The run history: one row per workflow run, node input/output kept for the run view. */
export class WorkflowRunStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(workflow: string, mode: string, startedAt: Date, result: WorkflowRunResult): number {
    let nodes = JSON.stringify(trimmed(result.nodes, ITEMS_PER_NODE));
    // A huge run keeps only a peek at each node rather than blowing up the database.
    if (nodes.length > MAX_RUN_BYTES) nodes = JSON.stringify(trimmed(result.nodes, 2));
    if (nodes.length > MAX_RUN_BYTES) nodes = JSON.stringify(trimmed(result.nodes, 0));
    const inserted = this.db
      .prepare(
        `INSERT INTO workflow_runs (workflow, mode, ok, result, started_at, duration_ms, node_count, nodes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workflow,
        mode,
        result.ok ? 1 : 0,
        result.result,
        startedAt.toISOString(),
        Date.now() - startedAt.getTime(),
        result.nodes.length,
        nodes,
      );
    this.db
      .prepare(
        `DELETE FROM workflow_runs WHERE workflow = ? AND id NOT IN
           (SELECT id FROM workflow_runs WHERE workflow = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(workflow, workflow, KEEP_PER_WORKFLOW);
    return Number(inserted.lastInsertRowid);
  }

  /** Newest first. */
  list(workflow: string, limit = 30): WorkflowRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, workflow, mode, ok, result, started_at, duration_ms, node_count
           FROM workflow_runs WHERE workflow = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(workflow, limit) as RunRow[];
    return rows.map(summaryOf);
  }

  get(id: number): WorkflowRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return undefined;
    return { ...summaryOf(row), nodes: JSON.parse(row.nodes ?? '[]') as WorkflowRunNodeView[] };
  }

  /** Drops a workflow's history (the workflow was deleted). */
  forget(workflow: string): void {
    this.db.prepare('DELETE FROM workflow_runs WHERE workflow = ?').run(workflow);
  }
}
