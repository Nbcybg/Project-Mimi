import { randomUUID } from 'node:crypto';
import { type PermissionDecision, type PermissionRequest, type PermissionScope, type RiskLevel, isAlwaysAskTool, toolFamily } from '@mimi/shared';

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
  /** Tool families the user allowed forever, per agent; loaded once and saved when one changes. */
  alwaysLoad?: () => Record<string, string[]>;
  alwaysSave?: (grants: Record<string, string[]>) => void;
  /** Test seam for grant expiry. */
  now?: () => number;
}

export interface GrantOptions {
  /** Defaults to "task". */
  scope?: PermissionScope;
  /** Required for a session grant. */
  thread?: string;
  /** The agent the grant belongs to; a forever grant without one covers every agent. */
  agent?: string;
  /** Overrides the configured task grant lifetime. */
  ttlMs?: number;
}

export interface ModeOptions {
  /** Per-agent allow / ask / deny policy; it beats the global policy and grants. */
  overrides?: Record<string, ToolPermission>;
  /** The session thread, for "allow for this session" grants. */
  thread?: string;
  /** Whose forever grants apply. */
  agent?: string;
}

export type PermissionAsk = Omit<PermissionRequest, 'id' | 'timeoutMs' | 'createdAt'>;

export class PermissionGate {
  private readonly broker: PermissionBroker;
  private readonly timeoutMs: number;
  private readonly policy: RiskPolicy;
  private readonly overrides: Record<string, ToolPermission>;
  private readonly grantTtlMs: number;
  private readonly now: () => number;
  private readonly alwaysSave?: (grants: Record<string, string[]>) => void;
  /** `${traceId}\0${agent}\0${toolFamily}` -> epoch milliseconds when the grant ends. */
  private readonly grants = new Map<string, number>();
  /** `${thread}\0${agent}\0${toolFamily}` for the rest of a chat session. */
  private readonly sessionGrants = new Map<string, number>();
  /** Agent -> tool families allowed forever. `*` is the old, global list. */
  private readonly alwaysGrants = new Map<string, Set<string>>();

  constructor(broker: PermissionBroker, options: PermissionGateOptions = {}) {
    this.broker = broker;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.overrides = options.overrides ?? {};
    this.grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.alwaysSave = options.alwaysSave;
    for (const [agent, families] of Object.entries(options.alwaysLoad?.() ?? {})) this.setAlways(agent, families);
  }

  private setAlways(agent: string, families: Iterable<string>): void {
    const clean = [...new Set([...families].map((family) => toolFamily(String(family))).filter(Boolean))].sort();
    if (clean.length === 0) this.alwaysGrants.delete(agent);
    else this.alwaysGrants.set(agent, new Set(clean));
  }

  private saveAlways(): void {
    const out: Record<string, string[]> = {};
    for (const [agent, families] of this.alwaysGrants) if (families.size > 0) out[agent] = [...families].sort();
    this.alwaysSave?.(out);
  }

  /** The forever grants of one agent, plus the old global list. */
  private alwaysFor(agent: string | undefined): Set<string> {
    const out = new Set(this.alwaysGrants.get('*') ?? []);
    if (agent) for (const family of this.alwaysGrants.get(agent) ?? []) out.add(family);
    return out;
  }

  needsApproval(risk: RiskLevel): boolean {
    return this.policy[risk] !== 'auto';
  }

  /**
   * A grant belongs to one agent: group chats and handoffs share a trace and a thread,
   * so a key without the agent would let one agent's approval cover another.
   * `*` keeps the old behaviour for callers that do not name an agent.
   */
  private key(traceId: string, tool: string, agent?: string): string {
    return `${traceId}\u0000${agent || '*'}\u0000${toolFamily(tool)}`;
  }

  private sessionKey(thread: string, tool: string, agent?: string): string {
    return `${thread}\u0000${agent || '*'}\u0000${toolFamily(tool)}`;
  }

  /**
   * Remembers that the user allowed this tool family: for the rest of `traceId`'s work
   * (task, the default), the chat session (`thread`), or forever (stored on this machine).
   * A tool the settings deny outright is never granted.
   */
  grant(traceId: string, tool: string, ttlOrOptions: number | GrantOptions = this.grantTtlMs): boolean {
    const options: GrantOptions = typeof ttlOrOptions === 'number' ? { scope: 'task', ttlMs: ttlOrOptions } : ttlOrOptions;
    const scope = options.scope ?? 'task';
    if (this.overrides[tool] === 'deny') return false;
    if (isAlwaysAskTool(tool) && scope !== 'once') return false;
    if (scope === 'always') {
      const agent = options.agent || '*';
      const families = this.alwaysGrants.get(agent) ?? new Set<string>();
      families.add(toolFamily(tool));
      this.alwaysGrants.set(agent, families);
      this.saveAlways();
      return true;
    }
    if (scope === 'session') {
      if (!options.thread) return false;
      this.sessionGrants.set(this.sessionKey(options.thread, tool, options.agent), Number.POSITIVE_INFINITY);
      return true;
    }
    if (scope === 'once') return true;
    this.prune();
    this.grants.set(this.key(traceId, tool, options.agent), this.now() + Math.max(1, options.ttlMs ?? this.grantTtlMs));
    return true;
  }

  /** True while a task-scoped grant for this tool is still valid. */
  granted(traceId: string, tool: string, agent?: string): boolean {
    this.prune();
    if (this.grants.has(this.key(traceId, tool, agent))) return true;
    return agent !== undefined && this.grants.has(this.key(traceId, tool));
  }

  /** True while a session or forever grant covers this tool (optionally in `thread`). */
  grantedFor(tool: string, thread?: string, agent?: string): boolean {
    const family = toolFamily(tool);
    if (this.alwaysFor(agent).has(family)) return true;
    if (thread === undefined) return false;
    if (this.sessionGrants.has(this.sessionKey(thread, tool, agent))) return true;
    return agent !== undefined && this.sessionGrants.has(this.sessionKey(thread, tool));
  }

  /** Tool families the user allowed forever for one agent (and the old global list). */
  alwaysAllowed(agent?: string): string[] {
    return [...this.alwaysFor(agent)].sort();
  }

  /** The settings screen's view: every agent's forever grants, keyed by agent. */
  alwaysGrantsByAgent(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [agent, families] of this.alwaysGrants) if (families.size > 0) out[agent] = [...families].sort();
    return out;
  }

  /** Forgets a forever grant; without an agent it is removed from every agent. */
  revokeAlways(tool: string, agent?: string): boolean {
    const family = toolFamily(tool);
    if (agent) {
      const families = this.alwaysGrants.get(agent);
      const removed = families?.delete(family) ?? false;
      if (families && families.size === 0) this.alwaysGrants.delete(agent);
      if (removed) this.saveAlways();
      return removed;
    }
    let removed = false;
    for (const [name, families] of this.alwaysGrants) {
      if (!families.delete(family)) continue;
      removed = true;
      if (families.size === 0) this.alwaysGrants.delete(name);
    }
    if (removed) this.saveAlways();
    return removed;
  }

  /** Drops a task grant (all of them for a trace when no tool is given). */
  revoke(traceId: string, tool?: string, agent?: string): void {
    const prefix = `${traceId}\u0000`;
    if (tool) {
      if (agent !== undefined) this.grants.delete(this.key(traceId, tool, agent));
      else {
        const suffix = `\u0000${toolFamily(tool)}`;
        for (const key of this.grants.keys()) {
          if (key.startsWith(prefix) && key.endsWith(suffix)) this.grants.delete(key);
        }
      }
      return;
    }
    for (const key of this.grants.keys()) {
      if (key.startsWith(prefix)) this.grants.delete(key);
    }
  }

  /** Moves an agent's forever, session and task grants when the agent is renamed. */
  renameAgent(from: string, to: string): void {
    if (!from || !to || from === to) return;
    let changed = false;
    const families = this.alwaysGrants.get(from);
    if (families) {
      const target = this.alwaysGrants.get(to) ?? new Set<string>();
      for (const family of families) target.add(family);
      this.alwaysGrants.set(to, target);
      this.alwaysGrants.delete(from);
      changed = true;
    }
    const marker = `\u0000${from}\u0000`;
    for (const map of [this.grants, this.sessionGrants]) {
      for (const key of [...map.keys()]) {
        if (!key.includes(marker)) continue;
        const value = map.get(key)!;
        map.delete(key);
        map.set(key.replace(marker, `\u0000${to}\u0000`), value);
      }
    }
    if (changed) this.saveAlways();
  }

  /** Forgets every grant that belongs to an agent (used when the agent is deleted). */
  forgetAgent(agent: string): void {
    if (!agent || agent === '*') return;
    const changed = this.alwaysGrants.delete(agent);
    const marker = `\u0000${agent}\u0000`;
    for (const map of [this.grants, this.sessionGrants]) {
      for (const key of [...map.keys()]) if (key.includes(marker)) map.delete(key);
    }
    if (changed) this.saveAlways();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.grants) {
      if (expiresAt <= now) this.grants.delete(key);
    }
  }

  /** How a call to `tool` is handled: run it, ask the user first, or refuse outright. */
  modeFor(tool: string, risk: RiskLevel, traceId?: string, options: ModeOptions = {}): 'auto' | 'ask' | 'deny' {
    const override = options.overrides?.[tool];
    if (override === 'deny') return 'deny';
    const global = this.overrides[tool];
    if (global === 'deny') return 'deny';
    // Some calls (filling a vault secret into a page) need the user every single time.
    if (isAlwaysAskTool(tool)) return 'ask';
    // A grant covers a policy "ask"; it never turns a deny into an allow.
    if (this.grantedFor(tool, options.thread, options.agent)) return 'auto';
    if (traceId && this.granted(traceId, tool, options.agent)) return 'auto';
    if (override === 'allow') return 'auto';
    if (override === 'ask') return 'ask';
    if (global === 'allow') return 'auto';
    if (global === 'ask') return 'ask';
    return this.policy[risk];
  }

  createRequest(ask: PermissionAsk): PermissionRequest {
    return { ...ask, id: randomUUID(), timeoutMs: this.timeoutMs, createdAt: new Date().toISOString() };
  }

  /**
   * Asks the user. No answer within the timeout, a broker failure, or the caller
   * being stopped counts as a denial. An external stop also withdraws the prompt.
   */
  async decide(request: PermissionRequest, signal?: AbortSignal, options: ModeOptions = {}): Promise<PermissionDecision> {
    const mode = this.modeFor(request.tool, request.risk, request.traceId, {
      agent: request.agent,
      ...(request.thread ? { thread: request.thread } : {}),
      ...options,
    });
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
