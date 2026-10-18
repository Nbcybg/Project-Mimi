import { randomUUID } from 'node:crypto';
import type { PcMessage, PcRequest } from '@mimi/shared';
import { PC_OFFLINE, type PcLink } from '../tools/executor.ts';
import type { ToolContext } from '../tools/registry.ts';

/** The part of a WebSocket the hub needs; lets tests pass a fake. */
export interface PcSocket {
  send(data: string): void;
  close(): void;
}

type Hello = Extract<PcMessage, { type: 'hello' }>;
type Result = Extract<PcMessage, { type: 'tool-result' }>;

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

  constructor(onStatus: (online: boolean, name?: string) => void = () => {}) {
    this.onStatus = onStatus;
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
    this.onStatus(false);
  }

  private drop(socket: PcSocket, reason: string): void {
    this.failAll(new Error(`PC agent ${reason}`));
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
    const call = this.calls.get(result.id);
    if (!call) return;
    if (result.ok) call.resolve(result.output);
    else call.reject(new Error(result.output));
  }
}
