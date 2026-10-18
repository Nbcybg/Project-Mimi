import type { PermissionRequest } from '@mimi/shared';
import type { PermissionBroker } from '../permissions/gate.ts';

/**
 * Permission broker for remote clients. A request reaches every connected client
 * through the event stream; the first answer from any of them decides. With nobody
 * connected the request simply waits, and the gate's timeout turns that into a denial.
 */
export class WsBroker implements PermissionBroker {
  private readonly waiting = new Map<string, { request: PermissionRequest; settle: (allow: boolean) => void }>();

  request(request: PermissionRequest, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (allow: boolean) => {
        if (!this.waiting.delete(request.id)) return;
        signal.removeEventListener('abort', onAbort);
        resolve(allow);
      };
      const onAbort = () => settle(false);
      this.waiting.set(request.id, { request, settle });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Applies a client's answer. Returns false when the request is unknown or already decided. */
  respond(requestId: string, allow: boolean): boolean {
    const entry = this.waiting.get(requestId);
    if (!entry) return false;
    entry.settle(allow);
    return true;
  }

  /** Requests still open, for clients that connect in the middle of one. */
  pending(): PermissionRequest[] {
    return [...this.waiting.values()].map((entry) => entry.request);
  }
}
