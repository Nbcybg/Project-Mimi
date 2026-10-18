export interface TraceLimits {
  maxTokens: number;
  maxRounds: number;
  maxMs: number;
}

/**
 * Spending cap shared by every agent run inside one trace (a user turn or a
 * scheduled task and everything it delegates). Per-agent budgets alone cannot
 * stop agents from passing work back and forth forever.
 */
export class TraceBudget {
  private readonly limits: TraceLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private tokens = 0;
  private rounds = 0;

  constructor(limits: TraceLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.startedAt = now();
  }

  /** Records one model call. */
  charge(tokens: number): void {
    this.tokens += tokens;
    this.rounds += 1;
  }

  /** Why the trace must stop, or null while there is budget left. */
  exhausted(): string | null {
    if (this.tokens >= this.limits.maxTokens) {
      return `Trace token budget used up (${this.tokens} of ${this.limits.maxTokens}).`;
    }
    if (this.rounds >= this.limits.maxRounds) {
      return `Trace round budget used up (${this.rounds} of ${this.limits.maxRounds} model calls).`;
    }
    if (this.now() - this.startedAt >= this.limits.maxMs) {
      return `Trace time budget used up (${Math.round(this.limits.maxMs / 1000)}s).`;
    }
    return null;
  }
}
