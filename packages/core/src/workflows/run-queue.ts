export interface RunQueueOptions {
  /** Runs across every agent; default 8. */
  globalConcurrency?: number;
  /** Runs per agent; default 4. */
  perAgent?: number;
  /** Runs per workflow; default 1. */
  perWorkflow?: number;
}

export interface RunQueueJob<T> {
  agent: string;
  workflow?: string;
  task(signal: AbortSignal): Promise<T>;
}

export interface QueuedRun<T> {
  id: string;
  promise: Promise<T>;
  cancel(): boolean;
}

export class RunCancelledError extends Error {
  readonly runId: string;

  constructor(message = 'workflow run cancelled', runId = '') {
    super(message);
    this.name = 'RunCancelledError';
    this.runId = runId;
  }
}

interface Entry {
  id: string;
  agent: string;
  workflow?: string;
  task(signal: AbortSignal): Promise<unknown>;
  controller: AbortController;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  settled: boolean;
}

function limit(value: number | undefined, fallback: number): number {
  const rounded = Math.floor(Number(value));
  return Number.isFinite(rounded) && rounded > 0 ? rounded : fallback;
}

/** FIFO workflow runs with per-agent and per-workflow concurrency limits. */
export class RunQueue {
  private readonly globalConcurrency: number;
  private readonly perAgent: number;
  private readonly perWorkflow: number;
  private readonly pending: Entry[] = [];
  private readonly running = new Set<Entry>();
  private readonly agentCounts = new Map<string, number>();
  private readonly workflowCounts = new Map<string, number>();
  private sequence = 0;
  private closed = false;

  constructor(options: RunQueueOptions = {}) {
    this.globalConcurrency = limit(options.globalConcurrency, 8);
    this.perAgent = limit(options.perAgent, 4);
    this.perWorkflow = limit(options.perWorkflow, 1);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.running.size;
  }

  enqueue<T>(job: RunQueueJob<T>): QueuedRun<T> {
    if (this.closed) {
      const error = new RunCancelledError('workflow queue is closed');
      return { id: '', promise: Promise.reject(error), cancel: () => false };
    }
    const id = `run-${++this.sequence}`;
    const controller = new AbortController();
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const entry: Entry = {
      id,
      agent: job.agent,
      ...(job.workflow ? { workflow: job.workflow } : {}),
      task: job.task,
      controller,
      resolve: (value) => resolve(value as T),
      reject,
      settled: false,
    };
    this.pending.push(entry);
    this.drain();
    return { id, promise, cancel: () => this.cancel(id) };
  }

  cancel(id: string): boolean {
    const queued = this.pending.findIndex((entry) => entry.id === id);
    if (queued >= 0) {
      const [entry] = this.pending.splice(queued, 1);
      this.abort(entry!, `workflow run ${id} cancelled`);
      return true;
    }
    for (const entry of this.running) {
      if (entry.id !== id) continue;
      if (!entry.settled) this.abort(entry, `workflow run ${id} cancelled`);
      return true;
    }
    return false;
  }

  cancelAgent(agent: string): number {
    return this.cancelMany((entry) => entry.agent === agent);
  }

  cancelWorkflow(agent: string, workflow: string): number {
    return this.cancelMany((entry) => entry.agent === agent && entry.workflow === workflow);
  }

  close(reason = 'workflow queue closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.pending, ...this.running]) {
      if (!entry.settled) this.abort(entry, reason);
    }
    this.pending.length = 0;
  }

  private cancelMany(match: (entry: Entry) => boolean): number {
    const ids = [...this.pending, ...this.running].filter((entry) => !entry.settled && match(entry)).map((entry) => entry.id);
    let cancelled = 0;
    for (const id of ids) if (this.cancel(id)) cancelled++;
    return cancelled;
  }

  private abort(entry: Entry, message: string): void {
    entry.settled = true;
    const error = new RunCancelledError(message, entry.id);
    entry.controller.abort(error);
    entry.reject(error);
  }

  private drain(): void {
    while (!this.closed && this.running.size < this.globalConcurrency) {
      const index = this.pending.findIndex((entry) => this.withinLimits(entry));
      if (index < 0) return;
      const [entry] = this.pending.splice(index, 1);
      this.start(entry!);
    }
  }

  private withinLimits(entry: Entry): boolean {
    if ((this.agentCounts.get(entry.agent) ?? 0) >= this.perAgent) return false;
    if (entry.workflow && (this.workflowCounts.get(`${entry.agent}/${entry.workflow}`) ?? 0) >= this.perWorkflow) return false;
    return true;
  }

  private start(entry: Entry): void {
    this.running.add(entry);
    this.agentCounts.set(entry.agent, (this.agentCounts.get(entry.agent) ?? 0) + 1);
    const workflowKey = entry.workflow ? `${entry.agent}/${entry.workflow}` : undefined;
    if (workflowKey) this.workflowCounts.set(workflowKey, (this.workflowCounts.get(workflowKey) ?? 0) + 1);
    void Promise.resolve()
      .then(() => entry.task(entry.controller.signal))
      .then(
        (value) => {
          if (entry.settled) return;
          entry.settled = true;
          entry.resolve(value);
        },
        (error: unknown) => {
          if (entry.settled) return;
          entry.settled = true;
          entry.reject(error);
        },
      )
      .finally(() => {
        this.running.delete(entry);
        const agentCount = (this.agentCounts.get(entry.agent) ?? 1) - 1;
        if (agentCount > 0) this.agentCounts.set(entry.agent, agentCount);
        else this.agentCounts.delete(entry.agent);
        if (workflowKey) {
          const workflowCount = (this.workflowCounts.get(workflowKey) ?? 1) - 1;
          if (workflowCount > 0) this.workflowCounts.set(workflowKey, workflowCount);
          else this.workflowCounts.delete(workflowKey);
        }
        entry.settled = true;
        this.drain();
      });
  }
}
