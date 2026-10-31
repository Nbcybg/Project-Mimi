import { randomUUID } from 'node:crypto';
import { type PermissionDecision, type PermissionRequest, type RiskLevel, toolFamily } from '@mimi/shared';

export type RiskPolicy = Record<RiskLevel, 'auto' | 'ask'>;

/** Read-only runs on its own; anything with side effects needs the user. */
export const DEFAULT_POLICY: RiskPolicy = {
  read: 'auto',
  write: 'ask',
  shell: 'ask',
  delete: 'ask',
  network: 'ask',
};

/** Assistant work waits for a person to read the summary; two minutes was too short. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_GRANT_TTL_MS = 30 * 60_000;

/**
 * Puts a permission request in front of the user. The CLI implements this with a
 * terminal prompt; the WebSocket server will broadcast to every connected client.
 * `signal` aborts when the request times out, so the broker can withdraw its prompt.
 */
export interface PermissionBroker {
  request(request: PermissionRequest, signal: AbortSignal): Promise<boolean>;
}

/** Per-tool override from the settings file, like opencode's `permission` block. */
export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface PermissionGateOptions {
  timeoutMs?: number;
  policy?: RiskPolicy;
  /** Tool name -> override of what its risk level would normally mean. */
  overrides?: Record<string, ToolPermission>;
  /** How long "allow for this task" lasts, in milliseconds. */
  grantTtlMs?: number;
  /** Test seam for grant expiry. */
  now?: () => number;
}

export type PermissionAsk = Omit<PermissionRequest, 'id' | 'timeoutMs' | 'createdAt'>;

export class PermissionGate {
  private readonly broker: PermissionBroker;
  private readonly timeoutMs: number;
  private readonly policy: RiskPolicy;
  private readonly overrides: Record<string, ToolPermission>;
  private readonly grantTtlMs: number;
  private readonly now: () => number;
  /** `${traceId}\0${toolFamily}` -> epoch milliseconds when the grant ends. */
  private readonly grants = new Map<string, number>();

  constructor(broker: PermissionBroker, options: PermissionGateOptions = {}) {
    this.broker = broker;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.overrides = options.overrides ?? {};
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  needsApproval(risk: RiskLevel): boolean {
    return this.policy[risk] !== 'auto';
  }

  private key(traceId: string, tool: string): string {
    return `${traceId}\u0000${toolFamily(tool)}`;
  }

  /**
   * Remembers that the user allowed this tool family for the rest of `traceId`'s work.
   * A tool the settings deny outright is never granted.
   */
  grant(traceId: string, tool: string, ttlMs = this.grantTtlMs): boolean {
    if (this.overrides[tool] === 'deny') return false;
    this.prune();
    this.grants.set(this.key(traceId, tool), this.now() + Math.max(1, ttlMs));
    return true;
  }

  /** True while a task-scoped grant for this tool is still valid. */
  granted(traceId: string, tool: string): boolean {
    this.prune();
    return this.grants.has(this.key(traceId, tool));
  }

  /** Drops a task grant (all of them for a trace when no tool is given). */
  revoke(traceId: string, tool?: string): void {
    if (tool) {
      this.grants.delete(this.key(traceId, tool));
      return;
    }
    const prefix = `${traceId}\u0000`;
    for (const key of this.grants.keys()) {
      if (key.startsWith(prefix)) this.grants.delete(key);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.grants) {
      if (expiresAt <= now) this.grants.delete(key);
    }
  }

  /** How a call to `tool` is handled: run it, ask the user first, or refuse outright. */
  modeFor(tool: string, risk: RiskLevel, traceId?: string): 'auto' | 'ask' | 'deny' {
    const override = this.overrides[tool];
    if (override === 'deny') return 'deny';
    // A grant covers a policy "ask"; it never turns a deny into an allow.
    if (traceId && this.granted(traceId, tool)) return 'auto';
    if (override === 'allow') return 'auto';
    if (override === 'ask') return 'ask';
    return this.policy[risk];
  }

  createRequest(ask: PermissionAsk): PermissionRequest {
    return { ...ask, id: randomUUID(), timeoutMs: this.timeoutMs, createdAt: new Date().toISOString() };
  }

  /**
   * Asks the user. No answer within the timeout, a broker failure, or the caller
   * being stopped counts as a denial. An external stop also withdraws the prompt.
   */
  async decide(request: PermissionRequest, signal?: AbortSignal): Promise<PermissionDecision> {
    const mode = this.modeFor(request.tool, request.risk, request.traceId);
    if (mode === 'auto') return { allow: true, via: 'auto' };
    if (mode === 'deny') return { allow: false, reason: 'denied' };
    if (signal?.aborted) return { allow: false, reason: 'denied' };

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<PermissionDecision>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ allow: false, reason: 'timeout' });
      }, request.timeoutMs);
    });
    const stopped = new Promise<PermissionDecision>((resolve) => {
      if (!signal) return;
      onAbort = () => {
        controller.abort();
        resolve({ allow: false, reason: 'denied' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const answer = this.broker.request(request, controller.signal).then(
      (allowed): PermissionDecision =>
        allowed ? { allow: true, via: 'user' } : { allow: false, reason: 'denied' },
      (): PermissionDecision => ({ allow: false, reason: 'error' }),
    );

    try {
      return await Promise.race([answer, timeout, stopped]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }
}
