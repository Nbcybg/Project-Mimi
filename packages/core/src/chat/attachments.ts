import { randomUUID } from 'node:crypto';
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
  createdAt: row.created_at,
});

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TEXT_FILE_LIMIT = 60_000;
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
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mime) ? file.mime.toLowerCase() : 'application/octet-stream';
    // Only the last path segment, without characters a file system or a header would trip over.
    const base = file.name.split(/[\\/]/).pop() ?? '';
    const name = base.replace(/[:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'file';
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, id), file.data);
    this.db
      .prepare(`INSERT INTO attachments (id, kind, name, mime, size) VALUES (?, ?, ?, ?, ?)`)
      .run(id, kindOf(mime), name, mime, file.data.length);
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
      .prepare(`INSERT INTO attachments (id, kind, name, mime, size, text) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(copy, source.kind, source.name, source.mime, source.size, source.text);
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
   * The images of the given messages as they are, for a chat model that can see them.
   * Only the newest `limit` images, so a long session does not resend every photo;
   * older ones stay in the prompt as their description.
   */
  imageParts(messageIds: number[], limit: number): Map<number, MediaPart[]> {
    const parts = new Map<number, MediaPart[]>();
    const images = [...this.forMessages(messageIds).values()]
      .flat()
      .filter((attachment) => attachment.kind === 'image' && MODEL_IMAGE.test(attachment.mime))
      .sort((a, b) => a.messageId! - b.messageId! || a.createdAt.localeCompare(b.createdAt))
      .slice(-limit);
    for (const image of images) {
      const data = this.read(image.id);
      if (!data) continue;
      const list = parts.get(image.messageId!) ?? [];
      list.push({ type: 'file', data, mediaType: image.mime, filename: image.name });
      parts.set(image.messageId!, list);
    }
    return parts;
  }
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

/** How an attachment appears inside the user's message, for the models. */
export function renderAttachment(attachment: Attachment): string {
  const body = attachment.text.trim() || '(could not be read)';
  return `<attachment id="${attachment.id}" kind="${attachment.kind}" name="${attachment.name}">\n${body}\n</attachment>`;
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
  const done: Attachment[] = [];
  for (const id of input.ids) {
    const attachment = deps.store.get(id);
    if (!attachment) throw new Error(`Unknown attachment "${id}". Upload it again.`);
    if (!attachment.text) {
      // A chat trigger and the agent may read the same file at once: one model call serves both.
      let pending = reading.get(id);
      if (!pending) {
        pending = readAttachment(deps, attachment, input)
          .catch((error: Error) => `(this ${attachment.kind} could not be read: ${error.message})`)
          .then((text) => {
            deps.store.setText(id, text);
            return text;
          })
          .finally(() => reading.delete(id));
        reading.set(id, pending);
      }
      await pending;
    }
    done.push(deps.store.get(id)!);
  }
  return done;
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
  const isPdf = attachment.mime === 'application/pdf' || /\.pdf$/i.test(attachment.name);
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
