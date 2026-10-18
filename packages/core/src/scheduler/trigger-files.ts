import fs from 'node:fs';
import path from 'node:path';
import type { Trigger, TriggerStore } from './triggers.ts';

/** One trigger as it travels between machines: `triggers/<id>.json`. */
export interface TriggerFile {
  version: 1;
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
  /** Last change; the newer side (database or file) wins when they meet. */
  updatedAt: string;
  lastFiredAt: string | null;
  lastResult: string | null;
  /** Set when the schedule belongs to a workflow. */
  workflow?: string | null;
}

/**
 * Mirror of the triggers table as files next to `agents/` and `skills/`. The database
 * stays the scheduler's source of truth; the files make triggers travel with a synced
 * folder. No secrets live here — a webhook key is a capability, not a credential.
 */
export class TriggerFiles {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(id: number): string {
    return path.join(this.dir, `${id}.json`);
  }

  write(trigger: Omit<TriggerFile, 'version'>): void {
    const file: TriggerFile = {
      version: 1,
      id: trigger.id,
      kind: trigger.kind,
      title: trigger.title,
      text: trigger.text,
      fireAt: trigger.fireAt,
      cron: trigger.cron,
      webhookKey: trigger.webhookKey,
      agent: trigger.agent,
      repeat: trigger.repeat,
      status: trigger.status,
      createdAt: trigger.createdAt,
      updatedAt: trigger.updatedAt,
      lastFiredAt: trigger.lastFiredAt,
      lastResult: trigger.lastResult,
      workflow: trigger.workflow ?? null,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(trigger.id), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  remove(id: number): void {
    fs.rmSync(this.file(id), { force: true });
  }

  readAll(): TriggerFile[] {
    if (!fs.existsSync(this.dir)) return [];
    const files: TriggerFile[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      const match = /^(\d+)\.json$/.exec(name);
      if (!match) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as TriggerFile;
        if (raw && typeof raw.id === 'number' && typeof raw.updatedAt === 'string') files.push(raw);
      } catch {
        // a half-written or hand-broken file must not stop the scheduler
      }
    }
    return files;
  }

  /**
   * Makes database and files agree: files the database never saw are imported, a file
   * newer than its row replaces the row, and everything else is (re)written.
   */
  reconcile(store: TriggerStore): { imported: number; updated: number; exported: number } {
    let imported = 0;
    let updated = 0;
    let exported = 0;
    const seen = new Set<number>();
    for (const file of this.readAll()) {
      seen.add(file.id);
      const current = store.get(file.id);
      if (!current) {
        store.import(file);
        imported++;
      } else if (file.updatedAt > current.updatedAt) {
        store.replace(file.id, file);
        updated++;
      } else {
        this.write(current);
        exported++;
      }
    }
    for (const trigger of store.list()) {
      if (!seen.has(trigger.id)) {
        this.write(trigger);
        exported++;
      }
    }
    return { imported, updated, exported };
  }
}
