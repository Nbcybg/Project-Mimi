import type { TaskPlanView, TaskReceiptView, TaskVerificationView } from '@mimi/shared';

/** A recipe that deliberately stops (the user refused, or the task was cancelled). */
export class TaskStoppedError extends Error {
  readonly status: 'cancelled';

  constructor(message: string) {
    super(message);
    this.name = 'TaskStoppedError';
    this.status = 'cancelled';
  }
}

/** Tool output is JSON text; recipes read it without guessing at prose. */
export function parseToolJson<T>(output: string): T {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`The tool did not return JSON: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start, end + 1)) as T;
}

export function receiptFrom(value: {
  summary?: unknown;
  moved?: unknown;
  skipped?: unknown;
  failed?: unknown;
  examples?: unknown;
  journal?: unknown;
}): TaskReceiptView {
  const moved = Number(value.moved ?? 0);
  const failed = Number(value.failed ?? 0);
  return {
    summary: String(value.summary ?? ''),
    moved,
    skipped: Number(value.skipped ?? 0),
    failed,
    examples: Array.isArray(value.examples) ? value.examples.map(String).slice(0, 10) : [],
    ...(typeof value.journal === 'string' ? { journal: value.journal } : {}),
    // Even a partial apply can be restored; the journal knows which files actually moved.
    undoable: moved > 0 && typeof value.journal === 'string',
  };
}

export function planFrom(value: {
  folder?: unknown;
  policy?: unknown;
  total?: unknown;
  deferred?: unknown;
  groups?: unknown;
  skipped?: unknown;
}): TaskPlanView {
  const groups = Array.isArray(value.groups)
    ? value.groups.map((group) => {
        const entry = (group ?? {}) as Record<string, unknown>;
        return {
          key: String(entry.key ?? 'other'),
          count: Number(entry.count ?? 0),
          examples: Array.isArray(entry.examples) ? entry.examples.map(String).slice(0, 5) : [],
        };
      })
    : [];
  const skipped = Array.isArray(value.skipped)
    ? value.skipped.map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        return { name: String(item.name ?? ''), reason: String(item.reason ?? '') };
      })
    : [];
  return {
    folder: String(value.folder ?? ''),
    policy: value.policy === 'skip' || value.policy === 'overwrite' ? value.policy : 'rename',
    total: Number(value.total ?? 0),
    ...(value.deferred === undefined ? {} : { deferred: Number(value.deferred) }),
    groups,
    skipped,
  };
}

export function verificationFrom(value: { ok?: unknown; summary?: unknown }): TaskVerificationView {
  return { ok: value.ok === true, summary: String(value.summary ?? '') };
}
