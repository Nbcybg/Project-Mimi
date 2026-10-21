import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageRole } from '@mimi/shared';
import { generateText } from 'ai';
import type { AgentDefinition } from '../agents/loader.ts';
import type { Db } from '../db/db.ts';
import type { ModelService } from '../providers/routing.ts';
import type { UsageLogger } from '../usage/logger.ts';
import { xlsxText } from '../workflows/xlsx.ts';

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

export interface Attachment {
  id: string;
  messageId: number | null;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  /** What the models can read of the file: a description, a transcript or its text. */
  text: string;
  /** SHA-256 of the bytes; the same file uploaded twice shares what the models read. */
  hash: string | null;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  message_id: number | null;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  text: string;
  hash: string | null;
  created_at: string;
}

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  messageId: row.message_id,
  kind: row.kind,
  name: row.name,
  mime: row.mime,
  size: row.size,
  text: row.text,
  hash: row.hash,
  createdAt: row.created_at,
});

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TEXT_FILE_LIMIT = 60_000;
/** Total text one user message may carry from its files; the full text stays on each attachment. */
export const TOTAL_ATTACHMENT_CHARS = 120_000;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sh|ps1|bat|sql|ini|toml|env|log|srt|vtt)$/i;

function kindOf(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

function isTextFile(attachment: Attachment): boolean {
  return (
    attachment.mime.startsWith('text/') ||
    /(json|xml|yaml|javascript|csv)/.test(attachment.mime) ||
    TEXT_EXTENSIONS.test(attachment.name)
  );
}

/** The type the bytes really are, when their signature is one we know. */
export function sniffMime(data: Buffer, declared: string): string {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (data.length >= 4 && data[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
  }
  return declared;
}

/** Files the user sent: the bytes live in a folder, everything else in the database. */
export class AttachmentStore {
  private readonly db: Db;
  private readonly dir: string;

  constructor(db: Db, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  save(file: { name: string; mime: string; data: Buffer }): Attachment {
    if (file.data.length === 0) throw new Error('The file is empty.');
    if (file.data.length > MAX_ATTACHMENT_BYTES) throw new Error('The file is larger than 25 MB.');
    const id = randomUUID();
    const declared = sniffMime(file.data, file.mime);
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared.toLowerCase() : 'application/octet-stream';
    const hash = createHash('sha256').update(file.data).digest('hex');
    // Only the last path segment, without characters a file system or a header would trip over.
    const base = file.name.split(/[\\/]/).pop() ?? '';
    const name = base.replace(/[:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'file';
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, id), file.data);
    this.db
      .prepare(`INSERT INTO attachments (id, kind, name, mime, size, hash) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, kindOf(mime), name, mime, file.data.length, hash);
    return this.get(id)!;
  }

  get(id: string): Attachment | undefined {
    const row = this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as AttachmentRow | undefined;
    return row && toAttachment(row);
  }

  /** The stored bytes; undefined when the id is unknown or the file is gone. */
  read(id: string): Buffer | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const file = path.join(this.dir, id);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }

  setText(id: string, text: string): void {
    this.db.prepare(`UPDATE attachments SET text = ? WHERE id = ?`).run(text, id);
  }

  /** What another copy of the same bytes was already read as, if any. */
  textOfHash(hash: string, excludeId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT text FROM attachments WHERE hash = ? AND id <> ? AND text <> '' ORDER BY created_at LIMIT 1`)
      .get(hash, excludeId) as { text: string } | undefined;
    return row?.text;
  }

  link(ids: string[], messageId: number): void {
    const update = this.db.prepare(`UPDATE attachments SET message_id = ? WHERE id = ?`);
    for (const id of ids) update.run(messageId, id);
  }

  /** Copies an attachment (bytes and metadata) so a forwarded message keeps its own. */
  clone(id: string): string | undefined {
    const source = this.get(id);
    const data = this.read(id);
    if (!source || !data) return undefined;
    const copy = randomUUID();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, copy), data);
    this.db
      .prepare(`INSERT INTO attachments (id, kind, name, mime, size, text, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(copy, source.kind, source.name, source.mime, source.size, source.text, source.hash);
    return copy;
  }

  /** Attachments of the given messages, keyed by message id. */
  forMessages(messageIds: number[]): Map<number, Attachment[]> {
    const byMessage = new Map<number, Attachment[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = this.db
      .prepare(
        `SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => '?').join(', ')}) ORDER BY created_at, id`,
      )
      .all(...messageIds) as AttachmentRow[];
    for (const row of rows) {
      const list = byMessage.get(row.message_id!) ?? [];
      list.push(toAttachment(row));
      byMessage.set(row.message_id!, list);
    }
    return byMessage;
  }

  /**
   * Files of the given messages to hand to a chat model as they are, when the model can
   * take them. Only the newest images and PDFs are chosen, within a byte budget, so a long
   * session does not resend every file. The ids that are sent as bytes come back with the
   * parts: their text description must not be duplicated in the prompt.
   */
  promptFiles(
    messageIds: number[],
    options: { images: number; pdfs: number; maxPdfBytes?: number },
  ): Map<number, PromptFiles> {
    const selected = new Map<number, PromptFiles>();
    if (messageIds.length === 0 || (options.images <= 0 && options.pdfs <= 0)) return selected;
    const byDate = (a: Attachment, b: Attachment) =>
      a.messageId! - b.messageId! || a.createdAt.localeCompare(b.createdAt);
    const all = [...this.forMessages(messageIds).values()].flat();
    const chosen: Attachment[] = [];
    if (options.images > 0) {
      chosen.push(
        ...all
          .filter((attachment) => attachment.kind === 'image' && MODEL_IMAGE.test(attachment.mime))
          .sort(byDate)
          .slice(-options.images),
      );
    }
    if (options.pdfs > 0) {
      const budget = options.maxPdfBytes ?? MAX_PROMPT_PDF_BYTES;
      let used = 0;
      const pdfs: Attachment[] = [];
      for (const attachment of all.filter(isPdfAttachment).sort(byDate).reverse()) {
        if (pdfs.length >= options.pdfs) break;
        if (used + attachment.size > budget) continue;
        pdfs.push(attachment);
        used += attachment.size;
      }
      chosen.push(...pdfs);
    }
    for (const attachment of chosen.sort(byDate)) {
      const data = this.read(attachment.id);
      if (!data) continue;
      const entry = selected.get(attachment.messageId!) ?? { parts: [], stripIds: new Set<string>() };
      entry.parts.push({ type: 'file', data, mediaType: attachment.mime, filename: attachment.name });
      entry.stripIds.add(attachment.id);
      selected.set(attachment.messageId!, entry);
    }
    return selected;
  }
}

/** What a chat model gets as bytes, plus the attachments whose text was already sent. */
export interface PromptFiles {
  parts: MediaPart[];
  stripIds: Set<string>;
}

/** A file handed to a model as it is (not as its description). */
export interface MediaPart {
  type: 'file';
  data: Buffer;
  mediaType: string;
  filename: string;
}

/** Image formats every vision-capable chat model takes. */
const MODEL_IMAGE = /^image\/(png|jpeg|webp|gif)$/;
/** Newer PDFs are not sent as bytes; only their extracted text goes to the model. */
const MAX_PROMPT_PDF_BYTES = 20 * 1024 * 1024;

export function isPdfAttachment(attachment: Pick<Attachment, 'mime' | 'name'>): boolean {
  return attachment.mime === 'application/pdf' || /\.pdf$/i.test(attachment.name);
}

/** How an attachment appears inside the user's message, for the models. */
export function renderAttachment(attachment: Attachment, maxChars = 0): string {
  const full = attachment.text.trim() || '(could not be read)';
  const body =
    maxChars > 0 && full.length > maxChars
      ? `${full.slice(0, maxChars)}\n[file cut here: ${full.length - maxChars} more characters]`
      : full;
  return `<attachment id="${attachment.id}" kind="${attachment.kind}" name="${attachment.name}">\n${body}\n</attachment>`;
}

/** Renders every file of one message, sharing a total budget fairly, so none is starved. */
export function renderAttachments(files: Attachment[], totalChars = TOTAL_ATTACHMENT_CHARS): string[] {
  if (files.length === 0) return [];
  const each = Math.max(2_000, Math.min(TEXT_FILE_LIMIT, Math.floor(totalChars / files.length)));
  return files.map((attachment) => renderAttachment(attachment, each));
}

/** A note left on a file when its model call failed; the next send tries again. */
export function isUnreadableText(text: string): boolean {
  return /^\(this \w+ could not be read:/.test(text);
}

/** Drops the blocks of attachments the model already receives as bytes. */
export function stripAttachmentBlocks(text: string, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return text;
  const names = [...ids].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text
    .replace(new RegExp(`\\n*<attachment id="(?:${names})"[^>]*>[\\s\\S]*?<\\/attachment>`, 'g'), '')
    .trim();
}

/**
 * The user's own words, without the machine-only blocks a message may carry:
 * attachment content and the quote of a replied-to message.
 */
export function stripAttachments(text: string): string {
  return text
    .replace(/\n*<attachment [^>]*>[\s\S]*?<\/attachment>/g, '')
    .replace(/\n*<reply_to [^>]*>[\s\S]*?<\/reply_to>\n*/g, '\n')
    .trim();
}

/** How a quoted message appears inside the user's message, for the models. */
export function renderReply(
  original: { id: number; role: MessageRole; agent: string; text: string },
  maxChars = 500,
): string {
  const who = original.role === 'user' || !original.agent ? 'the user' : original.agent;
  const body = stripAttachments(original.text).replace(/<\/?reply_to[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const cut = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `<reply_to id="${original.id}" name="${who}">\n${cut}\n</reply_to>`;
}

export const PROMPTS: Record<'image' | 'audio' | 'video' | 'pdf', string> = {
  image:
    'Describe this image for an assistant that cannot see it. Say what it shows, and copy any visible text exactly (keep its language). Be complete but compact. Output only the description.',
  audio:
    'Transcribe this recording word for word in the language spoken. Output only the transcript. If nothing intelligible is said, output "(no speech)".',
  video:
    'Describe this video for an assistant that cannot watch it: what happens, in order, with rough timestamps; copy any visible text exactly (keep its language); and transcribe what is said word for word in the language spoken. Be complete but compact. Output only the description.',
  pdf: 'Extract the content of this document as plain text, keeping its structure (headings, lists, tables as rows). Output only the content.',
};

/** Attachments being read right now, by id. */
const reading = new Map<string, Promise<string>>();
/** Files read at once: enough to hide latency, few enough to stay under provider limits. */
const INGEST_CONCURRENCY = 3;

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface IngestDeps {
  store: AttachmentStore;
  models: ModelService;
  usage: UsageLogger;
}

/**
 * Turns each attachment into text once, right when it arrives: images are described by
 * the agent's vision model, voice is transcribed by its transcript model, documents are
 * read. The text is stored, so the file itself never has to enter a prompt again.
 * A file that cannot be read gets a note saying so; the turn still goes ahead.
 */
export async function ingestAttachments(
  deps: IngestDeps,
  input: { ids: string[]; agent: AgentDefinition; traceId: string; signal?: AbortSignal },
): Promise<Attachment[]> {
  for (const id of input.ids) {
    if (!deps.store.get(id)) throw new Error(`Unknown attachment "${id}". Upload it again.`);
  }
  return mapLimit(input.ids, INGEST_CONCURRENCY, async (id) => {
    const attachment = deps.store.get(id)!;
    if (!attachment.text || isUnreadableText(attachment.text)) {
      // One read serves every copy of the same bytes, and a chat trigger's copy too.
      const key = attachment.hash ?? id;
      let pending = reading.get(key);
      if (!pending) {
        const known = attachment.hash ? deps.store.textOfHash(attachment.hash, id) : undefined;
        pending = (
          known && !isUnreadableText(known)
            ? Promise.resolve(known)
            : readAttachment(deps, attachment, input).catch(
                (error: Error) => `(this ${attachment.kind} could not be read: ${error.message})`,
              )
        )
          .then((text) => {
            deps.store.setText(id, text);
            return text;
          })
          .finally(() => reading.delete(key));
        reading.set(key, pending);
      }
      const text = await pending;
      if (deps.store.get(id)!.text !== text) deps.store.setText(id, text);
    }
    return deps.store.get(id)!;
  });
}

async function readAttachment(
  deps: IngestDeps,
  attachment: Attachment,
  input: { agent: AgentDefinition; traceId: string; signal?: AbortSignal },
): Promise<string> {
  const data = deps.store.read(attachment.id);
  if (!data) throw new Error('the file is missing');

  if (attachment.kind === 'file' && isTextFile(attachment)) {
    const text = data.toString('utf8');
    return text.length > TEXT_FILE_LIMIT
      ? `${text.slice(0, TEXT_FILE_LIMIT)}\n[file cut here: ${text.length - TEXT_FILE_LIMIT} more characters]`
      : text;
  }
  const isPdf = isPdfAttachment(attachment);
  if (attachment.kind === 'file' && /\.xlsx$/i.test(attachment.name)) {
    const text = xlsxText(data);
    return text.length > TEXT_FILE_LIMIT ? `${text.slice(0, TEXT_FILE_LIMIT)}\n[sheet cut here: ${text.length - TEXT_FILE_LIMIT} more characters]` : text;
  }
  if (attachment.kind === 'file' && !isPdf) {
    return `(binary file, ${attachment.mime}, ${attachment.size} bytes; its content is not readable as text)`;
  }

  const capability = attachment.kind === 'audio' ? 'transcript' : 'vision';
  const ref = deps.models.resolve(capability, input.agent.models);
  const info = deps.models.info(ref);
  const model = await deps.models.languageModel(ref);
  const startedAt = Date.now();
  const result = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPTS[isPdf ? 'pdf' : (attachment.kind as 'image' | 'audio' | 'video')] },
          { type: 'file', mediaType: isPdf ? 'application/pdf' : attachment.mime, data, filename: attachment.name },
        ],
      },
    ],
    abortSignal: input.signal,
  });
  deps.usage.logCall({
    runId: null,
    traceId: input.traceId,
    agent: input.agent.name,
    kind: capability,
    model: info,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cachedTokens: result.usage.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens ?? 0,
    durationMs: Date.now() - startedAt,
  });
  const text = result.text.trim();
  if (!text) throw new Error('the model returned nothing');
  return text;
}
