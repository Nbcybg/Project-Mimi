import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MimiampCommand } from '@mimi/shared';
import { isAudioFile, listMimiampTracks, mimiampDir, titleFromFile, trackPath } from '../mimiamp/library.ts';
import { MimiampPlaylists } from '../mimiamp/playlists.ts';
import { MimiampService } from '../mimiamp/service.ts';
import { createMimiampTools } from '../tools/mimiamp-tools.ts';

const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [] };

function musicFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimiamp-'));
  fs.writeFileSync(path.join(dir, 'b.mp3'), '');
  fs.writeFileSync(path.join(dir, '01 - Long_Name.ogg'), '');
  fs.writeFileSync(path.join(dir, 'c.wav'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not music');
  fs.writeFileSync(path.join(dir, '.hidden.mp3'), '');
  fs.writeFileSync(
    path.join(dir, 'tracks.json'),
    JSON.stringify({
      tracks: [
        { file: 'b.mp3', title: 'Bee', artist: 'Mimi', duration: 12.4 },
        { file: 'missing.mp3', title: 'Gone' },
        { file: 'notes.txt', title: 'Not music' },
        { file: '01 - Long_Name.ogg' },
      ],
    }),
  );
  return dir;
}

test('library lists manifest tracks first, then audio files nobody listed', (t) => {
  const dir = musicFolder();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tracks = listMimiampTracks(dir);
  assert.deepEqual(
    tracks.map((track) => [track.file, track.title, track.artist]),
    [
      ['b.mp3', 'Bee', 'Mimi'],
      ['01 - Long_Name.ogg', 'Long Name', undefined],
      ['c.wav', 'c', undefined],
    ],
  );
  assert.equal(tracks[0]!.duration, 12);
  assert.equal(tracks[0]!.url, '/mimiamp/b.mp3');
  assert.equal(tracks[0]!.id, 'file:b.mp3');
  assert.equal(tracks[0]!.source, 'file');
  assert.equal(tracks[1]!.url, '/mimiamp/01%20-%20Long_Name.ogg');
});

test('the music folder comes from MIMI_MUSIC_DIR, the user folder, or the app root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimiamp-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'user', 'mimiamp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'user', 'mimiamp', 'a.mp3'), '');
  fs.mkdirSync(path.join(root, 'mimiamp'));
  fs.writeFileSync(path.join(root, 'mimiamp', 'b.mp3'), '');
  const env = { MIMI_ROOT: root, MIMI_USER: 'user' };
  assert.equal(mimiampDir(env), path.join(root, 'user', 'mimiamp'), 'the user folder wins over the app root');
  fs.rmSync(path.join(root, 'user', 'mimiamp'), { recursive: true });
  assert.equal(mimiampDir(env), path.join(root, 'mimiamp'), 'an empty user folder falls back to the app root');
  fs.rmSync(path.join(root, 'mimiamp', 'b.mp3'));
  assert.match(mimiampDir(env), /server[\\/]web[\\/]mimiamp$/, 'no music at all falls back to the built-in folder');
  assert.equal(mimiampDir({ ...env, MIMI_MUSIC_DIR: path.join(root, 'custom') }), path.join(root, 'custom'));
});

test('a missing folder is an empty library, not an error', () => {
  assert.deepEqual(listMimiampTracks(path.join(os.tmpdir(), 'mimiamp-does-not-exist')), []);
});

test('only plain audio file names are served', () => {
  assert.equal(isAudioFile('song.mp3'), true);
  assert.equal(isAudioFile('Song.FLAC'), true);
  assert.equal(isAudioFile('../secret.mp3'), false);
  assert.equal(isAudioFile('sub/song.mp3'), false);
  assert.equal(isAudioFile('.hidden.mp3'), false);
  assert.equal(isAudioFile('notes.txt'), false);
  assert.equal(trackPath('../secret.mp3'), null);
  assert.ok(trackPath('song.mp3', '/music'));
  assert.equal(titleFromFile('07 - Some_Song.mp3'), 'Some Song');
});

test('the agent tool lists tracks and controls the player', async () => {
  const calls: MimiampCommand[] = [];
  const tracks = [
    { id: 'file:a.mp3', source: 'file' as const, file: 'a.mp3', title: 'Alpha', artist: 'Mimi', url: '/mimiamp/a.mp3' },
    { id: 'file:b.mp3', source: 'file' as const, file: 'b.mp3', title: 'Beta', url: '/mimiamp/b.mp3' },
  ];
  const [tool] = createMimiampTools(
    (command) => {
      calls.push(command);
      return 2;
    },
    () => tracks,
  );

  const listing = await tool!.execute({ action: 'list' }, context);
  assert.match(listing, /2 tracks/);
  assert.match(listing, /1\. Alpha — Mimi/);

  const played = await tool!.execute({ action: 'play', query: 'beta' }, context);
  assert.match(played, /Playing "Beta"/);
  assert.deepEqual(calls.at(-1), { action: 'play', query: 'file:b.mp3' });

  assert.equal(await tool!.execute({ action: 'play' }, context), 'Playing music on Mimiamp in 2 open Mimi apps.');
  assert.deepEqual(calls.at(-1), { action: 'play' });

  await tool!.execute({ action: 'volume', level: 25 }, context);
  assert.deepEqual(calls.at(-1), { action: 'volume', level: 25 });

  const opened = await tool!.execute({ action: 'open' }, context);
  assert.match(opened, /floating player/);
  assert.deepEqual(calls.at(-1), { action: 'open' });

  await assert.rejects(tool!.execute({ action: 'play', query: 'nothing' }, context), /No Mimiamp track matches/);
  await assert.rejects(tool!.execute({ action: 'volume' }, context), /level/);

  const empty = createMimiampTools(() => 0, () => [])[0]!;
  assert.match(await empty.execute({ action: 'list' }, context), /no songs yet/i);
  assert.match(await empty.execute({ action: 'pause' }, context), /No Mimi app is open/);
});


test('playlists create, add, remove, export and import without losing songs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimiamp-playlists-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MimiampPlaylists(path.join(dir, 'playlists.json'));
  const playlist = store.create('Road Trip');
  assert.equal(playlist.name, 'Road Trip');
  assert.equal(store.create('road trip').name.toLowerCase(), 'road trip 2', 'names stay unique');

  const track = {
    id: 'file:song.mp3',
    source: 'file' as const,
    file: 'song.mp3',
    title: 'Song',
    artist: 'Mimi',
    duration: 90,
    url: '/mimiamp/song.mp3',
  };
  store.addTrack(playlist.id, track);
  store.addTrack(playlist.id, track);
  assert.equal(store.get(playlist.id)!.items.length, 1, 'the same track is kept once');

  const local = store.addItem(playlist.id, { source: 'local', localId: 'local-1', title: 'On this device' });
  assert.equal(local.items.length, 2);

  const exported = store.export(playlist.id);
  assert.equal(exported.format, 'mimiamp-playlist');
  assert.equal(exported.playlist.items.length, 2);

  const imported = store.import(exported);
  assert.equal(imported.items.length, 2);
  assert.notEqual(imported.id, playlist.id);
  assert.equal(store.list().length, 3);

  const removed = store.removeItem(playlist.id, 'Song');
  assert.equal(removed.removed?.title, 'Song');
  assert.equal(removed.playlist.items.length, 1);
  assert.equal(store.remove(playlist.id), true);
  assert.equal(store.get(playlist.id), undefined);
});

test('the agent can create a playlist and add or remove a song', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimiamp-tool-playlists-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const playlists = new MimiampPlaylists(path.join(dir, 'playlists.json'));
  const tracks = [
    { id: 'file:a.mp3', source: 'file' as const, file: 'a.mp3', title: 'Alpha', url: '/mimiamp/a.mp3' },
    { id: 'youtube:abcdefghijk', source: 'youtube' as const, videoId: 'abcdefghijk', title: 'Video', url: '/mimiamp/youtube/abcdefghijk.audio' },
  ];
  const calls: MimiampCommand[] = [];
  const [tool] = createMimiampTools(
    (command) => {
      calls.push(command);
      return 1;
    },
    () => tracks,
    playlists,
    { add: async () => tracks[1]! },
  );

  assert.match(await tool!.execute({ action: 'playlist-create', name: 'Mix' }, context), /Created/);
  assert.match(await tool!.execute({ action: 'playlist-add', playlist: 'Mix', query: 'video' }, context), /Added "Video"/);
  assert.equal(playlists.list()[0]!.items.length, 1);
  assert.deepEqual(calls.at(-1), { action: 'refresh' });
  assert.match(await tool!.execute({ action: 'playlist-remove', playlist: 'Mix', query: 'Video' }, context), /Removed/);
  assert.equal(playlists.list()[0]!.items.length, 0);
  assert.match(await tool!.execute({ action: 'youtube-add', url: 'https://youtu.be/abcdefghijk' }, context), /Added YouTube song/);
  assert.match(await tool!.execute({ action: 'playlists' }, context), /Mix/);
  await assert.rejects(tool!.execute({ action: 'playlist-add', playlist: 'Nope', query: 'Video' }, context), /No playlist/);
});


test('YouTube songs are saved as audio-only library entries and can be removed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimiamp-youtube-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ytdl = {
    getInfo: async () => ({
      videoDetails: {
        title: 'A YouTube Song',
        author: { name: 'Singer' },
        lengthSeconds: 187,
      },
    }),
  };
  const service = new MimiampService({ dataDir: dir, ytdl: ytdl as never });
  const track = await service.addYoutube('https://youtu.be/abcdefghijk?si=test');
  assert.equal(track.id, 'youtube:abcdefghijk');
  assert.equal(track.source, 'youtube');
  assert.equal(track.title, 'A YouTube Song');
  assert.equal(track.artist, 'Singer');
  assert.equal(track.duration, 187);
  assert.equal(track.url, '/mimiamp/youtube/abcdefghijk.audio');
  assert.equal(service.state().tracks.filter((entry) => entry.source === 'youtube').length, 1);

  const again = await service.addYoutube('abcdefghijk');
  assert.equal(again.id, track.id);
  assert.equal(service.state().tracks.filter((entry) => entry.source === 'youtube').length, 1, 'the same video is not duplicated');

  const playlist = service.playlists.create('YouTube mix');
  service.playlists.addTrack(playlist.id, track);
  assert.equal(service.state().playlists[0]!.items[0]!.title, 'A YouTube Song');

  assert.equal(service.removeYoutube('abcdefghijk'), true);
  assert.equal(service.state().tracks.some((entry) => entry.videoId === 'abcdefghijk'), false);
  await assert.rejects(service.addYoutube('not a youtube link at all'), /Paste a YouTube/);
});
