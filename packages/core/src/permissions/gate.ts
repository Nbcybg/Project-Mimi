import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionRequest, RiskLevel } from '@mimi/shared';

export type RiskPolicy = Record<RiskLevel, 'auto' | 'ask'>;

/** Read-only runs on its own; anything with side effects needs the user. */
export const DEFAULT_POLICY: RiskPolicy = {
  read: 'auto',
  write: 'ask',
  shell: 'ask',
  delete: 'ask',
  network: 'ask',
};

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
}

export type PermissionAsk = Omit<PermissionRequest, 'id' | 'timeoutMs' | 'createdAt'>;

export class PermissionGate {
  private readonly broker: PermissionBroker;
  private readonly timeoutMs: number;
  private readonly policy: RiskPolicy;
  private readonly overrides: Record<string, ToolPermission>;

  constructor(broker: PermissionBroker, options: PermissionGateOptions = {}) {
    this.broker = broker;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.overrides = options.overrides ?? {};
  }

  needsApproval(risk: RiskLevel): boolean {
    return this.policy[risk] !== 'auto';
  }

  /** How a call to `tool` is handled: run it, ask the user first, or refuse outright. */
  modeFor(tool: string, risk: RiskLevel): 'auto' | 'ask' | 'deny' {
    const override = this.overrides[tool];
    if (override === 'deny') return 'deny';
    if (override === 'allow') return 'auto';
    if (override === 'ask') return 'ask';
    return this.policy[risk];
  }

  createRequest(ask: PermissionAsk): PermissionRequest {
    return { ...ask, id: randomUUID(), timeoutMs: this.timeoutMs, createdAt: new Date().toISOString() };
  }

  /** Asks the user. No answer within the timeout, or a broker failure, counts as a denial. */
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const mode = this.modeFor(request.tool, request.risk);
    if (mode === 'auto') return { allow: true, via: 'auto' };
    if (mode === 'deny') return { allow: false, reason: 'denied' };

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<PermissionDecision>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ allow: false, reason: 'timeout' });
      }, request.timeoutMs);
    });
    const answer = this.broker.request(request, controller.signal).then(
      (allowed): PermissionDecision =>
        allowed ? { allow: true, via: 'user' } : { allow: false, reason: 'denied' },
      (): PermissionDecision => ({ allow: false, reason: 'error' }),
    );

    try {
      return await Promise.race([answer, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
