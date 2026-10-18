import type { Db } from '../db/db.ts';
import type { ParkedRun } from './runner.ts';

interface ParkedRow {
  id: number;
  workflow: string;
  node_id: string;
  kind: string;
  resume_at: string | null;
  run: string;
  created_at: string;
}

/** Paused workflow runs, stored so they finish even after the app restarts. */
export class ParkedRuns {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  add(parked: ParkedRun): number {
    return Number(
      this.db
        .prepare('INSERT INTO workflow_parked (workflow, node_id, kind, resume_at, run, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          `${parked.workflow.agent}/${parked.workflow.name}`,
          parked.nodeId,
          parked.wait.kind,
          parked.wait.kind === 'wait' ? parked.wait.resumeAt : null,
          JSON.stringify(parked),
          new Date().toISOString(),
        ).lastInsertRowid,
    );
  }

  get(id: number): ParkedRun | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_parked WHERE id = ?').get(id) as ParkedRow | undefined;
    return row ? (JSON.parse(row.run) as ParkedRun) : undefined;
  }

  /** Takes a run out (once): two wake-ups for the same run cannot both resume it. */
  take(id: number): ParkedRun | undefined {
    const parked = this.get(id);
    if (!parked) return undefined;
    const removed = this.db.prepare('DELETE FROM workflow_parked WHERE id = ?').run(id).changes;
    return removed > 0 ? parked : undefined;
  }

  /** Waits that are over. */
  due(now = new Date()): number[] {
    return (this.db.prepare(`SELECT id FROM workflow_parked WHERE kind = 'wait' AND resume_at <= ? ORDER BY resume_at`).all(now.toISOString()) as Array<{ id: number }>).map((row) => row.id);
  }

  list(workflow?: string): Array<{ id: number; workflow: string; nodeId: string; kind: string; resumeAt: string | null; createdAt: string }> {
    const rows = (workflow
      ? this.db.prepare('SELECT id, workflow, node_id, kind, resume_at, created_at FROM workflow_parked WHERE workflow = ? ORDER BY id').all(workflow)
      : this.db.prepare('SELECT id, workflow, node_id, kind, resume_at, created_at FROM workflow_parked ORDER BY id').all()) as ParkedRow[];
    return rows.map((row) => ({ id: row.id, workflow: row.workflow, nodeId: row.node_id, kind: row.kind, resumeAt: row.resume_at, createdAt: row.created_at }));
  }

  /** A deleted workflow takes its paused runs with it. */
  forget(workflow: string): void {
    this.db.prepare('DELETE FROM workflow_parked WHERE workflow = ?').run(workflow);
  }
}
