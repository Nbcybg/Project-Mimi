import type { ApprovalView } from '@mimi/shared';
import type { Db } from '../db/db.ts';

export type ApprovalOutcome = 'approved' | 'rejected' | 'timeout';

export interface ApprovalDecision {
  decision: ApprovalOutcome;
  note?: string;
}

export interface ApprovalRequest {
  /** `<agent>/<name>` of the asking workflow. */
  workflow: string;
  /** Whose chat the question goes to. */
  agent: string;
  text: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ApprovalsDeps {
  /** Posts the question into the agent's chat; returns where it landed. */
  post(agent: string, text: string): { chatId?: number; messageId: number };
  /** The chat changed outside a turn (question posted, answer recorded). */
  changed(chatId: number | undefined): void;
}

interface ApprovalRow {
  id: number;
  workflow: string;
  agent: string;
  chat_id: number | null;
  message_id: number | null;
  status: ApprovalView['status'];
  note: string | null;
  expires_at: string;
}

interface Pending {
  resolve(decision: ApprovalDecision): void;
  timer: NodeJS.Timeout;
  chatId?: number;
  cleanup(): void;
}

/** Longest a workflow may wait for an answer. */
export const MAX_APPROVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Approval requests of workflows: a question posted into a chat with buttons, and the
 * run waiting on the answer. The waiting run lives in this process only; rows left
 * pending by a previous process are marked expired at start.
 */
export class Approvals {
  private readonly db: Db;
  private readonly deps: ApprovalsDeps;
  private readonly pending = new Map<number, Pending>();

  constructor(db: Db, deps: ApprovalsDeps) {
    this.db = db;
    this.deps = deps;
    db.prepare(`UPDATE workflow_approvals SET status = 'expired' WHERE status = 'pending'`).run();
  }

  request(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (request.signal?.aborted) return Promise.reject(new Error('aborted'));
    const timeoutMs = Math.min(MAX_APPROVAL_MS, Math.max(1000, request.timeoutMs));
    const now = new Date();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO workflow_approvals (workflow, agent, text, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(request.workflow, request.agent, request.text, now.toISOString(), new Date(now.getTime() + timeoutMs).toISOString())
        .lastInsertRowid,
    );
    const where = this.deps.post(request.agent, request.text);
    this.db.prepare('UPDATE workflow_approvals SET chat_id = ?, message_id = ? WHERE id = ?').run(where.chatId ?? null, where.messageId, id);
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = () => {
        this.finish(id, 'expired');
        reject(new Error('aborted'));
      };
      const entry: Pending = {
        resolve,
        chatId: where.chatId,
        timer: setTimeout(() => {
          this.finish(id, 'timeout');
          resolve({ decision: 'timeout' });
        }, timeoutMs),
        cleanup: () => request.signal?.removeEventListener('abort', onAbort),
      };
      this.pending.set(id, entry);
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.deps.changed(where.chatId);
    });
  }

  /** The user's answer; false when the request is no longer waiting. */
  decide(id: number, approved: boolean, note?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const text = note?.trim() || undefined;
    this.finish(id, approved ? 'approved' : 'rejected', text);
    entry.resolve({ decision: approved ? 'approved' : 'rejected', ...(text ? { note: text } : {}) });
    return true;
  }

  /** Approval state of the given chat messages, for the message views. */
  byMessages(ids: number[]): Map<number, ApprovalView> {
    const views = new Map<number, ApprovalView>();
    if (ids.length === 0) return views;
    const rows = this.db
      .prepare(`SELECT * FROM workflow_approvals WHERE message_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as ApprovalRow[];
    for (const row of rows) {
      views.set(row.message_id!, {
        id: row.id,
        status: row.status,
        workflow: row.workflow,
        expiresAt: row.expires_at,
        ...(row.note ? { note: row.note } : {}),
      });
    }
    return views;
  }

  /** Requests still waiting in this process. */
  waiting(): number[] {
    return [...this.pending.keys()];
  }

  /** Stops every wait (the core is closing); the runs see a timeout. */
  close(): void {
    for (const [id, entry] of [...this.pending]) {
      this.finish(id, 'expired');
      entry.resolve({ decision: 'timeout' });
    }
  }

  private finish(id: number, status: ApprovalView['status'], note?: string): void {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.cleanup();
      this.pending.delete(id);
    }
    this.db
      .prepare(`UPDATE workflow_approvals SET status = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(status, note ?? null, new Date().toISOString(), id);
    this.deps.changed(entry?.chatId);
  }
}
