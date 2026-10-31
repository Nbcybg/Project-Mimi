import { execFile } from 'node:child_process';
import { type RiskLevel, toolFamily } from '@mimi/shared';

export interface ConsentRequest {
  id: string;
  tool: string;
  risk: RiskLevel;
  summary: string;
  traceId: string;
  taskId?: string;
}

/** Puts one question on the user's own screen. Returning false refuses the action. */
export interface ConsentPrompt {
  ask(request: ConsentRequest): Promise<boolean>;
}

export interface LocalConsentOptions {
  prompt?: ConsentPrompt;
  /** How long one approval covers a task, in milliseconds. */
  ttlMs?: number;
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
  private readonly now: () => number;
  private readonly grants = new Map<string, number>();
  /** One dialog at a time, so two quick tool calls cannot stack OS windows. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: LocalConsentOptions = {}) {
    this.prompt = options.prompt ?? osConsentPrompt();
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
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

  async allow(request: ConsentRequest): Promise<boolean> {
    if (request.risk === 'read') return true;
    if (this.granted(request)) return true;

    let resolveAnswer: (allowed: boolean) => void = () => {};
    const answer = new Promise<boolean>((resolve) => {
      resolveAnswer = resolve;
    });
    this.queue = this.queue
      .then(async () => {
        try {
          resolveAnswer(await this.prompt.ask(request));
        } catch {
          resolveAnswer(false);
        }
      })
      .catch(() => resolveAnswer(false));
    const allowed = await answer;
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

  /** The next line, or undefined on end of stream or timeout. */
  next(timeoutMs = 0): Promise<string | undefined> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (line: string | undefined) => {
        if (timer) clearTimeout(timer);
        resolve(line);
      };
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

  async ask(request: ConsentRequest): Promise<boolean> {
    this.write(`@@mimi-consent@@${JSON.stringify(request)}\n`);
    while (true) {
      const line = await this.lines.next(this.timeoutMs);
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

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

function question(request: ConsentRequest): string {
  return `Mimi ขอทำสิ่งนี้บนเครื่องนี้:\n\n${request.summary}\n\nเครื่องมือ: ${request.tool} (${request.risk})`;
}

/** The native dialog used when the PC agent was not started by the desktop app. */
export function osConsentPrompt(platform: NodeJS.Platform = process.platform): ConsentPrompt {
  return {
    async ask(request) {
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
        });
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
        });
        return /allow/i.test(answer);
      }
      try {
        await run('zenity', ['--question', '--title', title, '--text', text, '--ok-label', 'อนุญาต', '--cancel-label', 'ไม่อนุญาต'], process.env);
        return true;
      } catch {
        try {
          await run('kdialog', ['--title', title, '--yesno', text, '--yes-label', 'อนุญาต', '--no-label', 'ไม่อนุญาต'], process.env);
          return true;
        } catch {
          return false;
        }
      }
    },
  };
}
