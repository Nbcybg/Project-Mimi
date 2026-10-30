import { randomUUID } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { MailOutgoingSettings } from '@mimi/shared';
import { type MailSendInput, outgoingPort } from './types.ts';

interface SmtpReply {
  code: number;
  lines: string[];
}

class SmtpConnection {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private lines: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private failed: Error | null = null;
  private readonly settings: MailOutgoingSettings;

  constructor(settings: MailOutgoingSettings) {
    this.settings = settings;
    const port = outgoingPort(settings);
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
    this.socket.setTimeout(timeout, () => this.destroy(new Error('SMTP: หมดเวลาเชื่อมต่อ')));
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
    socket.on('close', () => this.destroy(new Error('SMTP: การเชื่อมต่อขาด')));
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

  private async line(): Promise<string> {
    const line = await this.nextLine();
    if (line === null) throw this.failed ?? new Error('SMTP: การเชื่อมต่อขาด');
    return line;
  }

  async reply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.line();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) {
        const code = Number(line.slice(0, 3));
        if (!Number.isFinite(code)) throw new Error(`SMTP: คำตอบผิดรูปแบบ: ${line.slice(0, 120)}`);
        return { code, lines };
      }
    }
  }

  async command(text: string, expected = 250): Promise<SmtpReply> {
    this.socket.write(`${text}\r\n`);
    const reply = await this.reply();
    if (reply.code !== expected) throw new Error(`SMTP: ${reply.lines.join(' ').slice(0, 300)}`);
    return reply;
  }

  async startTls(): Promise<void> {
    this.socket.removeAllListeners();
    this.buffer = '';
    this.lines = [];
    const upgraded = tls.connect({
      socket: this.socket as net.Socket,
      servername: this.settings.host,
      rejectUnauthorized: this.settings.rejectUnauthorized !== false,
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
      this.socket.write('QUIT\r\n');
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }

  writeRaw(text: string): void {
    this.socket.write(text);
  }
}

const encodeHeader = (value: string): string => {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
};

const address = (value: string): string => {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw new Error('SMTP: ต้องมีผู้รับ');
  return clean;
};

const wrapBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

function buildMime(input: MailSendInput, settings: MailOutgoingSettings): { message: string; recipients: string[]; from: string } {
  const fromEmail = address(settings.fromEmail);
  const from = settings.fromName ? `${encodeHeader(settings.fromName)} <${fromEmail}>` : fromEmail;
  const to = address(input.to);
  const cc = input.cc?.trim();
  const bcc = input.bcc?.trim();
  const recipients = [...to.split(','), ...(cc?.split(',') ?? []), ...(bcc?.split(',') ?? [])]
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (recipients.length === 0) throw new Error('SMTP: ต้องมีผู้รับอย่างน้อยหนึ่งคน');
  const domain = fromEmail.split('@')[1]?.replace(/[^a-z0-9.-]/gi, '') || 'localhost';
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${from}`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    ...(input.replyTo ? [`Reply-To: ${encodeHeader(input.replyTo)}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]/g, ' ')}`] : []),
    ...(input.references ? [`References: ${input.references.replace(/[\r\n]/g, ' ')}`] : []),
    'MIME-Version: 1.0',
  ];
  let body: string;
  if (input.html?.trim()) {
    const boundary = `mimi-${randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(input.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(input.html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    body = wrapBase64(input.text);
  }
  return { message: `${headers.join('\r\n')}\r\n\r\n${body}`, recipients, from: fromEmail };
}

function dotStuff(message: string): string {
  return message
    .replace(/\r?\n/g, '\r\n')
    .replace(/^\./gm, '..')
    .replace(/\r\n$/, '');
}


export async function sendSmtpMail(settings: MailOutgoingSettings, password: string, input: MailSendInput): Promise<string> {
  if (!settings.host.trim()) throw new Error('SMTP: ยังไม่ได้ตั้งค่าโฮสต์');
  const connection = new SmtpConnection(settings);
  try {
    const greeting = await connection.reply();
    if (greeting.code !== 220) throw new Error(`SMTP: ${greeting.lines.join(' ').slice(0, 300)}`);
    let ehlo = await connection.command(`EHLO ${settings.fromEmail.split('@')[1] || 'localhost'}`, 250).catch(async () => {
      return connection.command(`HELO ${settings.fromEmail.split('@')[1] || 'localhost'}`, 250);
    });
    if (settings.security === 'starttls') {
      await connection.command('STARTTLS', 220);
      await connection.startTls();
      ehlo = await connection.command(`EHLO ${settings.fromEmail.split('@')[1] || 'localhost'}`, 250);
    }
    if (password) {
      const user = (settings.user || settings.fromEmail).trim();
      const capabilities = ehlo.lines.join('\n').toUpperCase();
      if (capabilities.includes('AUTH') && capabilities.includes('PLAIN')) {
        await connection.command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')}`, 235);
      } else if (capabilities.includes('AUTH') && capabilities.includes('LOGIN')) {
        await connection.command('AUTH LOGIN', 334);
        await connection.command(Buffer.from(user, 'utf8').toString('base64'), 334);
        await connection.command(Buffer.from(password, 'utf8').toString('base64'), 235);
      } else {
        throw new Error('SMTP: เซิร์ฟเวอร์ไม่รองรับ AUTH PLAIN หรือ LOGIN');
      }
    }
    const { message, recipients, from } = buildMime(input, settings);
    await connection.command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of recipients) {
      const addressOnly = /<([^>]+)>/.exec(recipient)?.[1] ?? recipient;
      await connection.command(`RCPT TO:<${addressOnly.trim()}>`, 250);
    }
    await connection.command('DATA', 354);
    connection.writeRaw(`${dotStuff(message)}\r\n.\r\n`);
    const accepted = await connection.reply();
    if (accepted.code !== 250) throw new Error(`SMTP: ส่งไม่สำเร็จ: ${accepted.lines.join(' ').slice(0, 300)}`);
    await connection.close();
    return accepted.lines.join(' ').slice(0, 200) || 'ข้อความถูกส่งแล้ว';
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}

export async function smtpTest(settings: MailOutgoingSettings, password: string): Promise<string> {
  if (!settings.host.trim()) throw new Error('SMTP: ยังไม่ได้ตั้งค่าโฮสต์');
  const connection = new SmtpConnection(settings);
  try {
    const greeting = await connection.reply();
    if (greeting.code !== 220) throw new Error(`SMTP: ${greeting.lines.join(' ').slice(0, 300)}`);
    await connection.command(`EHLO ${settings.fromEmail.split('@')[1] || 'localhost'}`, 250);
    if (settings.security === 'starttls') {
      await connection.command('STARTTLS', 220);
      await connection.startTls();
      await connection.command(`EHLO ${settings.fromEmail.split('@')[1] || 'localhost'}`, 250);
    }
    if (password) {
      const user = (settings.user || settings.fromEmail).trim();
      await connection.command('AUTH LOGIN', 334);
      await connection.command(Buffer.from(user, 'utf8').toString('base64'), 334);
      await connection.command(Buffer.from(password, 'utf8').toString('base64'), 235);
    }
    await connection.close();
    return 'เชื่อมต่อ SMTP และยืนยันตัวตนได้';
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
}
