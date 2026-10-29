import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import type { GoogleAuth } from '../google/auth.ts';
import { gmailListUnread } from '../google/tools.ts';
import type { MicrosoftAuth } from '../microsoft/auth.ts';
import { outlookListUnread } from '../microsoft/tools.ts';

/**
 * "Push mail": watches for new unread mail — the connected Google and Microsoft
 * accounts plus any IMAP / POP3 mailbox — and raises a notification for each new
 * message, like a mail app would. True push (Pub/Sub, Exchange events) needs the
 * provider's cloud setup, so this watches instead: often enough to feel instant
 * and it works for every provider including POP3, which has no push at all.
 */

export type MailAccount =
  | { id: string; kind: 'google'; query: string }
  | { id: string; kind: 'microsoft'; query: string }
  | { id: string; kind: 'imap'; host: string; port: number; tls: boolean; user: string; query?: string }
  | { id: string; kind: 'pop3'; host: string; port: number; tls: boolean; user: string };

export interface MailWatchFile {
  accounts: MailAccount[];
  /** Recent seen message keys per account (ids, UIDs or UIDLs), newest last. */
  seen: Record<string, string[]>;
  lastCheckedAt: string | null;
}

const KEEP_SEEN = 300;

export interface MailWatchDeps {
  dir: string;
  /** Password lookup (and storage) per account id; values never land in the watch file. */
  password: (accountId: string) => string | undefined;
  setPassword(accountId: string, value: string | undefined): void;
  /** Google auth for the default Google account. */
  google(): GoogleAuth;
  /** Microsoft auth for the default Microsoft account. */
  microsoft(): MicrosoftAuth;
  notify(kind: 'message', title: string, body: string): void;
  timezone: string;
  now?: () => Date;
}

const seenKey = (account: MailAccount, id: string) => `${account.kind}:${id}`;

export class MailWatch {
  private readonly deps: MailWatchDeps;
  private readonly file: string;
  private data: MailWatchFile;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: MailWatchDeps) {
    this.deps = deps;
    this.file = path.join(deps.dir, 'mail-watch.json');
    this.data = { accounts: [], seen: {}, lastCheckedAt: null };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.data = {
          accounts: Array.isArray((parsed as Partial<MailWatchFile>).accounts) ? (parsed as MailWatchFile).accounts : [],
          seen: (parsed as Partial<MailWatchFile>).seen ?? {},
          lastCheckedAt: (parsed as Partial<MailWatchFile>).lastCheckedAt ?? null,
        };
      }
    } catch {
      // no accounts yet
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  list(): MailWatchFile {
    return { accounts: this.data.accounts, seen: this.data.seen, lastCheckedAt: this.data.lastCheckedAt };
  }

  saveAccount(account: MailAccount, password?: string): void {
    const existing = this.data.accounts.findIndex((entry) => entry.id === account.id);
    if (existing >= 0) this.data.accounts[existing] = account;
    else this.data.accounts.push(account);
    if (password !== undefined) {
      if (password) this.deps.setPassword(account.id, password);
      else this.deps.setPassword(account.id, undefined);
    }
    this.save();
  }

  removeAccount(id: string): void {
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id);
    delete this.data.seen[id];
    this.deps.setPassword(id, undefined);
    this.save();
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    // First look shortly after the app starts, so new mail is noticed early.
    const first = setTimeout(() => void this.tick(), 20_000);
    first.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** New keys of one account, remembering up to `KEEP_SEEN` of them. */
  private unseen(accountId: string, keys: string[]): string[] {
    const known = new Set(this.data.seen[accountId] ?? []);
    const fresh = keys.filter((key) => !known.has(key));
    if (fresh.length > 0) {
      this.data.seen[accountId] = [...(this.data.seen[accountId] ?? []), ...fresh].slice(-KEEP_SEEN);
    }
    return fresh;
  }

  /** One full pass over every account; returns how many new mails were found. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let found = 0;
    try {
      for (const account of [...this.data.accounts]) {
        try {
          found += await this.checkAccount(account);
        } catch (error) {
          this.deps.notify('message', 'Mail watch ล้มเหลว', `${labelOf(account)}: ${(error as Error).message}`);
        }
      }
      this.data.lastCheckedAt = new Date().toISOString();
      this.save();
    } finally {
      this.ticking = false;
    }
    return found;
  }

  private async checkAccount(account: MailAccount): Promise<number> {
    switch (account.kind) {
      case 'google': {
        const mails = await gmailListUnread(this.deps.google(), account.query || 'is:unread newer_than:2d', 20);
        const fresh = this.unseen(account.id, mails.map((mail) => seenKey(account, mail.id)));
        for (const mail of mails) {
          if (!fresh.includes(seenKey(account, mail.id))) continue;
          this.deps.notify('message', `✉️ ${mail.subject || '(ไม่มีหัวข้อ)'}`, `${mail.from}${mail.date ? ` · ${mail.date}` : ''}\n${mail.content.slice(0, 300)}`);
        }
        return fresh.length;
      }
      case 'microsoft': {
        const mails = await outlookListUnread(this.deps.microsoft(), account.query || '', 20);
        const fresh = this.unseen(account.id, mails.map((mail) => seenKey(account, mail.id)));
        for (const mail of mails) {
          if (!fresh.includes(seenKey(account, mail.id))) continue;
          this.deps.notify('message', `✉️ ${mail.subject || '(ไม่มีหัวข้อ)'}`, `${mail.from}\n${mail.content.slice(0, 300)}`);
        }
        return fresh.length;
      }
      case 'imap':
        return this.checkImap(account);
      case 'pop3':
        return this.checkPop3(account);
    }
  }

  private async checkImap(account: Extract<MailAccount, { kind: 'imap' }>): Promise<number> {
    const { ImapFlow } = await import('imapflow');
    const password = this.deps.password(account.id);
    if (!password) throw new Error('ยังไม่ได้ใส่รหัสผ่าน');
    const client = new ImapFlow({
      host: account.host,
      port: account.port || (account.tls ? 993 : 143),
      secure: account.tls !== false,
      auth: { user: account.user, pass: password },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const found: Array<{ uid: number; from: string; subject: string; snippet: string }> = [];
        const uids = (await client.search({ seen: false, since: new Date(Date.now() - 7 * 86_400_000) })) || [];
        for await (const message of client.fetch(uids.slice(-20), { uid: true, envelope: true, bodyStructure: false }, { uid: true })) {
          const snippet = await client.download(message.seq, '1', { maxBytes: 1500 });
          const parts: Buffer[] = [];
          if (snippet.content) for await (const part of snippet.content) parts.push(part as Buffer);
          found.push({
            uid: message.uid,
            from: message.envelope?.from?.[0]?.address ?? '',
            subject: message.envelope?.subject ?? '',
            snippet: Buffer.concat(parts).toString('utf8').replace(/\r/g, '').trim().slice(0, 300),
          });
        }
        const fresh = this.unseen(account.id, found.map((mail) => seenKey(account, String(mail.uid))));
        for (const mail of found) {
          if (!fresh.includes(seenKey(account, String(mail.uid)))) continue;
          this.deps.notify('message', `✉️ ${mail.subject || '(ไม่มีหัวข้อ)'}`, `${mail.from}\n${mail.snippet}`);
        }
        return fresh.length;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private checkPop3(account: Extract<MailAccount, { kind: 'pop3' }>): Promise<number> {
    const password = this.deps.password(account.id);
    if (!password) return Promise.reject(new Error('ยังไม่ได้ใส่รหัสผ่าน'));
    return new Promise((resolve, reject) => {
      const port = account.port || (account.tls ? 995 : 110);
      const socket = account.tls === false ? net.connect(port, account.host) : tls.connect({ host: account.host, port, servername: account.host, rejectUnauthorized: true });
      socket.setTimeout(20_000, () => socket.destroy(new Error('POP3: หมดเวลา')));
      const lines: string[] = [];
      const waiters: Array<() => void> = [];
      let buffer = '';
      let failed = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) break;
          lines.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
        while (waiters.length > 0) waiters.shift()!();
      });
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        socket.destroy();
        reject(error);
      };
      socket.on('error', fail);
      const nextLine = () =>
        new Promise<string | null>((settle) => {
          if (failed) return settle(null);
          if (lines.length > 0) return settle(lines.shift()!);
          waiters.push(() => settle(lines.length > 0 ? lines.shift()! : null));
        });
      const sendLine = (text: string) => socket.write(`${text}\r\n`);
      /** USER / PASS / QUIT answer with one +OK line. */
      const readLine = async (): Promise<string> => {
        const line = await nextLine();
        if (line === null) throw new Error('POP3: การเชื่อมต่อขาด');
        if (line.startsWith('-ERR')) throw new Error(line.slice(4).trim() || 'POP3: เซิร์ฟเวอร์ปฏิเสธ');
        if (!line.startsWith('+OK')) throw new Error(`POP3: ${line}`);
        return line;
      };
      /** UIDL / TOP / LIST answer with +OK, then lines until a line with just ".". */
      const readMulti = async (): Promise<string[]> => {
        await readLine();
        const rest: string[] = [];
        for (;;) {
          const line = await nextLine();
          if (line === null) throw new Error('POP3: การเชื่อมต่อขาดกลางทาง');
          if (line === '.') return rest;
          rest.push(line);
        }
      };
      void (async () => {
        try {
          await readLine(); // greeting
          sendLine(`USER ${account.user}`);
          await readLine();
          sendLine(`PASS ${password}`);
          await readLine();
          sendLine('UIDL');
          const uidlLines = await readMulti();
          const known = new Set(this.data.seen[account.id] ?? []);
          const fresh = uidlLines
            .map((line) => line.trim())
            .filter((line) => /^\d+\s+\S+/.test(line))
            .map((line) => ({ number: line.split(/\s+/)[0]!, key: line.split(/\s+/)[1] ?? line }))
            .filter((entry) => !known.has(seenKey(account, entry.key)));
          const notified: string[] = [];
          for (const entry of fresh.slice(-20)) {
            sendLine(`TOP ${entry.number} 3`);
            const head = await readMulti();
            const subject = /^Subject:\s*(.+)$/im.exec(head.join('\n'))?.[1]?.trim() ?? '(ไม่มีหัวข้อ)';
            const from = /^From:\s*(.+)$/im.exec(head.join('\n'))?.[1]?.trim() ?? '';
            this.deps.notify('message', `✉️ ${subject}`, from);
            notified.push(seenKey(account, entry.key));
          }
          this.unseen(account.id, notified);
          sendLine('QUIT');
          socket.end();
          resolve(notified.length);
        } catch (error) {
          fail(error as Error);
        }
      })();
    });
  }
}

export const labelOf = (account: MailAccount): string =>
  account.kind === 'google' ? 'Gmail' : account.kind === 'microsoft' ? 'Outlook' : `${account.kind.toUpperCase()} · ${account.user}`;
