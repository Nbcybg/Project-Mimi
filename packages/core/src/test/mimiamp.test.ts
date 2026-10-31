import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MimiampCommand } from '@mimi/shared';
import { isAudioFile, listMimiampTracks, titleFromFile, trackPath } from '../mimiamp/library.ts';
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
  assert.equal(tracks[1]!.url, '/mimiamp/01%20-%20Long_Name.ogg');
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
    { file: 'a.mp3', title: 'Alpha', artist: 'Mimi', url: '/mimiamp/a.mp3' },
    { file: 'b.mp3', title: 'Beta', url: '/mimiamp/b.mp3' },
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
  assert.deepEqual(calls.at(-1), { action: 'play', query: 'b.mp3' });

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
