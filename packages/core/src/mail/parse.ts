/** Small RFC 822 / MIME reader for IMAP and POP3 mail: headers, addresses and text bodies. */

export interface MailHeaders {
  [name: string]: string;
}

export interface ParsedAddress {
  name: string;
  address: string;
}

export interface ParsedMail {
  headers: MailHeaders;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  text: string;
  html: string;
  attachments: Array<{ name: string; mime: string; bytes: number }>;
}

const MAX_BODY = 8_000;

/** RFC 2047 words (=?UTF-8?B?...?=) inside a header value. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_: string, hex: string) =>
                  String.fromCharCode(Number.parseInt(hex, 16)),
                ),
                'binary',
              );
        try {
          return new TextDecoder(charset.trim().replace(/^"|"$/g, '')).decode(bytes);
        } catch {
          return bytes.toString('utf8');
        }
      } catch {
        return text;
      }
    });
}

function splitHeadersAndBody(source: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(source);
  if (!match) return { head: source, body: '' };
  return { head: source.slice(0, match.index), body: source.slice(match.index + match[0].length) };
}

export function parseHeaders(head: string): MailHeaders {
  const headers: MailHeaders = {};
  const folded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of folded.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = decodeHeader(line.slice(at + 1).trim());
    if (!name) continue;
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return headers;
}

export function parseAddress(value: string): ParsedAddress {
  const text = decodeHeader(value).trim();
  const angle = /^(.*?)<([^>]+)>/.exec(text);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"|"$/g, '');
    return { name, address: angle[2]!.trim() };
  }
  return { name: '', address: text };
}

function addressList(value: string | undefined): ParsedAddress[] {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((entry) => parseAddress(entry))
    .filter((entry) => entry.address);
}

const display = (address: ParsedAddress): string => (address.name ? `${address.name} <${address.address}>` : address.address);

function decodeQuotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const source = text.replace(/=\r?\n/g, '');
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!;
    if (char === '=' && /^[0-9a-f]{2}$/i.test(source.slice(at + 1, at + 3))) {
      bytes.push(Number.parseInt(source.slice(at + 1, at + 3), 16));
      at += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string | undefined): string {
  const transfer = (encoding ?? '').toLowerCase();
  if (transfer === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (transfer === 'quoted-printable') return decodeQuotedPrintable(body).toString('utf8');
  return body;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function boundaryOf(contentType: string): string | undefined {
  return /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1]?.trim();
}

function parsePart(headers: MailHeaders, body: string, out: { text: string[]; html: string[]; attachments: ParsedMail['attachments'] }): void {
  const contentType = headers['content-type'] ?? 'text/plain; charset=utf-8';
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const disposition = headers['content-disposition'] ?? '';
  const filename = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1] ?? /name\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentType)?.[1];
  if (/attachment/i.test(disposition) || (filename && !/^text\/(plain|html)$/i.test(mime))) {
    const decoded = decodeBody(body, headers['content-transfer-encoding']);
    out.attachments.push({ name: decodeURIComponent(filename?.replace(/^"|"$/g, '') || 'attachment'), mime, bytes: Buffer.byteLength(decoded) });
    return;
  }
  if (mime.startsWith('multipart/')) {
    const boundary = boundaryOf(contentType);
    if (!boundary) return;
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`));
    for (const part of parts.slice(1)) {
      if (!part.trim() || part.trim() === '--') continue;
      const split = splitHeadersAndBody(part.replace(/^\r?\n/, ''));
      parsePart(parseHeaders(split.head), split.body, out);
    }
    return;
  }
  const decoded = decodeBody(body, headers['content-transfer-encoding']);
  if (mime === 'text/html') out.html.push(decoded);
  else if (mime === 'text/plain') out.text.push(decoded);
}

/** Reads a complete RFC 822 message into the fields the tools and triggers use. */
export function parseMail(source: string | Buffer): ParsedMail {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : source;
  const { head, body } = splitHeadersAndBody(raw.replace(/\r\n/g, '\n'));
  const headers = parseHeaders(head);
  const out: { text: string[]; html: string[]; attachments: ParsedMail['attachments'] } = { text: [], html: [], attachments: [] };
  parsePart(headers, body, out);
  const text = out.text.join('\n').trim();
  const html = out.html.join('\n').trim();
  const contentText = text || htmlToText(html);
  return {
    headers,
    from: addressList(headers.from).map(display).join(', '),
    to: addressList(headers.to).map(display).join(', '),
    cc: addressList(headers.cc).map(display).join(', '),
    subject: headers.subject ?? '',
    date: headers.date ?? '',
    messageId: headers['message-id'] ?? '',
    inReplyTo: headers['in-reply-to'] ?? '',
    references: headers.references ?? '',
    text: contentText.length > MAX_BODY ? `${contentText.slice(0, MAX_BODY)}\n… (${contentText.length - MAX_BODY} more characters)` : contentText,
    html,
    attachments: out.attachments,
  };
}

/** A short preview without downloading a whole message (headers only). */
export function previewOf(headers: MailHeaders, fallback = ''): string {
  return (headers['x-preview'] ?? fallback).replace(/\s+/g, ' ').trim().slice(0, 300);
}
