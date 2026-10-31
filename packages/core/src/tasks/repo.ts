import { randomUUID } from 'node:crypto';
import type {
  TaskGateView,
  TaskLevel,
  TaskPlanView,
  TaskReceiptView,
  TaskStepView,
  TaskVerificationView,
  TaskView,
} from '@mimi/shared';
import type { Db } from '../db/db.ts';

export interface TaskUndo {
  tool: string;
  input: Record<string, unknown>;
  /** A read-only check that the undo really restored what the receipt says. */
  verify?: { tool: string; input: Record<string, unknown> };
}

/** A stored task plus the local undo recipe (not sent to chat clients). */
export interface TaskRecord extends TaskView {
  undo?: TaskUndo;
}

interface TaskRow {
  id: string;
  goal: string;
  recipe: string;
  level: TaskLevel;
  status: TaskView['status'];
  agent: string;
  input: string;
  steps: string;
  gates: string;
  plan: string | null;
  verification: string | null;
  receipt: string | null;
  undo_receipt: string | null;
  undo: string | null;
  trace_id: string;
  thread: string;
  chat_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

function decode<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    goal: row.goal,
    recipe: row.recipe,
    level: row.level,
    status: row.status,
    agent: row.agent,
    input: decode<Record<string, unknown>>(row.input, {}),
    steps: decode<TaskStepView[]>(row.steps, []),
    gates: decode<TaskGateView[]>(row.gates, []),
    plan: decode<TaskPlanView | undefined>(row.plan, undefined),
    verification: decode<TaskVerificationView | undefined>(row.verification, undefined),
    receipt: decode<TaskReceiptView | undefined>(row.receipt, undefined),
    undoReceipt: decode<TaskReceiptView | undefined>(row.undo_receipt, undefined),
    undo: decode<TaskUndo | undefined>(row.undo, undefined),
    traceId: row.trace_id,
    thread: row.thread,
    ...(row.chat_id !== null ? { chatId: row.chat_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

/** What a chat client may see: the stored task without the local undo descriptor. */
export function taskView(task: TaskRecord): TaskView {
  const { undo: _undo, ...view } = task;
  return view;
}

export class TaskRepo {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  create(input: {
    goal: string;
    recipe: string;
    level: TaskLevel;
    agent: string;
    traceId: string;
    thread: string;
    chatId?: number;
    input: Record<string, unknown>;
    steps: Array<{ id: string; title: string }>;
  }): TaskRecord {
    const stamp = this.now().toISOString();
    const record: TaskRecord = {
      id: randomUUID(),
      goal: input.goal,
      recipe: input.recipe,
      level: input.level,
      status: 'running',
      agent: input.agent,
      input: input.input,
      steps: input.steps.map((step) => ({ ...step, status: 'pending' })),
      gates: [],
      traceId: input.traceId,
      thread: input.thread,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, goal, recipe, level, status, agent, input, steps, gates, trace_id, thread, chat_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.goal,
        record.recipe,
        record.level,
        record.status,
        record.agent,
        JSON.stringify(record.input),
        JSON.stringify(record.steps),
        JSON.stringify(record.gates),
        record.traceId,
        record.thread,
        record.chatId ?? null,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  save(record: TaskRecord): void {
    record.updatedAt = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET
           goal = ?, recipe = ?, level = ?, status = ?, agent = ?, input = ?, steps = ?, gates = ?,
           plan = ?, verification = ?, receipt = ?, undo_receipt = ?, undo = ?, trace_id = ?, thread = ?, chat_id = ?,
           error = ?, created_at = ?, updated_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        record.goal,
        record.recipe,
        record.level,
        record.status,
        record.agent,
        JSON.stringify(record.input),
        JSON.stringify(record.steps),
        JSON.stringify(record.gates),
        record.plan === undefined ? null : JSON.stringify(record.plan),
        record.verification === undefined ? null : JSON.stringify(record.verification),
        record.receipt === undefined ? null : JSON.stringify(record.receipt),
        record.undoReceipt === undefined ? null : JSON.stringify(record.undoReceipt),
        record.undo === undefined ? null : JSON.stringify(record.undo),
        record.traceId,
        record.thread,
        record.chatId ?? null,
        record.error ?? null,
        record.createdAt,
        record.updatedAt,
        record.finishedAt ?? null,
        record.id,
      );
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row && toRecord(row);
  }

  list(thread?: string, limit = 50): TaskRecord[] {
    const rows = thread
      ? (this.db.prepare('SELECT * FROM tasks WHERE thread = ? ORDER BY created_at DESC LIMIT ?').all(thread, limit) as TaskRow[])
      : (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as TaskRow[]);
    return rows.map(toRecord);
  }

  latest(thread: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE thread = ? ORDER BY created_at DESC LIMIT 1').get(thread) as
      | TaskRow
      | undefined;
    return row && toRecord(row);
  }

  /** Tasks a restart interrupted: running, waiting for a person, or paused. */
  markInterrupted(): number {
    const stamp = this.now().toISOString();
    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE status IN ('running', 'awaiting_confirmation', 'paused')`)
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      this.db
        .prepare(`UPDATE tasks SET status = 'paused', error = ?, updated_at = ? WHERE id = ?`)
        .run('Interrupted by a restart; resume or cancel it.', stamp, row.id);
    }
    return rows.length;
  }

  /** Audit export: one JSON object per task, without the local undo descriptor. */
  exportJsonl(options: { thread?: string; limit?: number } = {}): string {
    return this.list(options.thread, options.limit ?? 1_000)
      .map((task) => JSON.stringify(taskView(task)))
      .join('\n');
  }
}
