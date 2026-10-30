import type { MailIncomingSettings } from '@mimi/shared';
import { parseHeaders, parseMail } from './parse.ts';
import { type MailReadResult, type MailSearchOptions, type MailSummary } from './types.ts';

/** The IMAP client is loaded on first use, so a core without mail accounts starts faster. */
async function clientFor(settings: MailIncomingSettings, password: string) {
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({
    host: settings.host,
    port: settings.port || (settings.security === 'tls' ? 993 : 143),
    secure: settings.security === 'tls',
    ...(settings.security === 'starttls' ? { doSTARTTLS: true } : settings.security === 'none' ? { doSTARTTLS: false } : {}),
    auth: { user: settings.user, pass: password },
    tls: { rejectUnauthorized: settings.rejectUnauthorized !== false },
    logger: false,
    disableAutoIdle: true,
    socketTimeout: Math.max(5_000, settings.timeoutMs ?? 30_000),
    greetingTimeout: Math.max(5_000, settings.timeoutMs ?? 30_000),
  });
}

const iso = (value: Date | string | undefined): string => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const addressText = (entry: { name?: string; address?: string } | undefined): string =>
  entry ? (entry.name ? `${entry.name} <${entry.address ?? ''}>` : (entry.address ?? '')) : '';

function searchObject(settings: MailIncomingSettings, options: MailSearchOptions): Record<string, unknown> {
  const search: Record<string, unknown> = {};
  if (options.unseenOnly || (options.unseenOnly === undefined && settings.unseenOnly)) search.seen = false;
  const days = Number(options.sinceDays ?? settings.sinceDays ?? 0);
  if (Number.isFinite(days) && days > 0) search.since = new Date(Date.now() - Math.min(days, 3650) * 86_400_000);
  const query = (options.query ?? settings.query ?? '').trim();
  if (query) search.or = [{ subject: query }, { from: query }, { text: query }];
  if (Object.keys(search).length === 0) search.all = true;
  return search;
}

function summaryOf(message: {
  uid: number;
  envelope?: { from?: Array<{ name?: string; address?: string }>; to?: Array<{ name?: string; address?: string }>; subject?: string; date?: Date | string };
  flags?: Set<string>;
  internalDate?: Date | string;
  size?: number;
}): MailSummary {
  const from = (message.envelope?.from ?? []).map(addressText).filter(Boolean).join(', ');
  const to = (message.envelope?.to ?? []).map(addressText).filter(Boolean).join(', ');
  return {
    id: String(message.uid),
    uid: message.uid,
    from,
    to,
    subject: message.envelope?.subject ?? '',
    date: iso(message.envelope?.date ?? message.internalDate),
    preview: '',
    seen: message.flags?.has('\\Seen') === true,
    ...(message.size ? { size: message.size } : {}),
  };
}

async function collect(stream: AsyncIterable<Buffer>, limit = 8 * 1024 * 1024): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of stream) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if (total + buffer.length > limit) {
      parts.push(buffer.subarray(0, Math.max(0, limit - total)));
      break;
    }
    parts.push(buffer);
    total += buffer.length;
  }
  return Buffer.concat(parts);
}

export async function imapSearch(settings: MailIncomingSettings, password: string, options: MailSearchOptions = {}): Promise<MailSummary[]> {
  const client = await clientFor(settings, password);
  await client.connect();
  try {
    const folder = options.folder?.trim() || settings.folder?.trim() || 'INBOX';
    const lock = await client.getMailboxLock(folder);
    try {
      const found = await client.search(searchObject(settings, options), { uid: true });
      const uids = Array.isArray(found) ? found.slice(-Math.max(1, Math.min(100, options.max ?? settings.maxMessages ?? 10))) : [];
      if (uids.length === 0) return [];
      const messages = await client.fetchAll(uids, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true });
      const summaries = messages.map(summaryOf);
      if (options.markRead) {
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      }
      return summaries;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function imapRead(settings: MailIncomingSettings, password: string, uid: string, folder?: string): Promise<MailReadResult> {
  const client = await clientFor(settings, password);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder?.trim() || settings.folder?.trim() || 'INBOX');
    try {
      const download = await client.download(String(uid), undefined, { uid: true });
      if (!download || !('content' in download) || !download.content) throw new Error(`ไม่พบเมล uid ${uid}`);
      const raw = await collect(download.content);
      const parsed = parseMail(raw);
      const message = (await client.fetchOne(String(uid), { uid: true, flags: true, size: true }, { uid: true })) || undefined;
      if (settings.markRead && message && !message.flags?.has('\\Seen')) {
        await client.messageFlagsAdd([Number(uid)], ['\\Seen'], { uid: true });
      }
      return {
        id: String(uid),
        uid: Number(uid),
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        date: parsed.date || iso(message?.internalDate),
        preview: parsed.text.slice(0, 300),
        seen: message?.flags?.has('\\Seen') === true || Boolean(settings.markRead),
        text: parsed.text,
        html: parsed.html,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        attachments: parsed.attachments,
        ...(message?.size ? { size: message.size } : {}),
        folder: folder?.trim() || settings.folder?.trim() || 'INBOX',
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function imapMarkRead(settings: MailIncomingSettings, password: string, uids: string[], folder?: string): Promise<void> {
  const numeric = uids.map(Number).filter((value) => Number.isInteger(value) && value > 0);
  if (numeric.length === 0) return;
  const client = await clientFor(settings, password);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder?.trim() || settings.folder?.trim() || 'INBOX');
    try {
      await client.messageFlagsAdd(numeric, ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Opens a mailbox and logs out: proves the host, cipher and password work. */
export async function imapTest(settings: MailIncomingSettings, password: string): Promise<string> {
  const client = await clientFor(settings, password);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(settings.folder?.trim() || 'INBOX');
    try {
      const exists = (client as unknown as { mailbox?: { exists?: number } }).mailbox?.exists ?? 0;
      return `เชื่อมต่อ IMAP ได้ · ${settings.folder?.trim() || 'INBOX'} มี ${exists} ฉบับ`;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Headers of one message when only the envelope is needed. */
export function headersOf(source: string | Buffer) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : source;
  const split = text.split(/\r?\n\r?\n/);
  return parseHeaders(split[0] ?? '');
}
