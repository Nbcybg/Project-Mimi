import type { Db } from './db.ts';

export interface ThreadState {
  thread: string;
  /** Bumped at every compaction; the prompt prefix is byte-stable within an epoch. */
  epoch: number;
  /** Messages with id <= this are represented by summaries, not replayed raw. */
  summarizedThrough: number;
  /** Memory block as rendered at the start of the epoch. */
  memorySnapshot: string;
}

export interface Summary {
  id: number;
  thread: string;
  fromMessageId: number;
  toMessageId: number;
  content: string;
  tokenEstimate: number;
  source: 'raw' | 'summaries';
  createdAt: string;
}

export interface NewSummary {
  fromMessageId: number;
  toMessageId: number;
  content: string;
  tokenEstimate: number;
  source: 'raw' | 'summaries';
}

interface StateRow {
  thread: string;
  epoch: number;
  summarized_through: number;
  memory_snapshot: string;
}

interface SummaryRow {
  id: number;
  thread: string;
  from_message_id: number;
  to_message_id: number;
  content: string;
  token_estimate: number;
  source: 'raw' | 'summaries';
  created_at: string;
}

function toSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    thread: row.thread,
    fromMessageId: row.from_message_id,
    toMessageId: row.to_message_id,
    content: row.content,
    tokenEstimate: row.token_estimate,
    source: row.source,
    createdAt: row.created_at,
  };
}

/** Thread prefix state and its rolling summaries. */
export class ThreadRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Returns the thread state, creating it (with a fresh memory snapshot) on first use. */
  ensureState(thread: string, renderSnapshot: () => string): ThreadState {
    const select = this.db.prepare(`SELECT * FROM thread_state WHERE thread = ?`);
    let row = select.get(thread) as StateRow | undefined;
    if (!row) {
      this.db
        .prepare(`INSERT INTO thread_state (thread, memory_snapshot) VALUES (?, ?)`)
        .run(thread, renderSnapshot());
      row = select.get(thread) as StateRow;
    }
    return {
      thread: row.thread,
      epoch: row.epoch,
      summarizedThrough: row.summarized_through,
      memorySnapshot: row.memory_snapshot,
    };
  }

  /** Summaries that are part of the prompt, oldest first. */
  activeSummaries(thread: string): Summary[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM summaries WHERE thread = ? AND superseded_by IS NULL ORDER BY from_message_id`,
      )
      .all(thread) as SummaryRow[];
    return rows.map(toSummary);
  }

  /**
   * Starts a new prefix epoch in one transaction: adds summaries, optionally retires
   * the ones a merged summary replaces, moves the watermark and stores a new memory snapshot.
   */
  commitEpoch(
    thread: string,
    change: {
      add: NewSummary[];
      /** Ids replaced by the last entry of `add`. */
      supersede?: number[];
      summarizedThrough?: number;
      memorySnapshot: string;
    },
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO summaries (thread, from_message_id, to_message_id, content, token_estimate, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const retire = this.db.prepare(`UPDATE summaries SET superseded_by = ? WHERE id = ?`);
    this.db.transaction(() => {
      let lastId = 0;
      for (const summary of change.add) {
        lastId = Number(
          insert.run(
            thread,
            summary.fromMessageId,
            summary.toMessageId,
            summary.content,
            summary.tokenEstimate,
            summary.source,
          ).lastInsertRowid,
        );
      }
      for (const id of change.supersede ?? []) retire.run(lastId, id);
      this.db
        .prepare(
          `UPDATE thread_state
              SET epoch = epoch + 1,
                  summarized_through = MAX(summarized_through, ?),
                  memory_snapshot = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE thread = ?`,
        )
        .run(change.summarizedThrough ?? 0, change.memorySnapshot, thread);
    })();
  }
}
