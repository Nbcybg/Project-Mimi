/**
 * Mimiamp's music as the HTTP API sends it (`/api/mimiamp/*`, `/mimiamp/tracks.json`), and
 * the small views the Android widget and background poll read. Kept here so every client
 * builds its models from the same definitions.
 */

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

/** One song in a playlist. The title and artist are kept so an exported list still makes sense elsewhere. */
export interface MimiampPlaylistItem {
  id: string;
  /** The library track it points at, when it came from the library. */
  trackId?: string;
  source: MimiampTrackSource | 'local';
  file?: string;
  videoId?: string;
  /** A file on the listener's own device (never uploaded to the server). */
  localId?: string;
  title: string;
  artist?: string;
  album?: string;
  /** Seconds. */
  duration?: number;
  thumbnail?: string;
  addedAt: string;
}

export interface MimiampPlaylist {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: MimiampPlaylistItem[];
}

export interface MimiampPlaylistExport {
  format: 'mimiamp-playlist';
  version: 1;
  exportedAt: string;
  playlist: Omit<MimiampPlaylist, 'id'>;
}

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

export interface MimiampStateView {
  tracks: MimiampTrack[];
  playlists: MimiampPlaylist[];
  youtube: { ready: boolean; google: boolean; error?: string };
}

/** One row of `GET /api/widget`. */
export interface WidgetChatView {
  id: number;
  title: string;
  agent: string;
  /** Path of the agent's avatar with its version (`?v=`), or null. */
  avatar: string | null;
  preview: string;
  lastMessageAt: string | null;
  /** Replies in the newest session the user has not opened yet. */
  unread: number;
}

export interface WidgetView {
  chats: WidgetChatView[];
  busyChat: number | null;
}

/** One item of `GET /api/notifications`. */
export interface NotificationSyncItem {
  id: number;
  kind: 'reminder' | 'task-result' | 'info' | 'approval' | 'message';
  title: string;
  body: string;
  chatId: number | null;
  createdAt: string;
  /** Only with `?afterId=`: whether it was read (on any device). */
  read?: boolean;
}
