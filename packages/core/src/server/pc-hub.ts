import { randomUUID } from 'node:crypto';
import type { PcConsentOutcome, PcMessage, PcRequest } from '@mimi/shared';
import { PC_OFFLINE, type PcLink } from '../tools/executor.ts';
import type { ToolContext } from '../tools/registry.ts';

/** The part of a WebSocket the hub needs; lets tests pass a fake. */
export interface PcSocket {
  send(data: string): void;
  close(): void;
}

type Hello = Extract<PcMessage, { type: 'hello' }>;
type Result = Extract<PcMessage, { type: 'tool-result' }>;
export type ConsentPending = Extract<PcMessage, { type: 'consent-pending' }>;
export type ConsentResolved = Extract<PcMessage, { type: 'consent-resolved' }>;

/** A question the PC agent is waiting on at its own screen. */
export interface PendingConsent extends ConsentPending {
  askedAt: number;
  expiresAt: number;
}

/** Slack on top of the PC's own timeout before the core stops listing a question that never ended. */
const CONSENT_GRACE_MS = 15_000;

const EXEC_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The core's end of the PC agent connection. The agent dials out to the core, so the
 * user's machine needs no open port; tool calls travel down that socket and results
 * come back up.
 */
export class PcHub implements PcLink {
  private socket: PcSocket | null = null;
  private hello: Hello | null = null;
  private readonly calls = new Map<string, { resolve: (output: string) => void; reject: (error: Error) => void }>();
  private readonly onStatus: (online: boolean, name?: string) => void;
  private readonly consents = new Map<string, { entry: PendingConsent; timer: NodeJS.Timeout }>();
  /** Told when a question goes up on the PC's screen and when it ends (the server tells every client). */
  onConsent: (event: { kind: 'pending'; request: PendingConsent } | { kind: 'done'; request: PendingConsent; outcome: PcConsentOutcome }) => void = () => {};

  constructor(onStatus: (online: boolean, name?: string) => void = () => {}) {
    this.onStatus = onStatus;
  }

  /** Questions still waiting at the PC's screen, oldest first. */
  pendingConsents(): PendingConsent[] {
    return [...this.consents.values()].map((item) => item.entry);
  }

  /** The PC agent put a question on its screen. */
  consentPending(message: ConsentPending): void {
    if (typeof message.id !== 'string' || message.id.length === 0) return;
    this.consentEnded(message.id, 'denied', false);
    if (this.consents.size >= 20) return; // a runaway agent must not fill the phone with banners
    const timeoutMs = Number.isFinite(message.timeoutMs) && message.timeoutMs > 0 ? message.timeoutMs : 5 * 60_000;
    const askedAt = Date.now();
    const entry: PendingConsent = {
      ...message,
      tool: String(message.tool ?? ''),
      risk: String(message.risk ?? ''),
      summary: String(message.summary ?? '').slice(0, 600),
      agent: String(message.agent ?? ''),
      thread: String(message.thread ?? ''),
      timeoutMs,
      askedAt,
      expiresAt: askedAt + timeoutMs,
    };
    const timer = setTimeout(() => this.consentEnded(entry.id, 'timeout'), timeoutMs + CONSENT_GRACE_MS);
    timer.unref?.();
    this.consents.set(entry.id, { entry, timer });
    this.onConsent({ kind: 'pending', request: entry });
  }

  /** The question was answered, timed out, or its call ended; the phone stops showing it. */
  consentEnded(id: string, outcome: PcConsentOutcome, tell = true): void {
    const found = this.consents.get(id);
    if (!found) return;
    clearTimeout(found.timer);
    this.consents.delete(id);
    if (tell) this.onConsent({ kind: 'done', request: found.entry, outcome });
  }

  get online(): boolean {
    return this.socket !== null;
  }

  get name(): string | undefined {
    return this.hello?.name;
  }

  get allowedDirs(): string[] {
    return this.hello?.allowedDirs ?? [];
  }

  /** Registers a newly connected PC agent, replacing any previous one. */
  attach(socket: PcSocket, hello: Hello): void {
    if (this.socket && this.socket !== socket) this.drop(this.socket, 'replaced by a new PC agent connection');
    this.socket = socket;
    this.hello = hello;
    this.onStatus(true, hello.name);
  }

  /** Called when a PC agent socket closes. Open calls fail right away instead of hanging. */
  detach(socket: PcSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.hello = null;
    this.failAll(new Error(PC_OFFLINE));
    for (const id of [...this.consents.keys()]) this.consentEnded(id, 'gone');
    this.onStatus(false);
  }

  private drop(socket: PcSocket, reason: string): void {
    this.failAll(new Error(`PC agent ${reason}`));
    for (const id of [...this.consents.keys()]) this.consentEnded(id, 'gone');
    socket.close();
  }

  private failAll(error: Error): void {
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
  }

  execute(tool: string, input: unknown, context: ToolContext): Promise<string> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(PC_OFFLINE));
    if (this.hello && !this.hello.tools.includes(tool)) {
      return Promise.reject(new Error(`The PC agent does not provide the tool "${tool}".`));
    }

    const id = randomUUID();
    const request: PcRequest = {
      type: 'tool-exec',
      id,
      tool,
      input,
      traceId: context.traceId,
      thread: context.thread,
      agent: context.agent,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      ...(context.projectRoots?.length ? { projectRoots: context.projectRoots } : {}),
    };
    return new Promise<string>((resolve, reject) => {
      const finish = (settle: () => void) => {
        if (!this.calls.delete(id)) return;
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        settle();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`The PC agent did not answer within ${EXEC_TIMEOUT_MS / 60000} minutes.`))),
        EXEC_TIMEOUT_MS,
      );
      const onAbort = () => finish(() => reject(new Error('cancelled')));
      context.signal?.addEventListener('abort', onAbort, { once: true });
      this.calls.set(id, {
        resolve: (output) => finish(() => resolve(output)),
        reject: (error) => finish(() => reject(error)),
      });
      socket.send(JSON.stringify(request));
    });
  }

  /** Delivers a tool result from the PC agent to whoever is waiting for it. */
  handleResult(result: Result): void {
    // A result means the call is over, whatever happened to the question about it.
    this.consentEnded(result.id, result.ok ? 'allowed' : 'denied');
    const call = this.calls.get(result.id);
    if (!call) return;
    if (result.ok) call.resolve(result.output);
    else call.reject(new Error(result.output));
  }
}
