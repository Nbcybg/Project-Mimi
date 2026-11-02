import fs from 'node:fs';
import path from 'node:path';

/**
 * Mimiamp's music: files a developer drops into `server/web/mimiamp/` (shipped with the
 * app) or into the folder `MIMI_MUSIC_DIR` points at. An optional `tracks.json` gives
 * titles and artists; any audio file missing from it still appears, titled by its name.
 */

/** The types a browser can play without help. */
export const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

/** Where a track comes from: a file in the music folder, or YouTube (audio only). */
export type MimiampTrackSource = 'file' | 'youtube';

export interface MimiampTrack {
  /** Stable id: `file:<name>` or `youtube:<video id>`. */
  id: string;
  source: MimiampTrackSource;
  /** A file name inside the music folder (no folders, no `..`). */
  file?: string;
  /** The YouTube video id, for a YouTube track. */
  videoId?: string;
  title: string;
  artist?: string;
  album?: string;
  /** Seconds, when `tracks.json` or YouTube says it. */
  duration?: number;
  /** Where the browser fetches it; a YouTube URL only answers after `prepareYoutube`. */
  url: string;
  /** Cover art for a YouTube track. */
  thumbnail?: string;
}

interface ManifestEntry {
  file?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  duration?: unknown;
}

/** The id a local file track is known by. */
export function fileTrackId(file: string): string {
  return `file:${file}`;
}

/** The id a YouTube track is known by. */
export function youtubeTrackId(videoId: string): string {
  return `youtube:${videoId}`;
}

/** True when a folder has at least one file the player can serve. */
function hasAudio(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && isAudioFile(entry.name));
  } catch {
    return false;
  }
}

/**
 * Where the songs live, in order: `MIMI_MUSIC_DIR`, `<user>/mimiamp` (the user's own music,
 * on the synchronized folder or the server volume), `<app>/mimiamp` (a folder at the project
 * root), then the built-in demo folder. A folder only wins when it actually has an audio
 * file, so an empty folder never hides the next one.
 */
export function mimiampDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.MIMI_MUSIC_DIR?.trim();
  if (custom) return path.resolve(custom);
  const repoRoot = path.resolve(import.meta.dirname, '../../../..');
  const root = env.MIMI_ROOT ? path.resolve(env.MIMI_ROOT) : repoRoot;
  const user = env.MIMI_USER?.trim();
  const candidates = [
    ...(user ? [path.resolve(root, user, 'mimiamp')] : []),
    path.join(root, 'mimiamp'),
  ];
  for (const dir of candidates) if (hasAudio(dir)) return dir;
  return path.join(import.meta.dirname, '..', 'server', 'web', 'mimiamp');
}

/** True for a plain audio file name that may be served (never a path). */
export function isAudioFile(name: string): boolean {
  return (
    name.length > 0 &&
    name === path.basename(name) &&
    !name.startsWith('.') &&
    Object.hasOwn(AUDIO_TYPES, path.extname(name).toLowerCase())
  );
}

/** The path of a track for serving, or null when the name is not a safe audio file. */
export function trackPath(name: string, dir = mimiampDir()): string | null {
  return isAudioFile(name) ? path.join(dir, name) : null;
}

/** A title out of a file name: drop the extension, underscores and a leading track number. */
export function titleFromFile(file: string): string {
  const base = file.slice(0, file.length - path.extname(file).length);
  const cleaned = base.replace(/[_-]+/g, ' ').replace(/^\s*\d{1,3}[.)\s-]+/, '').trim();
  return cleaned || base;
}

function manifestEntries(dir: string): ManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, 'tracks.json'), 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { tracks?: unknown }).tracks)
      ? ((parsed as { tracks: unknown[] }).tracks)
      : [];
  return list.filter((entry): entry is ManifestEntry => Boolean(entry) && typeof entry === 'object');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Every playable file track: manifest entries in their order, then files nobody listed. */
export function listMimiampTracks(dir = mimiampDir()): MimiampTrack[] {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isAudioFile(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const present = new Set(files);
  const seen = new Set<string>();
  const tracks: MimiampTrack[] = [];
  for (const entry of manifestEntries(dir)) {
    const file = text(entry.file);
    if (!file || !present.has(file) || seen.has(file)) continue;
    seen.add(file);
    const duration = Number(entry.duration);
    tracks.push({
      id: fileTrackId(file),
      source: 'file',
      file,
      title: text(entry.title) ?? titleFromFile(file),
      ...(text(entry.artist) ? { artist: text(entry.artist) } : {}),
      ...(text(entry.album) ? { album: text(entry.album) } : {}),
      ...(Number.isFinite(duration) && duration > 0 ? { duration: Math.round(duration) } : {}),
      url: `/mimiamp/${encodeURIComponent(file)}`,
    });
  }
  for (const file of files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
    if (seen.has(file)) continue;
    seen.add(file);
    tracks.push({
      id: fileTrackId(file),
      source: 'file',
      file,
      title: titleFromFile(file),
      url: `/mimiamp/${encodeURIComponent(file)}`,
    });
  }
  return tracks;
}
