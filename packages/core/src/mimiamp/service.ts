import { chooseFormat, parseVideoId, Quality, SearchType, Ytdl } from '@distube/ytdl-core';
import fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { GoogleAuth } from '../google/auth.ts';
import { AUDIO_TYPES, listMimiampTracks, type MimiampTrack, youtubeTrackId } from './library.ts';
import { MimiampPlaylists, type MimiampPlaylist, type MimiampPlaylistExport } from './playlists.ts';

export interface YoutubeSearchResult {
  videoId: string;
  title: string;
  artist?: string;
  duration?: number;
  thumbnail?: string;
}

export interface YoutubeSearchReply {
  results: YoutubeSearchResult[];
  source: 'google' | 'youtube' | 'none';
  error?: string;
}

export interface YoutubeAudio {
  videoId: string;
  file: string;
  mime: string;
}

interface StoredYoutubeTrack extends YoutubeSearchResult {
  addedAt: string;
}

export interface MimiampStateView {
  tracks: MimiampTrack[];
  playlists: MimiampPlaylist[];
  youtube: { ready: boolean; google: boolean; error?: string };
}

export interface MimiampServiceOptions {
  /** Usually `<user>/data`; playlists and cached audio stay in `mimiamp/` under it. */
  dataDir: string;
  /** The default Google account, used first for YouTube search. */
  google?: GoogleAuth;
  /** Test seam. */
  ytdl?: Ytdl;
  env?: NodeJS.ProcessEnv;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function txt(value: unknown, max = 500): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function isoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  return seconds > 0 ? Math.round(seconds) : undefined;
}

function thumbnailFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * YouTube audio for Mimiamp: metadata (YouTube, Google API or oEmbed), a cached audio file
 * served with Range answers, and the user's playlists. The sound has no video, so the same
 * Web Audio graph (EQ, pan, spectrum) works for YouTube and local files alike.
 */
export class MimiampService {
  readonly playlists: MimiampPlaylists;
  private readonly dir: string;
  private readonly youtubeFile: string;
  private readonly cacheDir: string;
  private readonly google?: GoogleAuth;
  private readonly ytdl: Ytdl;
  /** One download per video, shared by every client asking for it. */
  private readonly preparing = new Map<string, Promise<YoutubeAudio>>();
  private lastYoutubeError = '';

  constructor(options: MimiampServiceOptions) {
    this.dir = path.join(options.dataDir, 'mimiamp');
    this.youtubeFile = path.join(this.dir, 'youtube.json');
    this.cacheDir = path.join(this.dir, 'audio');
    this.playlists = new MimiampPlaylists(path.join(this.dir, 'playlists.json'));
    this.google = options.google;
    this.ytdl = options.ytdl ?? new Ytdl();
  }

  private storedYoutube(): StoredYoutubeTrack[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.youtubeFile, 'utf8'));
    } catch {
      return [];
    }
    const list =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { tracks?: unknown }).tracks)
        ? (parsed as { tracks: unknown[] }).tracks
        : [];
    const seen = new Set<string>();
    const tracks: StoredYoutubeTrack[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      const videoId = txt(entry.videoId, 16);
      if (!videoId || !YOUTUBE_ID.test(videoId) || seen.has(videoId)) continue;
      const title = txt(entry.title);
      if (!title) continue;
      seen.add(videoId);
      const duration = Math.round(Number(entry.duration));
      tracks.push({
        videoId,
        title,
        ...(txt(entry.artist) ? { artist: txt(entry.artist) } : {}),
        ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
        thumbnail: txt(entry.thumbnail, 1000) ?? thumbnailFor(videoId),
        addedAt: txt(entry.addedAt, 40) ?? new Date().toISOString(),
      });
    }
    return tracks;
  }

  private saveYoutube(tracks: StoredYoutubeTrack[]): void {
    fs.mkdirSync(path.dirname(this.youtubeFile), { recursive: true });
    const tmp = `${this.youtubeFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tracks }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.youtubeFile);
  }

  private youtubeTrack(entry: StoredYoutubeTrack): MimiampTrack {
    return {
      id: youtubeTrackId(entry.videoId),
      source: 'youtube',
      videoId: entry.videoId,
      title: entry.title,
      ...(entry.artist ? { artist: entry.artist } : {}),
      ...(entry.duration ? { duration: entry.duration } : {}),
      thumbnail: entry.thumbnail ?? thumbnailFor(entry.videoId),
      url: `/mimiamp/youtube/${entry.videoId}.audio`,
    };
  }

  /** The folder's audio files, then the YouTube songs the user added. */
  tracks(): MimiampTrack[] {
    return [...listMimiampTracks(), ...this.storedYoutube().map((entry) => this.youtubeTrack(entry))];
  }

  state(): MimiampStateView {
    return {
      tracks: this.tracks(),
      playlists: this.playlists.list(),
      youtube: {
        ready: true,
        google: Boolean(this.google?.isConfigured),
        ...(this.lastYoutubeError ? { error: this.lastYoutubeError } : {}),
      },
    };
  }

  findTrack(query: string): MimiampTrack | undefined {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return undefined;
    const tracks = this.tracks();
    const fields = (track: MimiampTrack) =>
      [track.title, track.artist, track.album, track.file, track.videoId, track.id].filter(Boolean).map((value) => String(value).toLowerCase());
    return tracks.find((track) => fields(track).includes(wanted)) ?? tracks.find((track) => fields(track).some((value) => value.includes(wanted)));
  }

  /** YouTube's metadata, preferring the player (no API key), then Google, then oEmbed. */
  private async youtubeMeta(videoId: string): Promise<YoutubeSearchResult> {
    let lastError: Error | undefined;
    try {
      const info = await this.ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
      const details = info.videoDetails;
      return {
        videoId,
        title: details.title,
        ...(details.author?.name ? { artist: details.author.name } : {}),
        ...(details.lengthSeconds > 0 ? { duration: Math.round(details.lengthSeconds) } : {}),
        thumbnail: thumbnailFor(videoId),
      };
    } catch (error) {
      lastError = error as Error;
    }
    if (this.google?.isConfigured) {
      try {
        const reply = await this.google.request<{
          items?: Array<{
            snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string }; default?: { url?: string } } };
            contentDetails?: { duration?: string };
          }>;
        }>(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${encodeURIComponent(videoId)}`);
        const item = reply.items?.[0];
        if (item?.snippet?.title) {
          const duration = isoDuration(item.contentDetails?.duration);
          return {
            videoId,
            title: item.snippet.title,
            ...(item.snippet.channelTitle ? { artist: item.snippet.channelTitle } : {}),
            ...(duration ? { duration } : {}),
            thumbnail: item.snippet.thumbnails?.medium?.url ?? thumbnailFor(videoId),
          };
        }
      } catch (error) {
        lastError = error as Error;
      }
    }
    try {
      const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`);
      if (response.ok) {
        const data = (await response.json()) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };
        if (txt(data.title)) {
          return {
            videoId,
            title: txt(data.title)!,
            ...(txt(data.author_name) ? { artist: txt(data.author_name) } : {}),
            thumbnail: txt(data.thumbnail_url, 1000) ?? thumbnailFor(videoId),
          };
        }
      }
    } catch (error) {
      lastError = error as Error;
    }
    throw new Error(`YouTube could not read this video${lastError ? `: ${lastError.message}` : '.'}`);
  }

  /** Adds a YouTube link to the library; a link already added is refreshed, not duplicated. */
  async addYoutube(input: string): Promise<MimiampTrack> {
    const raw = String(input ?? '').trim();
    const videoId = parseVideoId(raw);
    if (!videoId || !YOUTUBE_ID.test(videoId)) throw new Error('Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…).');
    const meta = await this.youtubeMeta(videoId);
    const tracks = this.storedYoutube();
    const at = tracks.findIndex((entry) => entry.videoId === videoId);
    const entry: StoredYoutubeTrack = { ...meta, addedAt: new Date().toISOString() };
    if (at >= 0) tracks[at] = entry;
    else tracks.push(entry);
    this.saveYoutube(tracks);
    this.lastYoutubeError = '';
    return this.youtubeTrack(entry);
  }

  removeYoutube(videoId: string): boolean {
    if (!YOUTUBE_ID.test(videoId)) return false;
    const tracks = this.storedYoutube();
    const left = tracks.filter((entry) => entry.videoId !== videoId);
    if (left.length === tracks.length) return false;
    this.saveYoutube(left);
    this.removeCachedAudio(videoId);
    return true;
  }

  /** Search first with the connected Google account (when it has the YouTube scope), then YouTube itself. */
  async searchYoutube(query: string): Promise<YoutubeSearchReply> {
    const wanted = String(query ?? '').trim();
    if (!wanted) return { results: [], source: 'none' };
    let googleError = '';
    if (this.google?.isConfigured) {
      try {
        const search = await this.google.request<{
          items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } } }>;
        }>(
          `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${encodeURIComponent(wanted)}`,
        );
        const items = (search.items ?? []).filter((item) => item.id?.videoId && item.snippet?.title);
        if (items.length > 0) {
          const ids = items.map((item) => item.id!.videoId!);
          let durations = new Map<string, number>();
          try {
            const details = await this.google.request<{ items?: Array<{ id?: string; contentDetails?: { duration?: string } }> }>(
              `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(ids.join(','))}`,
            );
            durations = new Map(
              (details.items ?? [])
                .map((item) => [item.id ?? '', isoDuration(item.contentDetails?.duration)] as const)
                .filter((entry): entry is readonly [string, number] => Boolean(entry[0]) && entry[1] !== undefined),
            );
          } catch {
            // durations are a nicety; the search results still work
          }
          return {
            source: 'google',
            results: items.map((item) => ({
              videoId: item.id!.videoId!,
              title: item.snippet!.title!,
              ...(item.snippet!.channelTitle ? { artist: item.snippet!.channelTitle } : {}),
              ...(durations.get(item.id!.videoId!) ? { duration: durations.get(item.id!.videoId!)! } : {}),
              thumbnail: item.snippet!.thumbnails?.medium?.url ?? thumbnailFor(item.id!.videoId!),
            })),
          };
        }
      } catch (error) {
        googleError = (error as Error).message;
      }
    }
    try {
      const found = await this.ytdl.search(wanted, { limit: 10, type: SearchType.Video });
      const results = found.map((video) => ({
        videoId: video.id,
        title: video.title,
        ...(video.author?.name ? { artist: video.author.name } : {}),
        ...(video.lengthSeconds ? { duration: Math.round(video.lengthSeconds) } : {}),
        thumbnail: video.thumbnails.at(-1)?.url ?? thumbnailFor(video.id),
      }));
      if (results.length > 0) return { results, source: 'youtube' };
    } catch (error) {
      this.lastYoutubeError = (error as Error).message;
      return { results: [], source: 'none', error: googleError || this.lastYoutubeError };
    }
    return { results: [], source: 'none', ...(googleError ? { error: googleError } : {}) };
  }

  /** The cached file for a video, if it is already downloaded and still a safe audio file. */
  audio(videoId: string): YoutubeAudio | undefined {
    if (!YOUTUBE_ID.test(videoId)) return undefined;
    let names: string[];
    try {
      names = fs.readdirSync(this.cacheDir);
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!name.startsWith(`${videoId}.`)) continue;
      const ext = path.extname(name).toLowerCase();
      const mime = AUDIO_TYPES[ext];
      if (!mime) continue;
      const file = path.join(this.cacheDir, name);
      try {
        if (fs.statSync(file).isFile() && fs.statSync(file).size > 0) return { videoId, file, mime };
      } catch {
        // a file removed between listing and checking
      }
    }
    return undefined;
  }

  private removeCachedAudio(videoId: string): void {
    try {
      for (const name of fs.readdirSync(this.cacheDir)) {
        if (name.startsWith(`${videoId}.`)) fs.rmSync(path.join(this.cacheDir, name), { force: true });
      }
    } catch {
      // the cache can be emptied by hand; a leftover file is harmless
    }
  }

  /**
   * Downloads the audio (never the video) once and returns the file. A player asks for this
   * before it sets `src`, so the first play waits for "preparing" instead of stuttering.
   */
  async prepareYoutube(videoId: string): Promise<YoutubeAudio> {
    if (!YOUTUBE_ID.test(videoId)) throw new Error('Not a YouTube video id.');
    if (!this.storedYoutube().some((entry) => entry.videoId === videoId)) throw new Error('Add the YouTube link first.');
    const ready = this.audio(videoId);
    if (ready) return ready;
    const pending = this.preparing.get(videoId);
    if (pending) return pending;
    const job = this.downloadYoutube(videoId).finally(() => this.preparing.delete(videoId));
    this.preparing.set(videoId, job);
    return job;
  }

  private async downloadYoutube(videoId: string): Promise<YoutubeAudio> {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const info = await this.ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    const format = chooseFormat(info.formats, { quality: Quality.HighestAudio, filter: { hasAudio: true, hasVideo: false } });
    const ext = /webm/i.test(format.mimeType ?? '') ? '.webm' : '.m4a';
    const target = path.join(this.cacheDir, `${videoId}${ext}`);
    const tmp = path.join(this.cacheDir, `${videoId}.${process.pid}.part`);
    try {
      await pipeline(this.ytdl.download(info, { format }), createWriteStream(tmp));
      const stat = fs.statSync(tmp);
      if (stat.size === 0) throw new Error('YouTube returned an empty audio file.');
      fs.renameSync(tmp, target);
      const tracks = this.storedYoutube();
      const at = tracks.findIndex((entry) => entry.videoId === videoId);
      if (at >= 0 && info.videoDetails.lengthSeconds > 0) {
        tracks[at] = { ...tracks[at]!, duration: Math.round(info.videoDetails.lengthSeconds) };
        this.saveYoutube(tracks);
      }
      return { videoId, file: target, mime: AUDIO_TYPES[ext] ?? 'audio/mp4' };
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
      this.lastYoutubeError = (error as Error).message;
      throw new Error(`Downloading YouTube audio failed: ${(error as Error).message}`);
    }
  }

  exportPlaylist(idOrName: string): MimiampPlaylistExport {
    return this.playlists.export(idOrName);
  }
}
