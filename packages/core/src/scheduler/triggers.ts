import { randomBytes } from 'node:crypto';
import type { TriggerInfo } from '@mimi/shared';
import { Cron } from 'croner';
import type { Db } from '../db/db.ts';

export interface Trigger extends TriggerInfo {
  /** The raw key behind `webhook`, for the file mirror. */
  webhookKey: string | null;
  deviceSynced: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewTrigger {
  kind: 'reminder' | 'agent_task';
  title: string;
  text: string;
  /** Local date-time ("2026-10-13T09:00:00", read in the core's time zone) or one with an offset. */
  fireAt?: string;
  cron?: string;
  /** Fire on a webhook call instead of a schedule. */
  webhook?: boolean;
  agent?: string | null;
  repeat?: boolean;
  /** Set when the schedule belongs to a workflow; the action then runs that workflow. */
  workflow?: string;
}

export type TriggerPatch = Partial<Pick<NewTrigger, 'title' | 'text' | 'agent' | 'fireAt' | 'cron' | 'repeat'>>;

/** A rejected trigger change; the message is safe to hand to a model. */
export class TriggerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriggerError';
  }
}

interface TriggerRow {
  id: number;
  kind: 'reminder' | 'agent_task';
  title: string;
  fire_at: string | null;
  cron: string | null;
  webhook_key: string | null;
  payload: string;
  agent: string | null;
  repeat: number;
  status: 'active' | 'fired' | 'cancelled';
  device_synced: number;
  next_fire_at: string | null;
  last_fired_at: string | null;
  last_result: string | null;
  created_at: string;
  updated_at: string;
}

function toTrigger(row: TriggerRow): Trigger {
  const payload = JSON.parse(row.payload) as { text?: string; workflow?: string };
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    text: payload.text ?? '',
    fireAt: row.fire_at,
    cron: row.cron,
    webhook: row.webhook_key ? `/api/webhook/${row.webhook_key}` : null,
    webhookKey: row.webhook_key,
    agent: row.agent,
    repeat: row.repeat === 1,
    status: row.status,
    nextFireAt: row.next_fire_at,
    lastFiredAt: row.last_fired_at,
    lastResult: row.last_result,
    workflow: payload.workflow ?? null,
    deviceSynced: row.device_synced === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTriggerInfo(trigger: Trigger): TriggerInfo {
  const { id, kind, title, text, fireAt, cron, webhook, agent, repeat, status, nextFireAt, lastFiredAt, lastResult, workflow } = trigger;
  return { id, kind, title, text, fireAt, cron, webhook, agent, repeat, status, nextFireAt, lastFiredAt, lastResult, workflow };
}

/** Next time a cron pattern or a one-shot date-time fires after `from`, in `timezone`. */
export function nextRun(pattern: string, timezone: string, from: Date): Date | null {
  try {
    return new Cron(pattern, { timezone, paused: true }).nextRun(from);
  } catch (error) {
    throw new TriggerError(`Invalid schedule "${pattern}": ${(error as Error).message}`);
  }
}

/** Parses a one-shot time. Without an offset it is local time in `timezone`. */
function parseFireAt(value: string, timezone: string, now: Date): Date {
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
  const date = hasOffset ? new Date(value) : nextRun(value.trim(), timezone, new Date(0));
  if (!date || Number.isNaN(date.getTime())) {
    throw new TriggerError(`Invalid fire_at "${value}". Use a date-time like 2026-10-13T09:00:00.`);
  }
  if (date.getTime() <= now.getTime()) {
    throw new TriggerError(`fire_at "${value}" is in the past (now: ${now.toISOString()}).`);
  }
  return date;
}

/** Persistent triggers. Scheduling state lives in the database, never only in memory. */
export class TriggerStore {
  private readonly db: Db;
  private readonly timezone: string;
  private readonly now: () => Date;
  /** Called after every change, so the file mirror under `triggers/` stays in step. */
  onChange: ((trigger: Trigger) => void) | undefined;
  onDelete: ((id: number) => void) | undefined;

  constructor(db: Db, timezone: string, now: () => Date = () => new Date()) {
    this.db = db;
    this.timezone = timezone;
    this.now = now;
  }

  private schedule(fireAt: string | undefined, cron: string | undefined): { fireAt: string | null; cron: string | null; next: string } {
    if ((fireAt === undefined) === (cron === undefined)) {
      throw new TriggerError('Give exactly one of fire_at (one-shot) or cron (recurring).');
    }
    const now = this.now();
    if (fireAt !== undefined) {
      const date = parseFireAt(fireAt, this.timezone, now).toISOString();
      return { fireAt: date, cron: null, next: date };
    }
    const next = nextRun(cron!, this.timezone, now);
    if (!next) throw new TriggerError(`Schedule "${cron}" never fires.`);
    return { fireAt: null, cron: cron!, next: next.toISOString() };
  }

  create(input: NewTrigger): Trigger {
    if (!input.title.trim()) throw new TriggerError('A trigger needs a title.');
    if (!input.text.trim()) throw new TriggerError('A trigger needs text.');
    let fireAt: string | null = null;
    let cron: string | null = null;
    let next: string | null = null;
    let webhookKey: string | null = null;
    if (input.webhook) {
      webhookKey = randomBytes(18).toString('base64url');
    } else {
      ({ fireAt, cron, next } = this.schedule(input.fireAt, input.cron));
    }
    const result = this.db
      .prepare(
        `INSERT INTO triggers (kind, title, fire_at, cron, webhook_key, payload, agent, repeat, next_fire_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.title.trim(),
        fireAt,
        cron,
        webhookKey,
        JSON.stringify({ text: input.text.trim(), ...(input.workflow ? { workflow: input.workflow } : {}) }),
        input.agent ?? null,
        // A cron trigger repeats unless told otherwise; anything else never does.
        cron !== null && input.repeat !== false ? 1 : 0,
        next,
      );
    const created = this.get(Number(result.lastInsertRowid))!;
    this.onChange?.(created);
    return created;
  }

  get(id: number): Trigger | undefined {
    const row = this.db.prepare(`SELECT * FROM triggers WHERE id = ?`).get(id) as TriggerRow | undefined;
    return row && toTrigger(row);
  }

  /** Looks up a webhook trigger by the key in its URL. */
  byWebhookKey(key: string): Trigger | undefined {
    if (!key || key.length > 200) return undefined;
    const row = this.db.prepare(`SELECT * FROM triggers WHERE webhook_key = ?`).get(key) as TriggerRow | undefined;
    return row && toTrigger(row);
  }

  /** The schedule a workflow keeps in the triggers table, if any. */
  byWorkflow(name: string): Trigger | undefined {
    const row = this.db.prepare(`SELECT * FROM triggers WHERE json_extract(payload, '$.workflow') = ?`).get(name) as
      | TriggerRow
      | undefined;
    return row && toTrigger(row);
  }

  list(status?: Trigger['status']): Trigger[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM triggers WHERE status = ? ORDER BY next_fire_at, id`).all(status)
        : this.db.prepare(`SELECT * FROM triggers ORDER BY status, next_fire_at, id`).all()
    ) as TriggerRow[];
    return rows.map(toTrigger);
  }

  update(id: number, patch: TriggerPatch): Trigger {
    const current = this.get(id);
    if (!current) throw new TriggerError(`No trigger #${id}.`);
    if (current.status !== 'active') throw new TriggerError(`Trigger #${id} is ${current.status}; create a new one.`);

    let { fireAt, cron, nextFireAt: next } = current;
    // A webhook trigger has no schedule; editing its text does not touch the URL.
    if (!current.webhook && (patch.fireAt !== undefined || patch.cron !== undefined)) {
      const scheduled = this.schedule(patch.fireAt, patch.cron);
      ({ fireAt, cron } = scheduled);
      next = scheduled.next;
    }
    const repeat = cron !== null && (patch.repeat ?? current.repeat);
    this.db
      .prepare(
        `UPDATE triggers
            SET title = ?, payload = ?, agent = ?, fire_at = ?, cron = ?, repeat = ?, next_fire_at = ?,
                device_synced = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?`,
      )
      .run(
        patch.title?.trim() || current.title,
        JSON.stringify({ text: patch.text?.trim() || current.text, ...(current.workflow ? { workflow: current.workflow } : {}) }),
        patch.agent !== undefined ? patch.agent : current.agent,
        fireAt,
        cron,
        repeat ? 1 : 0,
        next,
        id,
      );
    const updated = this.get(id)!;
    this.onChange?.(updated);
    return updated;
  }

  cancel(id: number): Trigger {
    const current = this.get(id);
    if (!current) throw new TriggerError(`No trigger #${id}.`);
    this.db
      .prepare(
        `UPDATE triggers SET status = 'cancelled', next_fire_at = NULL, device_synced = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?`,
      )
      .run(id);
    const cancelled = this.get(id)!;
    this.onChange?.(cancelled);
    return cancelled;
  }

  /** Removes a trigger from the database and the file mirror. */
  delete(id: number): boolean {
    const result = this.db.prepare(`DELETE FROM triggers WHERE id = ?`).run(id);
    if (result.changes > 0) this.onDelete?.(id);
    return result.changes > 0;
  }

  /** Active triggers whose time has come, oldest first. */
  due(): Trigger[] {
    const rows = this.db
      .prepare(`SELECT * FROM triggers WHERE status = 'active' AND next_fire_at <= ? ORDER BY next_fire_at, id`)
      .all(this.now().toISOString()) as TriggerRow[];
    return rows.map(toTrigger);
  }

  /**
   * Advances a trigger past the current firing: a repeating one gets its next time,
   * anything else is done. Called before the trigger's action runs, so a crash
   * mid-action cannot make it fire twice.
   */
  advance(trigger: Trigger): void {
    const now = this.now();
    const next = trigger.cron && trigger.repeat ? nextRun(trigger.cron, this.timezone, now) : null;
    this.db
      .prepare(
        `UPDATE triggers
            SET status = ?, next_fire_at = ?, last_fired_at = ?, device_synced = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?`,
      )
      .run(next ? 'active' : 'fired', next?.toISOString() ?? null, now.toISOString(), trigger.id);
    const advanced = this.get(trigger.id);
    if (advanced) this.onChange?.(advanced);
  }

  /** Records that a trigger fired outside the scheduler's due-check (a webhook or a manual run). */
  markFired(id: number): void {
    this.db
      .prepare(
        `UPDATE triggers SET last_fired_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
      .run(this.now().toISOString(), id);
    const updated = this.get(id);
    if (updated) this.onChange?.(updated);
  }

  setResult(id: number, result: string): void {
    this.db
      .prepare(`UPDATE triggers SET last_result = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(result, id);
    const updated = this.get(id);
    if (updated) this.onChange?.(updated);
  }

  /** Marks triggers as known to the user's device (which sets its own alarms for them). */
  markSynced(ids: number[]): void {
    const mark = this.db.prepare(`UPDATE triggers SET device_synced = 1 WHERE id = ?`);
    this.db.transaction(() => ids.forEach((id) => mark.run(id)))();
  }

  /**
   * Inserts a trigger that came back from a synced file, keeping its id. Scheduled
   * one-shot times in the past arrive as "fired" instead of firing late.
   */
  import(trigger: {
    id: number;
    kind: 'reminder' | 'agent_task';
    title: string;
    text: string;
    fireAt: string | null;
    cron: string | null;
    webhookKey: string | null;
    agent: string | null;
    repeat: boolean;
    status: 'active' | 'fired' | 'cancelled';
    createdAt: string;
    updatedAt: string;
    lastFiredAt: string | null;
    lastResult: string | null;
    workflow?: string | null;
  }): Trigger {
    const now = this.now();
    let status = trigger.status;
    let next: string | null = null;
    if (trigger.webhookKey) {
      // Webhooks are always ready to fire.
    } else if (trigger.cron) {
      const when = nextRun(trigger.cron, this.timezone, now);
      next = when?.toISOString() ?? null;
      if (!next && status === 'active') status = 'fired';
    } else if (trigger.fireAt) {
      if (new Date(trigger.fireAt).getTime() > now.getTime()) next = trigger.fireAt;
      else if (status === 'active') status = 'fired';
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO triggers
          (id, kind, title, fire_at, cron, webhook_key, payload, agent, repeat, status, device_synced, created_at, next_fire_at, last_fired_at, last_result, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        trigger.id,
        trigger.kind,
        trigger.title,
        trigger.fireAt,
        trigger.cron,
        trigger.webhookKey,
        JSON.stringify({ text: trigger.text, ...(trigger.workflow ? { workflow: trigger.workflow } : {}) }),
        trigger.agent,
        trigger.repeat ? 1 : 0,
        status,
        trigger.createdAt,
        next,
        trigger.lastFiredAt,
        trigger.lastResult,
        trigger.updatedAt,
      );
    return this.get(trigger.id)!;
  }

  /** Replaces a row with the newer copy from a synced file. */
  replace(id: number, trigger: Parameters<TriggerStore['import']>[0]): Trigger {
    return this.import({ ...trigger, id });
  }
}
