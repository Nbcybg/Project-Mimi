import { Cron } from 'croner';
import type { Trigger, TriggerStore } from './triggers.ts';

export interface SchedulerOptions {
  store: TriggerStore;
  /** Performs the trigger's action and returns what to record as its result. */
  fire: (trigger: Trigger) => Promise<string>;
  /** Cron pattern for how often the database is checked. */
  tickPattern?: string;
  onError?: (trigger: Trigger, error: Error) => void;
}

/**
 * Fires due triggers. All state is in the database: the clock tick only asks "what is
 * due now?", so triggers created, changed or missed while the process was down are
 * handled the same way as any other.
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  private job: Cron | null = null;
  private running: Promise<number> | null = null;

  constructor(options: SchedulerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.job) return;
    this.job = new Cron(this.options.tickPattern ?? '*/15 * * * * *', () => void this.tick());
    void this.tick(); // catch up on anything that came due while the process was down
  }

  stop(): void {
    this.job?.stop();
    this.job = null;
  }

  /** Fires everything that is due. Overlapping calls share one pass. Returns how many fired. */
  tick(): Promise<number> {
    this.running ??= this.runDue().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runDue(): Promise<number> {
    const { store, fire, onError } = this.options;
    const due = store.due();
    for (const trigger of due) {
      store.advance(trigger);
      try {
        store.setResult(trigger.id, await fire(trigger));
      } catch (error) {
        store.setResult(trigger.id, `error: ${(error as Error).message}`);
        onError?.(trigger, error as Error);
      }
    }
    return due.length;
  }
}
