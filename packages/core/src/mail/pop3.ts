import net from 'node:net';
import tls from 'node:tls';
import type { MailIncomingSettings } from '@mimi/shared';
import { parseHeaders, parseMail } from './parse.ts';
import { type MailReadResult, type MailSearchOptions, type MailSummary } from './types.ts';

interface Pop3Message {
  number: number;
  uid: string;
  size?: number;
}

class Pop3Connection {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private failed: Error | null = null;
  private readonly settings: MailIncomingSettings;

  constructor(settings: MailIncomingSettings) {
    this.settings = settings;
    const port = settings.port || (settings.security === 'tls' ? 995 : 110);
    const timeout = Math.max(5_000, settings.timeoutMs ?? 30_000);
    if (settings.security === 'tls') {
      this.socket = tls.connect({
        host: settings.host,
        port,
        servername: settings.host,
        rejectUnauthorized: settings.rejectUnauthorized !== false,
      });
    } else {
      this.socket = net.connect(port, settings.host);
    }
    this.socket.setTimeout(timeout, () => this.destroy(new Error('POP3: หมดเวลาเชื่อมต่อ')));
    this.attach(this.socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      for (;;) {
        const end = this.buffer.indexOf('\r\n');
        if (end < 0) break;
        this.lines.push(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 2);
      }
      while (this.waiters.length > 0 && this.lines.length > 0) this.waiters.shift()!(this.lines.shift()!);
    });
    socket.on('error', (error) => this.destroy(error));
    socket.on('close', () => this.destroy(new Error('POP3: การเชื่อมต่อขาด')));
  }

  private destroy(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    this.socket.destroy();
    while (this.waiters.length > 0) this.waiters.shift()!(null);
  }

  private nextLine(): Promise<string | null> {
    if (this.failed) return Promise.resolve(null);
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private write(text: string): void {
    this.socket.write(`${text}\r\n`);
  }

  /** USER / PASS / STAT / QUIT and every single-line answer. */
  async command(text: string): Promise<string> {
    this.write(text);
    return this.readLine();
  }

  async readLine(): Promise<string> {
    const line = await this.nextLine();
    if (line === null) throw this.failed ?? new Error('POP3: การเชื่อมต่อขาด');
    if (line.startsWith('-ERR')) throw new Error(line.slice(4).trim() || 'POP3: เซิร์ฟเวอร์ปฏิเสธ');
    if (!line.startsWith('+OK')) throw new Error(`POP3: ${line.slice(0, 200)}`);
    return line;
  }

  /** UIDL / LIST / TOP / RETR answer with +OK, then lines until "." (dot-stuffed). */
  async multi(text: string): Promise<string[]> {
    await this.command(text);
    const lines: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      if (line === null) throw this.failed ?? new Error('POP3: การเชื่อมต่อขาดกลางทาง');
      if (line === '.') return lines;
      lines.push(line.startsWith('..') ? line.slice(1) : line);
    }
  }

  async startTls(): Promise<void> {
    this.socket.removeAllListeners();
    this.buffer = '';
    this.lines = [];
    const port = this.settings.port || 110;
    const upgraded = tls.connect({
      socket: this.socket as net.Socket,
      servername: this.settings.host,
      rejectUnauthorized: this.settings.rejectUnauthorized !== false,
      port,
      host: this.settings.host,
    });
    this.socket = upgraded;
    this.attach(upgraded);
    await new Promise<void>((resolve, reject) => {
      upgraded.once('secureConnect', () => resolve());
      upgraded.once('error', reject);
    });
  }

  async close(): Promise<void> {
    try {
      await this.command('QUIT');
    } catch {
      // the server may already have closed the connection
    }
    this.socket.end();
  }
}

async function connect(settings: MailIncomingSettings, password: string): Promise<Pop3Connection> {
  const connection = new Pop3Connection(settings);
  try {
    await connection.readLine();
    if (settings.security === 'starttls') {
      await connection.command('STLS');
      await connection.startTls();
    }
    await connection.command(`USER ${settings.user}`);
    await connection.command(`PASS ${password}`);
    return connection;
  } catch (error) {
    try {
      await connection.close();
    } catch {
      // ignore
    }
    throw error;
  }
}

function summaryOf(message: Pop3Message, headers: Record<string, string>): MailSummary {
  return {
    id: message.uid,
    from: headers.from ?? '',
    to: headers.to ?? '',
    subject: headers.subject ?? '',
    date: headers.date ?? '',
    preview: '',
    seen: false,
    ...(message.size ? { size: message.size } : {}),
  };
}

export async function pop3List(settings: MailIncomingSettings, password: string, options: MailSearchOptions = {}): Promise<MailSummary[]> {
  const connection = await connect(settings, password);
  try {
    const uidLines = await connection.multi('UIDL');
    const messages: Pop3Message[] = uidLines
      .map((line) => /^(\d+)\s+(\S+)/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ number: Number(match[1]), uid: match[2]! }));
    const listLines = await connection.multi('LIST');
    for (const line of listLines) {
      const match = /^(\d+)\s+(\d+)/.exec(line);
      if (!match) continue;
      const message = messages.find((entry) => entry.number === Number(match[1]));
      if (message) message.size = Number(match[2]);
    }
    const max = Math.max(1, Math.min(100, options.max ?? settings.maxMessages ?? 10));
    const selected = messages.slice(-max);
    const summaries: MailSummary[] = [];
    const since = options.sinceDays ?? settings.sinceDays ?? 0;
    const cutoff = since > 0 ? Date.now() - since * 86_400_000 : 0;
    for (const message of selected) {
      const top = await connection.multi(`TOP ${message.number} 0`);
      const headers = parseHeaders(top.join('\r\n'));
      if (cutoff > 0) {
        const date = Date.parse(headers.date ?? '');
        if (Number.isFinite(date) && date < cutoff) continue;
      }
      const query = (options.query ?? settings.query ?? '').trim().toLowerCase();
      if (query) {
        const haystack = `${headers.from ?? ''}\n${headers.to ?? ''}\n${headers.subject ?? ''}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      summaries.push(summaryOf(message, headers));
    }
    return summaries;
  } finally {
    await connection.close().catch(() => {});
  }
}

export async function pop3Read(
  settings: MailIncomingSettings,
  password: string,
  id: string,
  options: { deleteAfterFetch?: boolean } = {},
): Promise<MailReadResult> {
  const connection = await connect(settings, password);
  try {
    const uidLines = await connection.multi('UIDL');
    const match = uidLines
      .map((line) => /^(\d+)\s+(\S+)/.exec(line))
      .find((entry): entry is RegExpExecArray => entry !== null && entry[2] === id);
    if (!match) throw new Error(`ไม่พบเมล ${id}`);
    const number = Number(match[1]);
    const raw = (await connection.multi(`RETR ${number}`)).join('\r\n');
    if (options.deleteAfterFetch ?? settings.deleteAfterFetch) await connection.command(`DELE ${number}`);
    const parsed = parseMail(raw);
    return {
      id,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      date: parsed.date,
      preview: parsed.text.slice(0, 300),
      seen: true,
      text: parsed.text,
      html: parsed.html,
      messageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      attachments: parsed.attachments,
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

export async function pop3Test(settings: MailIncomingSettings, password: string): Promise<string> {
  const connection = await connect(settings, password);
  try {
    const stat = await connection.command('STAT');
    return `เชื่อมต่อ POP3 ได้ · ${stat.slice(3).trim()}`;
  } finally {
    await connection.close().catch(() => {});
  }
}
