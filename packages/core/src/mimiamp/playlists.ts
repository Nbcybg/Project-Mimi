import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MimiampPlaylist, MimiampPlaylistExport, MimiampPlaylistItem, MimiampTrack, MimiampTrackSource } from '@mimi/shared';

export type { MimiampPlaylist, MimiampPlaylistExport, MimiampPlaylistItem } from '@mimi/shared';

const MAX_NAME = 80;
const MAX_TITLE = 300;
const MAX_ITEMS = 500;
const SOURCES = new Set<MimiampTrackSource | 'local'>(['file', 'youtube', 'local']);

function cleanText(value: unknown, max = MAX_TITLE): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** A name safe to show in a list and to use in an export file name. */
export function cleanPlaylistName(value: unknown): string {
  return (cleanText(value, MAX_NAME) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'Playlist';
}

function cleanItem(raw: unknown, now: string): MimiampPlaylistItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const source = String(entry.source ?? 'file') as MimiampPlaylistItem['source'];
  if (!SOURCES.has(source)) return null;
  const title = cleanText(entry.title);
  if (!title) return null;
  const file = cleanText(entry.file, 300);
  const videoId = cleanText(entry.videoId, 32);
  const localId = cleanText(entry.localId, 120);
  const duration = Math.round(Number(entry.duration));
  return {
    id: cleanText(entry.id, 80) ?? randomUUID(),
    ...(cleanText(entry.trackId, 320) ? { trackId: cleanText(entry.trackId, 320)! } : {}),
    source,
    ...(file ? { file } : {}),
    ...(videoId ? { videoId } : {}),
    ...(localId ? { localId } : {}),
    title,
    ...(cleanText(entry.artist) ? { artist: cleanText(entry.artist) } : {}),
    ...(cleanText(entry.album) ? { album: cleanText(entry.album) } : {}),
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    ...(cleanText(entry.thumbnail, 1000) ? { thumbnail: cleanText(entry.thumbnail, 1000)! } : {}),
    addedAt: cleanText(entry.addedAt, 40) ?? now,
  };
}

function sameTrack(item: MimiampPlaylistItem, track: MimiampTrack): boolean {
  return (
    (track.id && item.trackId === track.id) ||
    (track.source === 'file' && Boolean(track.file) && item.source === 'file' && item.file === track.file) ||
    (track.source === 'youtube' && Boolean(track.videoId) && item.source === 'youtube' && item.videoId === track.videoId)
  );
}

/** A playlist item that points at a library track. */
export function itemFromTrack(track: MimiampTrack, now = new Date().toISOString()): MimiampPlaylistItem {
  return {
    id: randomUUID(),
    trackId: track.id,
    source: track.source,
    ...(track.file ? { file: track.file } : {}),
    ...(track.videoId ? { videoId: track.videoId } : {}),
    title: track.title,
    ...(track.artist ? { artist: track.artist } : {}),
    ...(track.album ? { album: track.album } : {}),
    ...(track.duration ? { duration: track.duration } : {}),
    ...(track.thumbnail ? { thumbnail: track.thumbnail } : {}),
    addedAt: now,
  };
}

/**
 * The user's playlists, kept in `data/mimiamp/playlists.json`. The file is small and may be
 * edited or exported by hand; every write is atomic, and a damaged file becomes an empty list
 * rather than stopping the player.
 */
export class MimiampPlaylists {
  private readonly file: string;
  private loaded: MimiampPlaylist[] | null = null;

  constructor(file: string) {
    this.file = file;
  }

  private read(): MimiampPlaylist[] {
    if (this.loaded) return this.loaded;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.loaded = [];
      return this.loaded;
    }
    const list =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { playlists?: unknown }).playlists)
        ? (parsed as { playlists: unknown[] }).playlists
        : [];
    const now = new Date().toISOString();
    const playlists: MimiampPlaylist[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const name = cleanPlaylistName(entry.name);
      const items = Array.isArray(entry.items)
        ? entry.items.map((item) => cleanItem(item, now)).filter((item): item is MimiampPlaylistItem => item !== null).slice(0, MAX_ITEMS)
        : [];
      playlists.push({
        id: cleanText(entry.id, 80) ?? randomUUID(),
        name,
        createdAt: cleanText(entry.createdAt, 40) ?? now,
        updatedAt: cleanText(entry.updatedAt, 40) ?? now,
        items,
      });
    }
    this.loaded = playlists;
    return playlists;
  }

  private write(playlists: MimiampPlaylist[]): void {
    this.loaded = playlists;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, playlists }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list(): MimiampPlaylist[] {
    return this.read().map((playlist) => ({ ...playlist, items: playlist.items.map((item) => ({ ...item })) }));
  }

  get(idOrName: string): MimiampPlaylist | undefined {
    const wanted = idOrName.trim().toLowerCase();
    if (!wanted) return undefined;
    return this.read().find((playlist) => playlist.id === idOrName || playlist.name.toLowerCase() === wanted);
  }

  create(name: unknown): MimiampPlaylist {
    const playlists = this.read();
    let finalName = cleanPlaylistName(name);
    const taken = new Set(playlists.map((playlist) => playlist.name.toLowerCase()));
    if (taken.has(finalName.toLowerCase())) {
      const base = finalName;
      for (let counter = 2; taken.has(finalName.toLowerCase()); counter++) finalName = `${base} ${counter}`;
    }
    const now = new Date().toISOString();
    const playlist: MimiampPlaylist = { id: randomUUID(), name: finalName, createdAt: now, updatedAt: now, items: [] };
    playlists.push(playlist);
    this.write(playlists);
    return { ...playlist, items: [] };
  }

  rename(idOrName: string, name: unknown): MimiampPlaylist {
    const playlists = this.read();
    const playlist = playlists.find((entry) => entry.id === idOrName || entry.name.toLowerCase() === idOrName.trim().toLowerCase());
    if (!playlist) throw new Error(`No playlist "${idOrName}".`);
    const next = cleanPlaylistName(name);
    const taken = playlists.some((entry) => entry !== playlist && entry.name.toLowerCase() === next.toLowerCase());
    if (taken) throw new Error(`A playlist named "${next}" already exists.`);
    playlist.name = next;
    playlist.updatedAt = new Date().toISOString();
    this.write(playlists);
    return { ...playlist, items: playlist.items.map((item) => ({ ...item })) };
  }

  remove(idOrName: string): boolean {
    const playlists = this.read();
    const at = playlists.findIndex((entry) => entry.id === idOrName || entry.name.toLowerCase() === idOrName.trim().toLowerCase());
    if (at < 0) return false;
    playlists.splice(at, 1);
    this.write(playlists);
    return true;
  }

  /** Adds a library track; the same track twice in one list is kept once. */
  addTrack(idOrName: string, track: MimiampTrack): MimiampPlaylist {
    const playlist = this.get(idOrName);
    if (!playlist) throw new Error(`No playlist "${idOrName}".`);
    if (playlist.items.length >= MAX_ITEMS) throw new Error(`"${playlist.name}" already has ${MAX_ITEMS} songs.`);
    if (playlist.items.some((item) => sameTrack(item, track))) return playlist;
    const items = [...playlist.items, itemFromTrack(track)];
    return this.saveItems(playlist, items);
  }

  /** Adds an arbitrary item (for example a file on this device). */
  addItem(idOrName: string, raw: unknown): MimiampPlaylist {
    const playlist = this.get(idOrName);
    if (!playlist) throw new Error(`No playlist "${idOrName}".`);
    if (playlist.items.length >= MAX_ITEMS) throw new Error(`"${playlist.name}" already has ${MAX_ITEMS} songs.`);
    const item = cleanItem(raw, new Date().toISOString());
    if (!item) throw new Error('A playlist item needs a title and a source (file, youtube or local).');
    const duplicate = playlist.items.some(
      (entry) =>
        (item.localId && entry.localId === item.localId) ||
        (item.videoId && entry.source === item.source && entry.videoId === item.videoId) ||
        (item.file && entry.source === item.source && entry.file === item.file && entry.title === item.title),
    );
    if (duplicate) return playlist;
    return this.saveItems(playlist, [...playlist.items, item]);
  }

  /** Removes by item id, or by a title/file/video id that matches one item. */
  removeItem(idOrName: string, itemIdOrQuery: string): { playlist: MimiampPlaylist; removed?: MimiampPlaylistItem } {
    const playlist = this.get(idOrName);
    if (!playlist) throw new Error(`No playlist "${idOrName}".`);
    const wanted = itemIdOrQuery.trim();
    const wantedLower = wanted.toLowerCase();
    let at = playlist.items.findIndex((item) => item.id === wanted);
    if (at < 0) {
      at = playlist.items.findIndex((item) =>
        [item.title, item.file, item.videoId].filter(Boolean).some((value) => String(value).toLowerCase().includes(wantedLower)),
      );
    }
    if (at < 0) return { playlist };
    const removed = playlist.items[at]!;
    return { playlist: this.saveItems(playlist, playlist.items.filter((_item, index) => index !== at)), removed };
  }

  private saveItems(playlist: MimiampPlaylist, items: MimiampPlaylistItem[]): MimiampPlaylist {
    const playlists = this.read();
    const stored = playlists.find((entry) => entry.id === playlist.id);
    if (!stored) throw new Error(`No playlist "${playlist.name}".`);
    stored.items = items;
    stored.updatedAt = new Date().toISOString();
    this.write(playlists);
    return { ...stored, items: stored.items.map((item) => ({ ...item })) };
  }

  export(idOrName: string): MimiampPlaylistExport {
    const playlist = this.get(idOrName);
    if (!playlist) throw new Error(`No playlist "${idOrName}".`);
    const { id: _id, ...rest } = playlist;
    return { format: 'mimiamp-playlist', version: 1, exportedAt: new Date().toISOString(), playlist: rest };
  }

  /**
   * Imports one exported playlist (or a plain `{ name, items }` object). A name already in use
   * gets a number, so importing never overwrites the user's list.
   */
  import(raw: unknown): MimiampPlaylist {
    const envelope = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const source =
      envelope.playlist && typeof envelope.playlist === 'object'
        ? (envelope.playlist as Record<string, unknown>)
        : envelope;
    const items = Array.isArray(source.items)
      ? source.items.map((item) => cleanItem(item, new Date().toISOString())).filter((item): item is MimiampPlaylistItem => item !== null)
      : [];
    if (items.length > MAX_ITEMS) throw new Error(`A playlist may have at most ${MAX_ITEMS} songs.`);
    const playlist = this.create(source.name);
    return this.saveItems(playlist, items.slice(0, MAX_ITEMS));
  }
}
