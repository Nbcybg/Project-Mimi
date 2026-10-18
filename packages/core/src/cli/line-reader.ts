import type { Interface } from 'node:readline';

/**
 * Serialises terminal input into explicit "next line" requests, so the chat prompt
 * and permission prompts can share one readline interface. Lines that arrive while
 * nobody is waiting are queued, which also makes piped input work.
 */
export class LineReader {
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private closed = false;

  constructor(rl: Interface) {
    this.rl = rl;
    rl.on('line', (line) => {
      if (!this.waiter) {
        this.queue.push(line);
        return;
      }
      this.echoPiped(line);
      this.settle(line);
    });
    rl.on('close', () => {
      this.closed = true;
      this.settle(null);
    });
  }

  /** Piped input is not echoed by a terminal, so show what was read. */
  private echoPiped(line: string): void {
    if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
  }

  private settle(line: string | null): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(line);
  }

  /** Resolves with the next input line, or null when input ended or `signal` aborted. */
  next(prompt: string, signal?: AbortSignal): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined || this.closed || signal?.aborted) {
      process.stdout.write(prompt);
      if (queued !== undefined) this.echoPiped(queued);
      return Promise.resolve(queued ?? null);
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        process.stdout.write('\n');
        this.settle(null);
      };
      this.waiter = (line) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(line);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }
}
