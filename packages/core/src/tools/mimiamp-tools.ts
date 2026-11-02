import type { MimiampCommand } from '@mimi/shared';
import { z } from 'zod';
import { listMimiampTracks, type MimiampTrack } from '../mimiamp/library.ts';
import type { MimiampPlaylist, MimiampPlaylists } from '../mimiamp/playlists.ts';
import { defineTool, type ToolDefinition } from './registry.ts';

/** Sends a command to the Mimiamp player of every open app; returns how many clients got it. */
export type MimiampControl = (command: MimiampCommand) => number;
export type MimiampLibrary = () => MimiampTrack[];
export interface MimiampYoutubeAdder {
  add(url: string): Promise<MimiampTrack>;
}

const mimiampActions = [
  'list',
  'open',
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'volume',
  'seek',
  'playlists',
  'playlist-create',
  'playlist-delete',
  'playlist-add',
  'playlist-remove',
  'playlist-play',
  'youtube-add',
] as const;

/** A track by title, artist, album, file name or id (exact first, then a part of the text). */
function findTrack(tracks: MimiampTrack[], query: string): MimiampTrack | undefined {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return undefined;
  const fields = (track: MimiampTrack) =>
    [track.title, track.artist, track.album, track.file, track.videoId, track.id].filter(Boolean).map((value) => value!.toLowerCase());
  return (
    tracks.find((track) => fields(track).includes(wanted)) ??
    tracks.find((track) => fields(track).some((value) => value.includes(wanted)))
  );
}

const describeTrack = (track: MimiampTrack, index: number) => {
  const where = track.source === 'youtube' ? ' · YouTube' : '';
  return `${index + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''}${where} (${track.file ?? track.videoId ?? track.id})`;
};

const describePlaylist = (playlist: MimiampPlaylist, index?: number) =>
  `${index !== undefined ? `${index + 1}. ` : ''}${playlist.name} (${playlist.items.length} song${playlist.items.length === 1 ? '' : 's'})`;

/**
 * Lets an agent put music on for the user: open the Mimiamp screen, play a track in the
 * background, skip, pause, set the volume, and keep playlists (create, add, remove, play).
 * Songs are local files or YouTube links; a YouTube link is fetched as audio only.
 */
export function createMimiampTools(
  control: MimiampControl,
  library: MimiampLibrary = listMimiampTracks,
  playlists?: MimiampPlaylists,
  youtube?: MimiampYoutubeAdder,
): ToolDefinition<any>[] {
  const refresh = () => control({ action: 'refresh' });
  const needPlaylists = (): MimiampPlaylists => {
    if (!playlists) throw new Error('Playlists are not available in this Mimi install.');
    return playlists;
  };
  const needPlaylist = (query: string | undefined): { store: MimiampPlaylists; playlist: MimiampPlaylist } => {
    const store = needPlaylists();
    const wanted = query?.trim();
    if (!wanted) throw new Error('Give `playlist` (its name or id).');
    const playlist = store.get(wanted);
    if (!playlist) {
      const names = store.list().map((entry) => entry.name).join(', ');
      throw new Error(`No playlist matches "${wanted}".${names ? ` Playlists: ${names}` : ' There are no playlists yet.'}`);
    }
    return { store, playlist };
  };

  const mimiamp = defineTool({
    name: 'mimiamp',
    description:
      'Control Mimiamp, the music player built into the user\'s Mimi app, and its playlists. Use `list` to see songs and `playlists` to see lists. `play` takes a title, artist or id; `open` shows the floating player. `pause`, `stop`, `next`, `previous`, `volume` (0–100) and `seek` (seconds) work while it plays. Playlist actions: `playlist-create` (name), `playlist-delete` (playlist), `playlist-add` (playlist + query), `playlist-remove` (playlist + query or item id), `playlist-play` (playlist). `youtube-add` takes a `url` and adds a YouTube song as audio only (no video). The sound comes out of the open Mimi app, so playback needs an app; playlist edits are saved even when none is open.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      action: z.enum(mimiampActions).describe('What to do; `list` shows songs, `playlists` shows lists'),
      query: z.string().max(300).optional().describe('Song title, artist, file name or item id (play / playlist-add / playlist-remove)'),
      playlist: z.string().max(120).optional().describe('Playlist name or id, or the playlist to play'),
      name: z.string().max(80).optional().describe('Name for `playlist-create`'),
      url: z.string().max(500).optional().describe('YouTube link for `youtube-add`'),
      level: z.number().int().min(0).max(100).optional().describe('Volume percent (for `volume`)'),
      seconds: z.number().int().min(0).optional().describe('Position in the track (for `seek`)'),
    }),
    summarize: (input) => {
      switch (input.action) {
        case 'list':
          return 'List the Mimiamp songs';
        case 'playlists':
          return 'List the Mimiamp playlists';
        case 'play':
          return `Play ${input.query ? `"${input.query}"` : 'music'} on Mimiamp`;
        case 'playlist-create':
          return `Create the Mimiamp playlist "${input.name ?? input.query ?? '?'}"`;
        case 'playlist-delete':
          return `Delete the Mimiamp playlist "${input.playlist ?? '?'}"`;
        case 'playlist-add':
          return `Add "${input.query ?? '?'}" to the Mimiamp playlist "${input.playlist ?? '?'}"`;
        case 'playlist-remove':
          return `Remove "${input.query ?? '?'}" from the Mimiamp playlist "${input.playlist ?? '?'}"`;
        case 'playlist-play':
          return `Play the Mimiamp playlist "${input.playlist ?? '?'}"`;
        case 'youtube-add':
          return `Add a YouTube song to Mimiamp: ${input.url ?? '?'}`;
        case 'volume':
          return `Set Mimiamp volume to ${input.level ?? '?'}%`;
        case 'seek':
          return `Seek Mimiamp to ${input.seconds ?? '?'}s`;
        default:
          return `${input.action[0]!.toUpperCase()}${input.action.slice(1)} Mimiamp`;
      }
    },
    async execute(input) {
      if (input.action === 'list') {
        const tracks = library();
        return tracks.length === 0
          ? 'Mimiamp has no songs yet. Put audio files in <user>/mimiamp, add a YouTube link, or point MIMI_MUSIC_DIR at a folder.'
          : `Mimiamp has ${tracks.length} track${tracks.length === 1 ? '' : 's'}:\n${tracks.map(describeTrack).join('\n')}`;
      }
      if (input.action === 'playlists') {
        const store = needPlaylists();
        const lists = store.list();
        return lists.length === 0
          ? 'Mimiamp has no playlists yet. Create one with `playlist-create`.'
          : `Mimiamp has ${lists.length} playlist${lists.length === 1 ? '' : 's'}:\n${lists.map((playlist, index) => describePlaylist(playlist, index)).join('\n')}`;
      }
      if (input.action === 'playlist-create') {
        const store = needPlaylists();
        const created = store.create(input.name ?? input.query);
        refresh();
        return `Created the Mimiamp playlist "${created.name}". Add songs with \`playlist-add\`.`;
      }
      if (input.action === 'playlist-delete') {
        const { store, playlist } = needPlaylist(input.playlist);
        store.remove(playlist.id);
        refresh();
        return `Deleted the Mimiamp playlist "${playlist.name}".`;
      }
      if (input.action === 'playlist-add') {
        const { store, playlist } = needPlaylist(input.playlist);
        const wanted = input.query?.trim();
        if (!wanted) throw new Error('Give `query` (the song to add).');
        const track = findTrack(library(), wanted);
        if (!track) throw new Error(`No Mimiamp track matches "${wanted}".`);
        const updated = store.addTrack(playlist.id, track);
        refresh();
        return `Added "${track.title}" to the Mimiamp playlist "${updated.name}" (${updated.items.length} songs).`;
      }
      if (input.action === 'playlist-remove') {
        const { store, playlist } = needPlaylist(input.playlist);
        const wanted = input.query?.trim();
        if (!wanted) throw new Error('Give `query` (the song or item id to remove).');
        const result = store.removeItem(playlist.id, wanted);
        if (!result.removed) throw new Error(`"${wanted}" is not in the Mimiamp playlist "${playlist.name}".`);
        refresh();
        return `Removed "${result.removed.title}" from the Mimiamp playlist "${result.playlist.name}" (${result.playlist.items.length} songs).`;
      }
      if (input.action === 'playlist-play') {
        const { playlist } = needPlaylist(input.playlist);
        const clients = control({ action: 'playlist-play', query: playlist.id });
        if (clients === 0) return `The playlist "${playlist.name}" is ready, but no Mimi app is open to play it.`;
        return `Playing the Mimiamp playlist "${playlist.name}" in ${clients} open Mimi app${clients === 1 ? '' : 's'}.`;
      }
      if (input.action === 'youtube-add') {
        if (!youtube) throw new Error('YouTube is not available in this Mimi install.');
        const url = input.url?.trim();
        if (!url) throw new Error('Give `url` (a YouTube link).');
        const track = await youtube.add(url);
        refresh();
        return `Added YouTube song "${track.title}"${track.artist ? ` — ${track.artist}` : ''} to Mimiamp (audio only).`;
      }
      if (input.action === 'volume' && input.level === undefined) throw new Error('Give `level` (0–100) for volume.');
      if (input.action === 'seek' && input.seconds === undefined) throw new Error('Give `seconds` for seek.');

      let query = input.query?.trim() || undefined;
      let matched: MimiampTrack | undefined;
      if (query && input.action === 'play') {
        const tracks = library();
        matched = findTrack(tracks, query);
        if (!matched) {
          const titles = tracks.slice(0, 20).map((track) => track.title).join(', ');
          throw new Error(`No Mimiamp track matches "${query}".${titles ? ` Available: ${titles}` : ' The library is empty.'}`);
        }
        // The exact id avoids a different match in the player (two songs with similar names).
        query = matched.id;
      }

      const command: MimiampCommand = {
        action: input.action,
        ...(query ? { query } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.seconds !== undefined ? { seconds: input.seconds } : {}),
      };
      const clients = control(command);
      if (clients === 0) return 'No Mimi app is open right now, so the player did not receive the command.';
      const apps = `${clients} open Mimi app${clients === 1 ? '' : 's'}`;
      if (input.action === 'open') return `Opened Mimiamp as a floating player in ${apps}.`;
      if (input.action === 'play') return `Playing ${matched ? `"${matched.title}"` : 'music'} on Mimiamp in ${apps}.`;
      if (input.action === 'volume') return `Set Mimiamp volume to ${input.level}% in ${apps}.`;
      if (input.action === 'seek') return `Moved Mimiamp to ${input.seconds}s in ${apps}.`;
      return `Sent "${input.action}" to Mimiamp in ${apps}.`;
    },
  });
  return [mimiamp];
}
