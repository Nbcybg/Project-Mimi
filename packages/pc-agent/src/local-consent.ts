import { execFile } from 'node:child_process';
import { type PcConsentOutcome, type RiskLevel, toolFamily } from '@mimi/shared';

export interface ConsentRequest {
  id: string;
  tool: string;
  risk: RiskLevel;
  summary: string;
  traceId: string;
  taskId?: string;
  /** The agent that asked and the session it works in, so the dialog can say who is asking. */
  agent?: string;
  thread?: string;
}

/**
 * Puts one question on the user's own screen. Returning false refuses the action. The signal
 * fires when nobody answered in time: the prompt closes its dialog and stops waiting.
 */
export interface ConsentPrompt {
  ask(request: ConsentRequest, signal?: AbortSignal): Promise<boolean>;
}

/** Hears when a question goes up on this screen and how it ended (the core tells the phone). */
export interface ConsentObserver {
  pending?(request: ConsentRequest, timeoutMs: number): void;
  resolved?(request: ConsentRequest, outcome: PcConsentOutcome): void;
}

/** Nobody at the screen for this long = no. The dialog stays up no longer than that. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60_000;

export interface LocalConsentOptions {
  prompt?: ConsentPrompt;
  /** How long one approval covers a task, in milliseconds. */
  ttlMs?: number;
  /** How long to wait for an answer at the screen before refusing, in milliseconds. */
  timeoutMs?: number;
  observer?: ConsentObserver;
  now?: () => number;
}

/**
 * Asks the user on the computer that will actually be touched. The core may be on
 * another machine, so its chat approval is not a substitute for this one.
 *
 * A task-scoped approval is remembered per task and tool family; calls outside a task
 * ask every time. Read-only tools never ask.
 */
export class LocalConsent {
  private readonly prompt: ConsentPrompt;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private observer: ConsentObserver | undefined;
  private readonly now: () => number;
  private readonly grants = new Map<string, number>();
  /** One dialog at a time, so two quick tool calls cannot stack OS windows. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: LocalConsentOptions = {}) {
    this.prompt = options.prompt ?? osConsentPrompt();
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_CONSENT_TIMEOUT_MS;
    this.observer = options.observer;
    this.now = options.now ?? Date.now;
  }

  /** Where "a question is waiting" and "it ended" are reported (the PC agent's link to the core). */
  setObserver(observer: ConsentObserver | undefined): void {
    this.observer = observer;
  }

  /** Puts the question up, and takes it down again when the time is up. */
  private async ask(request: ConsentRequest): Promise<PcConsentOutcome> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
    });
    try {
      this.observer?.pending?.(request, this.timeoutMs);
    } catch {
      // telling the core is a courtesy; the question still goes up
    }
    let outcome: PcConsentOutcome;
    try {
      const answered = this.prompt.ask(request, controller.signal).then(
        (allowed): PcConsentOutcome => (allowed ? 'allowed' : 'denied'),
        (): PcConsentOutcome => 'denied',
      );
      outcome = await Promise.race([answered, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome === 'timeout') controller.abort();
    try {
      this.observer?.resolved?.(request, outcome);
    } catch {
      // see above
    }
    return outcome;
  }

  private key(request: ConsentRequest): string | null {
    return request.taskId ? `${request.taskId}\u0000${toolFamily(request.tool)}` : null;
  }

  private granted(request: ConsentRequest): boolean {
    const key = this.key(request);
    if (!key) return false;
    const expiresAt = this.grants.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.grants.delete(key);
      return false;
    }
    return true;
  }

  private readonly lastOutcome = new Map<string, PcConsentOutcome>();

  /** How the question about this call ended, so the refusal can say "nobody answered" instead of "denied". */
  outcomeOf(id: string): PcConsentOutcome | undefined {
    return this.lastOutcome.get(id);
  }

  async allow(request: ConsentRequest): Promise<boolean> {
    if (request.risk === 'read') return true;
    if (this.granted(request)) return true;

    let resolveAnswer: (outcome: PcConsentOutcome) => void = () => {};
    const answer = new Promise<PcConsentOutcome>((resolve) => {
      resolveAnswer = resolve;
    });
    this.queue = this.queue
      .then(async () => {
        try {
          resolveAnswer(await this.ask(request));
        } catch {
          resolveAnswer('denied');
        }
      })
      .catch(() => resolveAnswer('denied'));
    const outcome = await answer;
    const allowed = outcome === 'allowed';
    this.lastOutcome.set(request.id, outcome);
    if (this.lastOutcome.size > 50) this.lastOutcome.delete(this.lastOutcome.keys().next().value as string);
    const key = this.key(request);
    if (allowed && key) this.grants.set(key, this.now() + this.ttlMs);
    return allowed;
  }
}

/** A line source shared by the token handshake and the desktop consent dialog. */
export class LineReader {
  private readonly lines: string[] = [];
  private readonly waiting: Array<(line: string | undefined) => void> = [];
  private buffer = '';
  private ended = false;

  constructor(stream: NodeJS.ReadableStream) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => this.push(chunk));
    stream.on('end', () => this.end());
    stream.on('close', () => this.end());
  }

  private push(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    }
  }

  private end(): void {
    this.ended = true;
    if (this.buffer.trim()) {
      const line = this.buffer;
      this.buffer = '';
      const waiter = this.waiting.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    }
    for (const waiter of this.waiting.splice(0)) waiter(undefined);
  }

  /** The next line, or undefined on end of stream, timeout or abort (an aborted wait must not eat a later line). */
  next(timeoutMs = 0, signal?: AbortSignal): Promise<string | undefined> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (line: string | undefined) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(line);
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(settle);
        if (at >= 0) this.waiting.splice(at, 1);
        settle(undefined);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(settle);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const at = this.waiting.indexOf(settle);
          if (at >= 0) this.waiting.splice(at, 1);
          resolve(undefined);
        }, timeoutMs);
      }
    });
  }
}

/** Writes consent questions as prefixed JSON lines; the desktop app answers on stdin. */
export class StdioConsentPrompt implements ConsentPrompt {
  private readonly lines: LineReader;
  private readonly write: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(lines: LineReader, write: (line: string) => void, timeoutMs = 15 * 60_000) {
    this.lines = lines;
    this.write = write;
    this.timeoutMs = timeoutMs;
  }

  async ask(request: ConsentRequest, signal?: AbortSignal): Promise<boolean> {
    this.write(`@@mimi-consent@@${JSON.stringify(request)}\n`);
    // On timeout the desktop app is told to take the dialog down, so no stale question stays on screen.
    const cancel = () => this.write(`@@mimi-consent-cancel@@${JSON.stringify({ id: request.id })}\n`);
    signal?.addEventListener('abort', cancel, { once: true });
    while (true) {
      const line = await this.lines.next(this.timeoutMs, signal);
      if (line === undefined) return false;
      let reply: { type?: string; id?: string; allow?: boolean };
      try {
        reply = JSON.parse(line) as typeof reply;
      } catch {
        continue;
      }
      if (reply.type === 'consent-response' && reply.id === request.id) return reply.allow === true;
    }
  }
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 15 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // The signal kills the dialog's process: a question nobody answered in time disappears from the screen.
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

function question(request: ConsentRequest): string {
  const who = request.agent ? `\nจาก agent: ${request.agent}` : '';
  return `Mimi ขอทำสิ่งนี้บนเครื่องนี้:\n\n${request.summary}\n\nเครื่องมือ: ${request.tool} (${request.risk})${who}`;
}

/** The native dialog used when the PC agent was not started by the desktop app. */
export function osConsentPrompt(platform: NodeJS.Platform = process.platform): ConsentPrompt {
  return {
    async ask(request, signal) {
      const title = 'Mimi ขออนุญาต';
      const text = question(request);
      if (platform === 'win32') {
        const script =
          'Add-Type -AssemblyName System.Windows.Forms;' +
          '$r=[System.Windows.Forms.MessageBox]::Show($env:MIMI_CONSENT_TEXT,$env:MIMI_CONSENT_TITLE,' +
          '[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning);' +
          "if ($r -eq 'Yes') { 'allow' } else { 'deny' }";
        const answer = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-Command', script], {
          ...process.env,
          MIMI_CONSENT_TEXT: text,
          MIMI_CONSENT_TITLE: title,
        }, signal);
        return /allow/i.test(answer);
      }
      if (platform === 'darwin') {
        const script =
          'set theText to system attribute "MIMI_CONSENT_TEXT"\n' +
          'set theTitle to system attribute "MIMI_CONSENT_TITLE"\n' +
          'try\n' +
          `display dialog theText with title theTitle buttons {"ไม่อนุญาต","อนุญาต"} default button "อนุญาต" with icon caution\n` +
          'return "allow"\n' +
          'on error number -128\n' +
          'return "deny"\n' +
          'end try';
        const answer = await run('osascript', ['-e', script], {
          ...process.env,
          MIMI_CONSENT_TEXT: text,
          MIMI_CONSENT_TITLE: title,
        }, signal);
        return /allow/i.test(answer);
      }
      try {
        await run('zenity', ['--question', '--title', title, '--text', text, '--ok-label', 'อนุญาต', '--cancel-label', 'ไม่อนุญาต'], process.env, signal);
        return true;
      } catch {
        try {
          await run('kdialog', ['--title', title, '--yesno', text, '--yes-label', 'อนุญาต', '--no-label', 'ไม่อนุญาต'], process.env, signal);
          return true;
        } catch {
          return false;
        }
      }
    },
  };
}
