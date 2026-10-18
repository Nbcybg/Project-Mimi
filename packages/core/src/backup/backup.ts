import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { Db } from '../db/db.ts';

/**
 * Backups of the whole user folder as one .tar.gz (readable by Windows' built-in tar,
 * 7-Zip, any Linux), written without a library. The database is snapshotted with
 * SQLite's backup API, so a backup taken while the app runs is consistent.
 */

/** Machine-local files that hold credentials; left out when `includeSecrets` is false. */
const SECRET_FILES = new Set(['auth.json', 'secrets.json', 'push-vapid.json', 'profile-local.json', 'google-token.json', 'microsoft-token.json']);
/** Never backed up: the app window's browser profile, caches, logs, the live database files. */
const SKIP = [/^data\/app-window(\/|$)/, /^data\/models-dev\.json$/, /\.log$/, /^data\/mimi\.db(-wal|-shm)?$/, /^backups(\/|$)/, /^\.restore/];

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

function* walk(root: string, relative = ''): Generator<string> {
  const dir = path.join(root, relative);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, rel);
    else if (entry.isFile()) yield rel;
  }
}

/** One ustar header block; long names use the prefix field (up to 255 characters). */
function tarHeader(name: string, size: number, mtime: Date): Buffer {
  const header = Buffer.alloc(512);
  let file = name;
  let prefix = '';
  if (Buffer.byteLength(file) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, cut);
    file = name.slice(cut + 1);
    if (Buffer.byteLength(file) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for the backup: ${name}`);
  }
  const put = (text: string, offset: number, length: number) => header.write(text, offset, length, 'utf8');
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0');
  put(file, 0, 100);
  put(`${octal(0o644, 8)}\0`, 100, 8);
  put(`${octal(0, 8)}\0`, 108, 8);
  put(`${octal(0, 8)}\0`, 116, 8);
  put(`${octal(size, 12)}\0`, 124, 12);
  put(`${octal(Math.floor(mtime.getTime() / 1000), 12)}\0`, 136, 12);
  header.fill(' ', 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

async function* tarStream(entries: Array<{ name: string; file: string }>): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    const stat = fs.statSync(entry.file);
    yield tarHeader(entry.name, stat.size, stat.mtime);
    const data = fs.readFileSync(entry.file);
    yield data;
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Writes `mimi-backup-<time>.tar.gz` into `outDir`. */
export async function createBackup(options: { userDir: string; db: Db; outDir: string; includeSecrets: boolean; now?: Date }): Promise<BackupInfo> {
  const now = options.now ?? new Date();
  fs.mkdirSync(options.outDir, { recursive: true });
  const snapshot = path.join(options.outDir, `.mimi-db-${process.pid}-${Date.now()}.tmp`);
  await options.db.backup(snapshot);
  try {
    const entries: Array<{ name: string; file: string }> = [];
    for (const rel of walk(options.userDir)) {
      if (SKIP.some((pattern) => pattern.test(rel))) continue;
      if (!options.includeSecrets && SECRET_FILES.has(path.basename(rel))) continue;
      entries.push({ name: `user/${rel}`, file: path.join(options.userDir, rel) });
    }
    entries.push({ name: 'user/data/mimi.db', file: snapshot });
    const name = `mimi-backup-${stamp(now)}${options.includeSecrets ? '' : '-nosecrets'}.tar.gz`;
    const target = path.join(options.outDir, name);
    await pipeline(Readable.from(tarStream(entries)), zlib.createGzip({ level: 6 }), fs.createWriteStream(target, { mode: 0o600 }));
    return { name, bytes: fs.statSync(target).size, createdAt: now.toISOString() };
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

export function listBackups(outDir: string): BackupInfo[] {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((name) => /^mimi-backup-.*\.tar\.gz$/.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(outDir, name));
      return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keeps the newest `keep` automatic backups. */
export function pruneBackups(outDir: string, keep: number): void {
  for (const backup of listBackups(outDir).slice(keep)) fs.rmSync(path.join(outDir, backup.name), { force: true });
}

/** Reads a backup's files (tar inside gzip); names are checked so nothing lands outside `user/`. */
export function readBackup(file: string): Array<{ name: string; data: Buffer }> {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  const files: Array<{ name: string; data: Buffer }> = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
    const prefix = text(345, 155);
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    at += 512;
    if (type === '0') files.push({ name, data: Buffer.from(tar.subarray(at, at + size)) });
    at += Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Puts a backup back into `userDir` (run with the app closed). The current files are
 * backed up first by the caller; files not in the backup are left as they are.
 */
export function restoreBackup(file: string, userDir: string): number {
  const files = readBackup(file);
  if (!files.some((entry) => entry.name === 'user/data/mimi.db')) throw new Error('This is not a Mimi backup (no user/data/mimi.db inside).');
  const root = path.resolve(userDir);
  let written = 0;
  for (const entry of files) {
    if (!entry.name.startsWith('user/')) continue;
    const target = path.resolve(root, entry.name.slice(5));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`unsafe path in backup: ${entry.name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    written++;
  }
  // The restored database replaces the live one; stale WAL files would undo it.
  for (const extra of ['mimi.db-wal', 'mimi.db-shm']) fs.rmSync(path.join(root, 'data', extra), { force: true });
  return written;
}
