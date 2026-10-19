import type { Db } from '../db/db.ts';

/** What an agent keeps current about itself, plus the gallery picture on show (`situation`, set by the gallery tools). */
export const STATUS_KEYS = ['location', 'outfit', 'current_task', 'mood', 'situation'] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
/** The keys the agent sets with `status_set`. */
export const SELF_STATUS_KEYS = ['location', 'outfit', 'current_task', 'mood'] as const;
export type AgentStatus = Partial<Record<StatusKey, string>>;

const VALUE_LIMIT = 300;

/** What each agent is doing right now. Agents update it themselves with `status_set`. */
export class StatusStore {
  private readonly db: Db;
  /** Called after every change, so clients can show it right away. */
  onChange: ((agent: string, status: AgentStatus) => void) | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  get(agent: string): AgentStatus {
    const rows = this.db.prepare(`SELECT key, value FROM agent_status WHERE agent = ?`).all(agent) as Array<{
      key: string;
      value: string;
    }>;
    const status: AgentStatus = {};
    for (const key of STATUS_KEYS) {
      const value = rows.find((row) => row.key === key)?.value;
      if (value) status[key] = value;
    }
    return status;
  }

  /** Sets one key; an empty value clears it. */
  set(agent: string, key: StatusKey, value: string): AgentStatus {
    const clean = value.replace(/\s+/g, ' ').trim().slice(0, VALUE_LIMIT);
    if (clean) {
      this.db
        .prepare(
          `INSERT INTO agent_status (agent, key, value) VALUES (?, ?, ?)
           ON CONFLICT (agent, key) DO UPDATE
             SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(agent, key, clean);
    } else {
      this.db.prepare(`DELETE FROM agent_status WHERE agent = ? AND key = ?`).run(agent, key);
    }
    const status = this.get(agent);
    this.onChange?.(agent, status);
    return status;
  }

  forget(agent: string): void {
    this.db.prepare(`DELETE FROM agent_status WHERE agent = ?`).run(agent);
  }

  rename(from: string, to: string): void {
    this.db.prepare(`UPDATE OR REPLACE agent_status SET agent = ? WHERE agent = ?`).run(to, from);
  }

  /** The snapshot placed at the bottom of the prompt. Empty when nothing is set. */
  render(agent: string, describe?: (key: StatusKey, value: string) => string | undefined): string {
    const status = this.get(agent);
    const lines = STATUS_KEYS.filter((key) => status[key]).map((key) => {
      // An outfit or gallery picture set by id also shows what it is.
      const detail = describe?.(key, status[key]!);
      return detail ? `${key}: ${status[key]} = ${detail}` : `${key}: ${status[key]}`;
    });
    return lines.length > 0 ? `Your current status:\n${lines.join('\n')}` : '';
  }
}

export interface Memo {
  key: string;
  value: string;
  updatedAt: string;
}

/** Short notes an agent keeps for itself, by key. */
export class MemoStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  list(agent: string): Memo[] {
    const rows = this.db
      .prepare(`SELECT key, value, updated_at FROM memos WHERE agent = ? ORDER BY key`)
      .all(agent) as Array<{ key: string; value: string; updated_at: string }>;
    return rows.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }));
  }

  get(agent: string, key: string): Memo | undefined {
    return this.list(agent).find((memo) => memo.key === key);
  }

  save(agent: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO memos (agent, key, value) VALUES (?, ?, ?)
         ON CONFLICT (agent, key) DO UPDATE
           SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(agent, key, value);
  }

  delete(agent: string, key: string): boolean {
    return this.db.prepare(`DELETE FROM memos WHERE agent = ? AND key = ?`).run(agent, key).changes > 0;
  }

  forget(agent: string): void {
    this.db.prepare(`DELETE FROM memos WHERE agent = ?`).run(agent);
  }

  rename(from: string, to: string): void {
    this.db.prepare(`UPDATE OR REPLACE memos SET agent = ? WHERE agent = ?`).run(to, from);
  }
}
