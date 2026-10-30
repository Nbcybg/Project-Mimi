import fs from 'node:fs';
import path from 'node:path';
import type {
  MailAccountView,
  MailIncomingSettings,
  MailOutgoingSettings,
  MailWatchAccount,
} from '@mimi/shared';
import type { GoogleAuth } from '../google/auth.ts';
import { gmailListUnread } from '../google/tools.ts';
import type { MicrosoftAuth } from '../microsoft/auth.ts';
import { outlookListUnread } from '../microsoft/tools.ts';
import type { TimeZoneSource } from '../timezone.ts';
import { imapMarkRead, imapRead, imapSearch, imapTest } from '../mail/imap.ts';
import { pop3List, pop3Read, pop3Test } from '../mail/pop3.ts';
import { sendSmtpMail, smtpTest } from '../mail/smtp.ts';
import type { MailReadResult, MailSearchOptions, MailSendInput, MailSummary } from '../mail/types.ts';

/**
 * "Push mail": watches for new mail — the connected Google and Microsoft accounts plus
 * any IMAP / POP3 mailbox — and raises a notification for each new message, like a mail
 * app would. The same accounts back the IMAP / POP3 / SMTP tools and the mail workflow
 * trigger. Account settings never contain a password: secrets live in the vault under
 * `mail.<id>.password` and `mail.<id>.smtp_password` (the old `mail-watch.<id>` name is
 * still read for accounts made by earlier versions).
 */

type MailAccount = MailWatchAccount;
type LocalMailAccount = Extract<MailWatchAccount, { kind: 'imap' | 'pop3' }>;

export interface MailWatchFile {
  accounts: MailAccount[];
  /** Recent seen message keys per account (ids, UIDs or UIDLs), newest last. */
  seen: Record<string, string[]>;
  /** When each account was last checked, for the hub screen. */
  checkedAt?: Record<string, string>;
  lastCheckedAt: string | null;
}

const KEEP_SEEN = 300;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{2,80}$/;
const LOCAL_KINDS = new Set(['imap', 'pop3']);

export interface MailWatchDeps {
  dir: string;
  /** Password lookup (and storage) per account id; values never land in the watch file. */
  password: (accountId: string) => string | undefined;
  setPassword(accountId: string, value: string | undefined): void;
  smtpPassword?: (accountId: string) => string | undefined;
  setSmtpPassword?: (accountId: string, value: string | undefined) => void;
  /** Google auth for the default Google account. */
  google(): GoogleAuth;
  /** Microsoft auth for the default Microsoft account. */
  microsoft(): MicrosoftAuth;
  notify(kind: 'message', title: string, body: string): void;
  timezone: TimeZoneSource;
  now?: () => Date;
}

const seenKey = (account: MailAccount, id: string) => `${account.kind}:${id}`;

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value.trim() : fallback);
const number = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fallback);

function normalizeIncoming(raw: Record<string, unknown>, kind: 'imap' | 'pop3'): MailIncomingSettings {
  return {
    protocol: kind,
    host: text(raw.host),
    port: Math.max(0, Math.min(65_535, Math.round(number(raw.port, 0)))),
    security: raw.security === 'starttls' || raw.security === 'none' ? raw.security : raw.tls === false ? 'none' : 'tls',
    rejectUnauthorized: bool(raw.rejectUnauthorized, true),
    user: text(raw.user),
    ...(text(raw.folder) ? { folder: text(raw.folder) } : {}),
    ...(text(raw.query) ? { query: text(raw.query) } : {}),
    unseenOnly: bool(raw.unseenOnly, false),
    sinceDays: Math.max(0, Math.min(3650, Math.round(number(raw.sinceDays, 0)))),
    maxMessages: Math.max(1, Math.min(100, Math.round(number(raw.maxMessages, 10)))),
    markRead: bool(raw.markRead, false),
    deleteAfterFetch: bool(raw.deleteAfterFetch, false),
    pollMinutes: Math.max(0, Math.min(1440, Math.round(number(raw.pollMinutes, 0)))),
    timeoutMs: Math.max(5_000, Math.min(120_000, Math.round(number(raw.timeoutMs, 30_000)))),
  };
}

function normalizeOutgoing(raw: unknown): MailOutgoingSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const host = text(source.host);
  if (!host) return undefined;
  return {
    host,
    port: Math.max(0, Math.min(65_535, Math.round(number(source.port, 0)))),
    security: source.security === 'starttls' || source.security === 'none' ? source.security : source.tls === false ? 'none' : 'tls',
    rejectUnauthorized: bool(source.rejectUnauthorized, true),
    ...(text(source.user) ? { user: text(source.user) } : {}),
    useIncomingPassword: bool(source.useIncomingPassword, true),
    fromEmail: text(source.fromEmail) || text(source.user) || text(source.email),
    ...(text(source.fromName) ? { fromName: text(source.fromName) } : {}),
    ...(text(source.replyTo) ? { replyTo: text(source.replyTo) } : {}),
    timeoutMs: Math.max(5_000, Math.min(120_000, Math.round(number(source.timeoutMs, 30_000)))),
  };
}

/** Turns old flat accounts and client input into the current shape, dropping unknown keys. */
export function normalizeMailAccount(raw: unknown): MailAccount | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const id = text(source.id).toLowerCase();
  if (!ACCOUNT_ID.test(id)) return undefined;
  const kind = text(source.kind);
  if (kind === 'google' || kind === 'microsoft') {
    return { id, kind, ...(text(source.name) ? { name: text(source.name) } : {}), ...(text(source.email) ? { email: text(source.email) } : {}), query: text(source.query) };
  }
  if (kind !== 'imap' && kind !== 'pop3') return undefined;
  const incomingRaw = source.incoming && typeof source.incoming === 'object' ? (source.incoming as Record<string, unknown>) : source;
  const incoming = normalizeIncoming(incomingRaw, kind);
  if (!incoming.host || !incoming.user) return undefined;
  const outgoingRaw = source.outgoing && typeof source.outgoing === 'object' ? source.outgoing : undefined;
  const outgoing = normalizeOutgoing(outgoingRaw) ?? (outgoingRaw ? undefined : normalizeOutgoing(source.smtp));
  return {
    id,
    kind,
    name: text(source.name) || `${kind.toUpperCase()} · ${incoming.user}`,
    ...(text(source.email) ? { email: text(source.email) } : {}),
    incoming,
    ...(outgoing ? { outgoing } : {}),
    default: bool(source.default, false),
  };
}

export class MailWatch {
  private readonly deps: MailWatchDeps;
  private readonly file: string;
  private data: MailWatchFile;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: MailWatchDeps) {
    this.deps = deps;
    this.file = path.join(deps.dir, 'mail-watch.json');
    this.data = { accounts: [], seen: {}, checkedAt: {}, lastCheckedAt: null };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const stored = parsed as Partial<MailWatchFile>;
        this.data = {
          accounts: Array.isArray(stored.accounts)
            ? stored.accounts.map((entry) => normalizeMailAccount(entry)).filter((entry): entry is MailAccount => entry !== undefined)
            : [],
          seen: stored.seen ?? {},
          checkedAt: stored.checkedAt ?? {},
          lastCheckedAt: stored.lastCheckedAt ?? null,
        };
        // Rewrite the old flat shape once, so a hand edit of the file sees the current shape.
        if (JSON.stringify(stored.accounts ?? []) !== JSON.stringify(this.data.accounts)) this.save();
      }
    } catch {
      // no accounts yet
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Windows or a read-only mount: the content still holds no secret.
    }
  }

  list(): MailWatchFile {
    return {
      accounts: this.data.accounts,
      seen: this.data.seen,
      checkedAt: this.data.checkedAt ?? {},
      lastCheckedAt: this.data.lastCheckedAt,
    };
  }

  /** Accounts with their secret status, safe for the hub screen. */
  views(): MailAccountView[] {
    return this.data.accounts.map((account) => {
      const checkedAt = this.data.checkedAt?.[account.id] ?? null;
      if (account.kind === 'google' || account.kind === 'microsoft') {
        return { ...account, hasPassword: true, hasOutgoingPassword: false, connected: true, lastCheckedAt: checkedAt };
      }
      const password = this.accountPassword(account);
      const outgoingPassword = this.outgoingPassword(account);
      const connected = Boolean(password) && (!account.outgoing || Boolean(outgoingPassword));
      return {
        ...account,
        hasPassword: Boolean(password),
        hasOutgoingPassword: Boolean(outgoingPassword),
        connected,
        lastCheckedAt: checkedAt,
      };
    });
  }

  find(id: string): MailAccount | undefined {
    return this.data.accounts.find((account) => account.id === id);
  }

  /** The account used when a tool names none: marked default, else the first of the kind. */
  defaultAccount(kind?: 'google' | 'microsoft' | 'imap' | 'pop3'): MailAccount | undefined {
    const ofKind = kind ? this.data.accounts.filter((account) => account.kind === kind) : this.data.accounts;
    return ofKind.find((account) => account.kind !== 'google' && account.kind !== 'microsoft' && account.default) ?? ofKind[0];
  }

  localAccounts(): LocalMailAccount[] {
    return this.data.accounts.filter((account): account is LocalMailAccount => account.kind === 'imap' || account.kind === 'pop3');
  }

  private defaultLocal(): LocalMailAccount | undefined {
    const local = this.localAccounts();
    return local.find((account) => account.default) ?? local[0];
  }

  saveAccount(account: MailAccount, password?: string, smtpPassword?: string): void {
    const normalized = normalizeMailAccount(account);
    if (!normalized) throw new Error('บัญชีเมลไม่ครบ: ต้องมี id, kind, โฮสต์ และผู้ใช้');
    const existing = this.data.accounts.findIndex((entry) => entry.id === normalized.id);
    if (normalized.kind !== 'google' && normalized.kind !== 'microsoft' && normalized.default) {
      for (const other of this.data.accounts) other.kind !== 'google' && other.kind !== 'microsoft' && (other.default = false);
    }
    if (existing >= 0) this.data.accounts[existing] = normalized;
    else this.data.accounts.push(normalized);
    if (password !== undefined) this.deps.setPassword(normalized.id, password.trim() || undefined);
    if (smtpPassword !== undefined && this.deps.setSmtpPassword) this.deps.setSmtpPassword(normalized.id, smtpPassword.trim() || undefined);
    this.save();
  }

  removeAccount(id: string): void {
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id);
    delete this.data.seen[id];
    if (this.data.checkedAt) delete this.data.checkedAt[id];
    this.deps.setPassword(id, undefined);
    this.deps.setSmtpPassword?.(id, undefined);
    this.save();
  }

  private accountPassword(account: LocalMailAccount): string | undefined {
    return this.deps.password(account.id);
  }

  private outgoingPassword(account: LocalMailAccount): string | undefined {
    if (!account.outgoing) return undefined;
    if (account.outgoing.useIncomingPassword !== false) return this.deps.smtpPassword?.(account.id) ?? this.accountPassword(account);
    return this.deps.smtpPassword?.(account.id);
  }

  private requireAccount(accountId?: string, kind?: 'imap' | 'pop3'): LocalMailAccount {
    const account = accountId ? this.find(accountId) : kind ? this.defaultAccount(kind) : this.defaultLocal();
    if (!account) throw new Error(kind ? `ยังไม่มีบัญชี ${kind.toUpperCase()} — เพิ่มที่ Hub → Mail` : 'ยังไม่มีบัญชีเมล — เพิ่มที่ Hub → Mail');
    if (account.kind === 'google' || account.kind === 'microsoft') throw new Error(`บัญชี "${account.name ?? account.id}" เป็น Gmail/Outlook ใช้เครื่องมือ gmail_* หรือ outlook_* แทน`);
    if (kind && account.kind !== kind) throw new Error(`บัญชี "${account.name}" เป็น ${account.kind.toUpperCase()} ไม่ใช่ ${kind.toUpperCase()}`);
    const password = this.accountPassword(account);
    if (!password) throw new Error(`บัญชี "${account.name}" ยังไม่มีรหัสผ่าน — ตั้งที่ Hub → Mail`);
    return account;
  }

  /** Finds an account by id or returns the default one, for account-aware tools. */
  accountFor(accountId?: string): LocalMailAccount {
    return this.requireAccount(accountId);
  }

  async search(accountId: string | undefined, options: MailSearchOptions = {}, kind?: 'imap' | 'pop3'): Promise<{ account: LocalMailAccount; messages: MailSummary[] }> {
    const account = this.requireAccount(accountId, kind);
    const password = this.accountPassword(account)!;
    const messages = account.kind === 'imap'
      ? await imapSearch(account.incoming, password, { ...options, folder: options.folder ?? account.incoming.folder })
      : await pop3List(account.incoming, password, { ...options, folder: undefined });
    return { account, messages };
  }

  async read(
    accountId: string | undefined,
    id: string,
    kind?: 'imap' | 'pop3',
    options: { deleteAfterFetch?: boolean; folder?: string } = {},
  ): Promise<{ account: LocalMailAccount; message: MailReadResult }> {
    const account = this.requireAccount(accountId, kind);
    const password = this.accountPassword(account)!;
    const message = account.kind === 'imap'
      ? await imapRead(account.incoming, password, id, options.folder?.trim() || account.incoming.folder)
      : await pop3Read(account.incoming, password, id, options);
    return { account, message };
  }

  async markRead(accountId: string | undefined, ids: string[], kind?: 'imap' | 'pop3', folder?: string): Promise<void> {
    if (ids.length === 0) return;
    const account = this.requireAccount(accountId, kind);
    if (account.kind !== 'imap') return; // POP3 has no Seen flag
    await imapMarkRead(account.incoming, this.accountPassword(account)!, ids, folder?.trim() || account.incoming.folder);
  }

  async send(accountId: string | undefined, input: MailSendInput): Promise<{ account: LocalMailAccount; result: string }> {
    const account = this.requireAccount(accountId);
    const outgoing = account.outgoing;
    if (!outgoing) throw new Error(`บัญชี "${account.name}" ยังไม่ได้ตั้งค่า SMTP — เพิ่มที่ Hub → Mail`);
    const password = this.outgoingPassword(account);
    if (!password) throw new Error(`บัญชี "${account.name}" ยังไม่มีรหัสผ่าน SMTP — ตั้งที่ Hub → Mail`);
    const result = await sendSmtpMail(
      {
        ...outgoing,
        fromEmail: outgoing.fromEmail || account.email || account.incoming.user,
        ...(input.fromName ? { fromName: input.fromName } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      },
      password,
      input,
    );
    return { account, result };
  }

  async test(id: string): Promise<string> {
    const account = this.find(id);
    if (!account) throw new Error(`ไม่พบบัญชี "${id}"`);
    if (account.kind === 'google' || account.kind === 'microsoft') return 'บัญชี Gmail/Outlook ใช้การเชื่อมต่อ OAuth ที่ Hub → บัญชี';
    const password = this.accountPassword(account);
    if (!password) throw new Error('ยังไม่มีรหัสผ่าน');
    const incoming = account.kind === 'imap' ? await imapTest(account.incoming, password) : await pop3Test(account.incoming, password);
    if (!account.outgoing) return incoming;
    const outgoing = this.outgoingPassword(account);
    if (!outgoing) return `${incoming} · ยังไม่มีรหัสผ่าน SMTP`;
    try {
      return `${incoming} · ${await smtpTest(account.outgoing, outgoing)}`;
    } catch (error) {
      return `${incoming} · SMTP ยังไม่ผ่าน: ${(error as Error).message}`;
    }
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
      const nowDate = this.deps.now?.() ?? new Date();
      const now = nowDate.toISOString();
      for (const account of [...this.data.accounts]) {
        try {
          const every = account.kind === 'imap' || account.kind === 'pop3' ? Math.max(0, account.incoming.pollMinutes ?? 0) : 0;
          const last = this.data.checkedAt?.[account.id];
          if (every > 0 && last && nowDate.getTime() - Date.parse(last) < every * 60_000) continue;
          found += await this.checkAccount(account);
          this.data.checkedAt = { ...(this.data.checkedAt ?? {}), [account.id]: now };
        } catch (error) {
          this.deps.notify('message', 'Mail watch ล้มเหลว', `${labelOf(account)}: ${redactSecret((error as Error).message, this.accountPassword(account as LocalMailAccount))}`);
        }
      }
      this.data.lastCheckedAt = now;
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
      case 'pop3': {
        const password = this.accountPassword(account);
        if (!password) throw new Error('ยังไม่ได้ใส่รหัสผ่าน');
        const messages = account.kind === 'imap'
          ? await imapSearch(account.incoming, password, { unseenOnly: true, max: 20, folder: account.incoming.folder })
          : await pop3List(account.incoming, password, { max: 20 });
        const fresh = this.unseen(account.id, messages.map((mail) => seenKey(account, mail.id)));
        for (const mail of messages) {
          if (!fresh.includes(seenKey(account, mail.id))) continue;
          this.deps.notify('message', `✉️ ${mail.subject || '(ไม่มีหัวข้อ)'}`, `${mail.from}${mail.date ? ` · ${mail.date}` : ''}\n${mail.preview}`);
        }
        return fresh.length;
      }
    }
  }
}

function redactSecret(message: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return message;
  return message.split(secret).join('[redacted]');
}

export const labelOf = (account: MailAccount): string =>
  account.kind === 'google'
    ? 'Gmail'
    : account.kind === 'microsoft'
      ? 'Outlook'
      : `${account.kind.toUpperCase()} · ${account.email || account.incoming.user}`;
