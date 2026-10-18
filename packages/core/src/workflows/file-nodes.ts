import fs from 'node:fs/promises';
import path from 'node:path';
import type { FlowItem, JsonValue } from '@mimi/shared';
import { resolveAllowedPath } from '@mimi/pc-agent';

/** Largest file the file / extract nodes read as text or data. */
export const MAX_READ_BYTES = 10 * 1024 * 1024;
/** Largest file sent to a model (PDF, image, audio). */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Picks the delimiter that splits the first line into the most columns. */
function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let most = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    const count = firstLine.split(candidate).length;
    if (count > most) {
      most = count;
      best = candidate;
    }
  }
  return best;
}

/** RFC 4180 rows: quoted fields may hold the delimiter, quotes ("") and line breaks. */
export function parseCsvRows(text: string, delimiter = sniffDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  for (let at = 0; at < body.length; at++) {
    const char = body[at]!;
    if (quoted) {
      if (char === '"') {
        if (body[at + 1] === '"') {
          field += '"';
          at++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[at + 1] === '\n') at++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

/** CSV with a header row becomes one item per row; without, columns are col1, col2, … */
export function parseCsv(text: string, header = true, delimiter?: string): FlowItem[] {
  const rows = parseCsvRows(text, delimiter || undefined);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const names = header
    ? rows[0]!.map((name, index) => name.trim() || `col${index + 1}`)
    : Array.from({ length: width }, (_, index) => `col${index + 1}`);
  return (header ? rows.slice(1) : rows).map((row) => {
    const json: Record<string, JsonValue> = {};
    names.forEach((name, index) => {
      json[name] = row[index] ?? '';
    });
    return { json };
  });
}

const csvCell = (value: JsonValue | undefined): string => {
  const text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Items as CSV; the header is every field any item has, in first-seen order. */
export function toCsv(items: FlowItem[]): string {
  const names: string[] = [];
  for (const item of items) for (const key of Object.keys(item.json)) if (!names.includes(key)) names.push(key);
  const lines = [names.map(csvCell).join(','), ...items.map((item) => names.map((name) => csvCell(item.json[name])).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/** A path inside the allowed folders (relative paths start at the first one). */
export function allowedPath(requested: string, allowedDirs: string[]): string {
  if (!requested.trim()) throw new Error('no file path given');
  if (allowedDirs.length === 0) throw new Error('no folders are allowed for files; set them in Settings');
  return resolveAllowedPath(requested.trim(), allowedDirs);
}

export async function readLimited(file: string, limit: number): Promise<Buffer> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`"${file}" is not a file`);
  if (stat.size > limit) throw new Error(`"${path.basename(file)}" is ${(stat.size / 1048576).toFixed(1)} MB; the limit is ${limit / 1048576} MB`);
  return fs.readFile(file);
}

/** Simple wildcard match for file names: `*` any run, `?` one character. */
export function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

export type FileKind = 'csv' | 'json' | 'text' | 'html' | 'pdf' | 'image' | 'audio' | 'xlsx' | 'xls';

/** What a file is, from its extension. */
export function kindOfFile(name: string): { kind: FileKind; mime: string } {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext === 'csv' || ext === 'tsv') return { kind: 'csv', mime: 'text/csv' };
  if (ext === 'json' || ext === 'jsonl') return { kind: 'json', mime: 'application/json' };
  if (ext === 'html' || ext === 'htm') return { kind: 'html', mime: 'text/html' };
  if (ext === 'xlsx') return { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (ext === 'xls') return { kind: 'xls', mime: 'application/vnd.ms-excel' };
  const mime = MIME[ext];
  if (mime === 'application/pdf') return { kind: 'pdf', mime };
  if (mime?.startsWith('image/')) return { kind: 'image', mime };
  if (mime?.startsWith('audio/')) return { kind: 'audio', mime };
  return { kind: 'text', mime: 'text/plain' };
}

/** Readable text of an HTML page: no scripts, styles or tags; entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** JSON or JSON Lines as items. */
export function parseJsonFile(text: string, normalize: (value: unknown) => FlowItem[]): FlowItem[] {
  const body = text.replace(/^﻿/, '').trim();
  try {
    return normalize(JSON.parse(body));
  } catch {
    const lines = body.split(/\r?\n/).filter((line) => line.trim());
    try {
      return lines.flatMap((line) => normalize(JSON.parse(line)));
    } catch {
      throw new Error('the file is not valid JSON or JSON Lines');
    }
  }
}

/** Plain text of any supported document; PDFs, images and audio go through `readMedia` (a model). */
export async function documentText(
  file: string,
  readMedia: ((data: Buffer, mime: string, name: string) => Promise<string>) | undefined,
): Promise<string> {
  const { kind, mime } = kindOfFile(file);
  const name = path.basename(file);
  if (kind === 'xls') throw new Error(`"${name}" is an old .xls file; save it as .xlsx (or CSV) first`);
  if (kind === 'pdf' || kind === 'image' || kind === 'audio') {
    if (!readMedia) throw new Error('reading PDFs, images and audio needs a vision / transcript model');
    return readMedia(await readLimited(file, MAX_MEDIA_BYTES), mime, name);
  }
  const data = await readLimited(file, MAX_READ_BYTES);
  if (kind === 'xlsx') return (await import('./xlsx.ts')).xlsxText(data);
  if (kind === 'html') return htmlToText(data.toString('utf8'));
  return data.toString('utf8');
}
