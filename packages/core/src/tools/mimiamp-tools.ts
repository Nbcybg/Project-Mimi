import type { MimiampCommand } from '@mimi/shared';
import { z } from 'zod';
import { listMimiampTracks, type MimiampTrack } from '../mimiamp/library.ts';
import { defineTool, type ToolDefinition } from './registry.ts';

/** Sends a command to the Mimiamp player of every open app; returns how many clients got it. */
export type MimiampControl = (command: MimiampCommand) => number;
export type MimiampLibrary = () => MimiampTrack[];

const mimiampActions = ['list', 'open', 'play', 'pause', 'stop', 'next', 'previous', 'volume', 'seek'] as const;

/** A track by title, artist, album or file name (exact first, then a part of the text). */
function findTrack(tracks: MimiampTrack[], query: string): MimiampTrack | undefined {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return undefined;
  const fields = (track: MimiampTrack) => [track.title, track.artist, track.album, track.file].filter(Boolean).map((value) => value!.toLowerCase());
  return (
    tracks.find((track) => fields(track).includes(wanted)) ??
    tracks.find((track) => fields(track).some((value) => value.includes(wanted)))
  );
}

const describeTrack = (track: MimiampTrack, index: number) =>
  `${index + 1}. ${track.title}${track.artist ? ` — ${track.artist}` : ''} (${track.file})`;

/**
 * Lets an agent put music on for the user: open the Mimiamp screen, play a track in the
 * background, skip, pause, set the volume or move through the track. The music lives in
 * the app (a developer adds the files), so no link or download is needed.
 */
export function createMimiampTools(control: MimiampControl, library: MimiampLibrary = listMimiampTracks): ToolDefinition<any>[] {
  const mimiamp = defineTool({
    name: 'mimiamp',
    description:
      'Control Mimiamp, the music player built into the user\'s Mimi app. Use `list` first to see the songs a developer added, then `play` with a title (or nothing for the current song) to play music in the background. `open` shows the floating picture-in-picture player over whatever screen the user is on; they can click it to expand the full Mimiamp screen. `pause`, `stop`, `next`, `previous`, `volume` (0–100) and `seek` (seconds) work while it plays. The sound comes out of the open Mimi app, so nothing happens when the user has no app open.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      action: z.enum(mimiampActions).describe('What to do; `list` shows the available songs'),
      query: z.string().max(200).optional().describe('Song title, artist or file name (for `play`)'),
      level: z.number().int().min(0).max(100).optional().describe('Volume percent (for `volume`)'),
      seconds: z.number().int().min(0).optional().describe('Position in the track (for `seek`)'),
    }),
    summarize: (input) => {
      if (input.action === 'list') return 'List the Mimiamp songs';
      if (input.action === 'play') return `Play ${input.query ? `"${input.query}"` : 'music'} on Mimiamp`;
      if (input.action === 'volume') return `Set Mimiamp volume to ${input.level ?? '?'}%`;
      if (input.action === 'seek') return `Seek Mimiamp to ${input.seconds ?? '?'}s`;
      return `${input.action[0]!.toUpperCase()}${input.action.slice(1)} Mimiamp`;
    },
    async execute(input) {
      if (input.action === 'list') {
        const tracks = library();
        return tracks.length === 0
          ? 'Mimiamp has no songs yet. Put audio files in <user>/mimiamp (or <app>/mimiamp), or point MIMI_MUSIC_DIR at a folder.'
          : `Mimiamp has ${tracks.length} track${tracks.length === 1 ? '' : 's'}:\n${tracks.map(describeTrack).join('\n')}`;
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
        // The exact file avoids a different match in the player (two songs with similar names).
        query = matched.file;
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
