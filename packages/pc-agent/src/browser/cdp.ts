/**
 * A minimal Chrome DevTools Protocol client over Node's built-in WebSocket: send a
 * command, get its result. Enough to drive Edge or Chrome without any dependency.
 */
export interface CdpClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
  /** Called once when the connection ends (the browser was closed). */
  onClose(listener: () => void): void;
}

const COMMAND_TIMEOUT_MS = 30_000;

export class CdpError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

export function connectCdp(url: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const closers: Array<() => void> = [];
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new CdpError('The browser connection closed.'));
      }
      pending.clear();
      for (const listener of closers) listener();
    };

    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}, sessionId) {
          if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new CdpError('The browser connection is closed.'));
          const id = nextId++;
          return new Promise((resolveCall, rejectCall) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new CdpError(`${method} timed out.`));
            }, COMMAND_TIMEOUT_MS);
            pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        close() {
          socket.close();
        },
        onClose(listener) {
          if (closed) listener();
          else closers.push(listener);
        },
      }),
    );
    socket.addEventListener('message', (event) => {
      let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === undefined) return; // events are not used
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(message.error.message ?? 'DevTools error', message.error.code));
      else entry.resolve(message.result ?? {});
    });
    socket.addEventListener('close', finish);
    socket.addEventListener('error', () => {
      finish();
      reject(new CdpError(`Could not connect to the browser at ${url}.`));
    });
  });
}
