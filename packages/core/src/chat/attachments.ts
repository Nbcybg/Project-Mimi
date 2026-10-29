import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MessageRole } from '@mimi/shared';
import { generateText } from 'ai';
import type { AgentDefinition } from '../agents/loader.ts';
import type { Db } from '../db/db.ts';
import { providerOptionsFor } from '../providers/registry.ts';
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
  /** The user's own note about this file, kept apart from what the models read of it. */
  caption: string;
  /** Set when the bytes were removed (media retention); the row stays for the chat log. */
  deletedAt: string | null;
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
  caption: string | null;
  deleted_at: string | null;
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
  caption: row.caption ?? '',
  deletedAt: row.deleted_at ?? null,
  hash: row.hash,
  createdAt: row.created_at,
});

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Media older than this is removed from the disk; its chat row and caption stay. */
export const MEDIA_RETENTION_DAYS = 7;
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

/** The media quota is full: the upload is refused until old files expire or the quota grows. */
export class AttachmentQuotaError extends Error {}

/** Files the user sent: the bytes live in a folder, everything else in the database. */
export class AttachmentStore {
  private readonly db: Db;
  private readonly dir: string;
  private readonly quotaBytes?: () => number;

  /** `quotaBytes` bounds chat media only; the user's own pictures and models have their own quota. */
  constructor(db: Db, dir: string, options: { quotaBytes?: () => number } = {}) {
    this.db = db;
    this.dir = dir;
    this.quotaBytes = options.quotaBytes;
  }

  /** Bytes and files still on disk (expired media is not counted). */
  usage(): { bytes: number; files: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM attachments WHERE deleted_at IS NULL`)
      .get() as { files: number; bytes: number };
    return { files: Number(row.files), bytes: Number(row.bytes) };
  }

  /**
   * Removes media older than `days` from the disk. The database row is kept (with
   * `deleted_at`) so the chat still shows that a file was there and the CSV can list it.
   */
  expireOlderThan(days: number = MEDIA_RETENTION_DAYS, now: Date = new Date()): { files: number; bytes: number } {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(`SELECT id, size FROM attachments WHERE deleted_at IS NULL AND created_at <= ?`)
      .all(cutoff) as Array<{ id: string; size: number }>;
    let files = 0;
    let bytes = 0;
    const mark = this.db.prepare(`UPDATE attachments SET deleted_at = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        fs.unlinkSync(path.join(this.dir, row.id));
      } catch {
        // already gone: the row is still marked so it is not retried forever
      }
      mark.run(now.toISOString(), row.id);
      files++;
      bytes += Number(row.size);
    }
    return { files, bytes };
  }

  save(file: { name: string; mime: string; data: Buffer; caption?: string }): Attachment {
    if (file.data.length === 0) throw new Error('The file is empty.');
    if (file.data.length > MAX_ATTACHMENT_BYTES) throw new Error('The file is larger than 25 MB.');
    const quota = this.quotaBytes?.() ?? 0;
    const usedBytes = quota > 0 ? this.usage().bytes : 0;
    if (quota > 0 && usedBytes + file.data.length > quota) {
      const used = Math.round((usedBytes / 1024 / 1024) * 10) / 10;
      const limit = Math.round((quota / 1024 / 1024) * 10) / 10;
      throw new AttachmentQuotaError(`Chat media storage is full (${used} MB of ${limit} MB). Older chat media is removed after ${MEDIA_RETENTION_DAYS} days, or raise the quota in Settings.`);
    }
    const id = randomUUID();
    const declared = sniffMime(file.data, file.mime);
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared.toLowerCase() : 'application/octet-stream';
    const hash = createHash('sha256').update(file.data).digest('hex');
    // Only the last path segment, without characters a file system or a header would trip over.
    const base = file.name.split(/[\\/]/).pop() ?? '';
    const name = base.replace(/[:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'file';
    const caption = (file.caption ?? '').trim().slice(0, 500);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, id), file.data);
    this.db
      .prepare(`INSERT INTO attachments (id, kind, name, mime, size, caption, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, kindOf(mime), name, mime, file.data.length, caption, hash);
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
      .prepare(`INSERT INTO attachments (id, kind, name, mime, size, text, caption, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(copy, source.kind, source.name, source.mime, source.size, source.text, source.caption, source.hash);
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
  const caption = attachment.caption
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const note = caption ? `<caption>${caption}</caption>\n` : '';
  return `<attachment id="${attachment.id}" kind="${attachment.kind}" name="${attachment.name}">\n${note}${body}\n</attachment>`;
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

/**
 * Drops the blocks of attachments the model already receives as bytes. A caption
 * the user wrote stays: it is their own words, not a second description of the file.
 */
export function stripAttachmentBlocks(text: string, ids: ReadonlySet<string>): string {
  if (ids.size === 0) return text;
  const names = [...ids].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return text
    .replace(new RegExp(`\\n*<attachment id="(?:${names})"[^>]*>[\\s\\S]*?<\\/attachment>`, 'g'), (block) => {
      const caption = /<caption>([\s\S]*?)<\/caption>/.exec(block);
      return caption ? `\n<caption>${caption[1]}</caption>` : '';
    })
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

  // A recording with no sound in it (a muted microphone, a permission that came late) is
  // not worth a model call, and a model has nothing to say about it.
  if (attachment.kind === 'audio' && wavIsSilent(data)) return SILENT_AUDIO_TEXT;

  const capability = attachment.kind === 'audio' ? 'transcript' : 'vision';
  const ref = deps.models.resolve(capability, input.agent.models);
  const info = deps.models.info(ref);
  const model = await deps.models.languageModel(ref);
  const ask = async (prompt: string) => {
    const startedAt = Date.now();
    const result = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'file', mediaType: isPdf ? 'application/pdf' : attachment.mime, data, filename: attachment.name },
          ],
        },
      ],
      providerOptions: providerOptionsFor(info),
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
    return { text: result.text.trim(), finish: result.finishReason };
  };

  const key = isPdf ? 'pdf' : (attachment.kind as 'image' | 'audio' | 'video');
  let answer = await ask(PROMPTS[key]);
  // Some models answer a long instruction with nothing at all (or spend their budget thinking):
  // one more try with the shortest possible question before giving up.
  if (!answer.text) answer = await ask(RETRY_PROMPTS[key]);
  if (!answer.text) throw new Error(`the model returned nothing (${info.ref.provider}/${info.ref.model}, finish: ${answer.finish})`);
  return answer.text;
}

/** What an audio file with no sound is read as. */
export const SILENT_AUDIO_TEXT = '(no speech)';

/**
 * True for a 16-bit PCM WAV whose samples are all (almost) zero. Any other format, or a
 * WAV that cannot be parsed, is never called silent: the model gets to hear it.
 */
export function wavIsSilent(data: Buffer): boolean {
  if (data.length < 44 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE') return false;
  let offset = 12;
  let bits = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString('latin1', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= data.length) {
      bits = data.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) return false;
      const end = Math.min(data.length, body + size);
      let peak = 0;
      for (let at = body; at + 1 < end; at += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(at)));
      return peak < 40;
    }
    offset = body + size + (size % 2);
  }
  return false;
}

const RETRY_PROMPTS: Record<'image' | 'audio' | 'video' | 'pdf', string> = {
  image: 'What is in this image? Answer in a few sentences.',
  audio: 'What is said in this recording? Write the words only, in the language spoken.',
  video: 'What happens in this video? Answer in a few sentences.',
  pdf: 'Write out the text of this document.',
};
