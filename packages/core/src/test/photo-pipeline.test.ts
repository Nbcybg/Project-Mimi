import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  detectMediaTools,
  imageCropTool,
  imageRotateTool,
  mediaContactSheetTool,
  mediaExtractAudioTool,
  mediaSubtitleTool,
  mediaTransformTool,
  mediaTrimTool,
  pcTools,
  videoMergeTool,
} from '@mimi/pc-agent';
import { makeTestCore } from './core-helpers.ts';
import { collect, eventsOf } from './helpers.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-photo-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const tool = (name: string) => pcTools.find((candidate) => candidate.name === name)!;
const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [tmp] };
const run = (name: string, input: unknown) => {
  const definition = tool(name);
  return definition.execute(definition.inputSchema.parse(input), context);
};
const parse = (text: string) => JSON.parse(text) as Record<string, any>;
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function makeImage(file: string, source: string, filter?: string): void {
  const args = ['-v', 'error', '-f', 'lavfi', '-i', source, '-frames:v', '1'];
  if (filter) args.push('-vf', filter);
  args.push('-y', file);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}

test('media tools are detected with versions or clear errors', async () => {
  const tools = await detectMediaTools();
  assert.equal(typeof tools.ffmpeg.available, 'boolean');
  assert.equal(typeof tools.ffprobe.available, 'boolean');
  assert.equal(typeof tools.imagemagick.available, 'boolean');
  assert.equal(typeof tools.python.available, 'boolean');
  if (!tools.ffmpeg.available) assert.ok(tools.ffmpeg.error);
});

test('photo scan, contact sheet, apply, verify and undo keep originals read-only', async (t) => {
  const tools = await detectMediaTools();
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    t.skip('ffmpeg/ffprobe are not installed');
    return;
  }
  const source = path.join(tmp, 'photos');
  const output = path.join(tmp, 'culled');
  fs.mkdirSync(source, { recursive: true });
  try {
    makeImage(path.join(source, 'red.png'), 'color=c=red:s=64x64');
    fs.copyFileSync(path.join(source, 'red.png'), path.join(source, 'red-copy.png'));
    makeImage(path.join(source, 'sharp.png'), 'testsrc=s=64x64');
    makeImage(path.join(source, 'blurred.png'), 'testsrc=s=64x64', 'gblur=sigma=10');
  } catch {
    t.skip('ffmpeg cannot create the fixture images');
    return;
  }
  const originals = new Map(fs.readdirSync(source).map((name) => [name, hash(path.join(source, name))]));

  const scan = parse(
    await run('photo_scan', { path: source, blur_threshold: 10, max_files: 20, vision_samples: 10, max_cost_usd: 0.01 }),
  );
  assert.equal(scan.ok, true);
  assert.equal(scan.files.length, 4);
  assert.ok(scan.exactGroups.length >= 1, 'red and red-copy are exact duplicates');
  const rejectedReasons = scan.rejected.map((entry: { reason: string }) => entry.reason);
  assert.ok(rejectedReasons.includes('duplicate'));
  assert.ok(rejectedReasons.includes('blurry'));
  assert.equal(scan.vision.sampled <= Math.floor(0.01 / 0.002), true);
  assert.equal(scan.vision.estimatedCostUsd <= scan.vision.maxCostUsd, true);
  assert.ok(scan.selected.some((file: { name: string }) => file.name === 'sharp.png'));

  const keep = scan.selected.map((file: { path: string }) => file.path);
  const reject = scan.rejected.map((file: { path: string }) => file.path);
  const sheet = parse(
    await run('media_contact_sheet', {
      path: source,
      output: path.join(output, 'preview'),
      files: keep,
      columns: 2,
      width: 160,
    }),
  );
  assert.equal(sheet.ok, true);
  assert.ok(fs.existsSync(sheet.path));

  const applied = parse(await run('photo_apply', { path: source, output, keep, reject }));
  assert.equal(applied.ok, true);
  assert.ok(fs.existsSync(applied.journal));
  assert.ok(fs.readdirSync(path.join(output, 'keep')).length >= 1);
  assert.ok(fs.readdirSync(path.join(output, 'reject')).length >= 1);
  for (const [name, before] of originals) assert.equal(hash(path.join(source, name)), before, `${name} was not changed`);

  const verified = parse(await run('photo_verify', { journal: applied.journal }));
  assert.equal(verified.ok, true);

  const undone = parse(await run('photo_undo', { journal: applied.journal }));
  assert.equal(undone.ok, true);
  assert.equal(fs.readdirSync(path.join(output, 'keep')).length, 0);
  assert.equal(fs.readdirSync(path.join(output, 'reject')).length, 0);
  const afterUndo = parse(await run('photo_verify', { journal: applied.journal }));
  assert.equal(afterUndo.ok, true);
  for (const [name, before] of originals) assert.equal(hash(path.join(source, name)), before, `${name} was not changed`);
});

test('photo-cull recipe: plan, contact sheet, copy keepers/rejects, verify and undo', async (t) => {
  const tools = await detectMediaTools();
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    t.skip('ffmpeg/ffprobe are not installed');
    return;
  }
  const target = await makeTestCore();
  try {
    const photos = path.join(target.config.allowedDirs[0]!, 'photos');
    fs.mkdirSync(photos, { recursive: true });
    try {
      makeImage(path.join(photos, 'red.png'), 'color=c=red:s=64x64');
      fs.copyFileSync(path.join(photos, 'red.png'), path.join(photos, 'red-copy.png'));
      makeImage(path.join(photos, 'sharp.png'), 'testsrc=s=64x64');
      makeImage(path.join(photos, 'blurred.png'), 'testsrc=s=64x64', 'gblur=sigma=10');
    } catch {
      t.skip('ffmpeg cannot create the fixture images');
      return;
    }
    const originals = new Map(fs.readdirSync(photos).map((name) => [name, hash(path.join(photos, name))]));
    const events = await collect(
      target.core.taskRunner.run({
        recipe: 'photo-cull',
        goal: 'cull these photos',
        input: {
          path: 'photos',
          output: 'culled',
          blur_threshold: 10,
          max_files: 20,
          vision_samples: 0,
          max_cost_usd: 0.01,
        },
        traceId: 'photo-trace',
        thread: 'main',
        agent: 'mimi',
      }),
    );
    const finish = eventsOf(events, 'task-finish')[0]!;
    assert.equal(finish.status, 'completed', finish.receipt?.summary ?? '');
    const receipt = eventsOf(events, 'task-receipt')[0]!;
    assert.equal(receipt.receipt.undoable, true);
    assert.match(receipt.receipt.summary, /originals untouched/);
    assert.match(receipt.receipt.summary, /\$0 of \$0\.01/);
    assert.ok(fs.existsSync(path.join(target.config.allowedDirs[0]!, 'culled', 'preview', 'contact-sheet.jpg')));
    assert.ok(fs.readdirSync(path.join(target.config.allowedDirs[0]!, 'culled', 'keep')).length >= 1);
    assert.ok(fs.readdirSync(path.join(target.config.allowedDirs[0]!, 'culled', 'reject')).length >= 1);
    for (const [name, before] of originals) assert.equal(hash(path.join(photos, name)), before, `${name} was not changed`);

    const stored = target.core.tasks.get(eventsOf(events, 'task-start')[0]!.task.id)!;
    const undoEvents = await collect(target.core.taskRunner.undo(stored));
    assert.equal(eventsOf(undoEvents, 'task-finish')[0]!.status, 'undone');
    assert.equal(fs.readdirSync(path.join(target.config.allowedDirs[0]!, 'culled', 'keep')).length, 0);
    for (const [name, before] of originals) assert.equal(hash(path.join(photos, name)), before, `${name} was not changed`);
  } finally {
    await target.cleanup();
  }
});

test('media_transform writes a resized copy, never the original', async (t) => {
  const tools = await detectMediaTools();
  if (!tools.ffmpeg.available) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const source = path.join(tmp, 'transform-src');
  const output = path.join(tmp, 'transform-out');
  fs.mkdirSync(source, { recursive: true });
  try {
    makeImage(path.join(source, 'original.png'), 'color=c=blue:s=80x60');
  } catch {
    t.skip('ffmpeg cannot create the fixture image');
    return;
  }
  const before = hash(path.join(source, 'original.png'));
  const result = parse(
    await mediaTransformTool.execute(
      mediaTransformTool.inputSchema.parse({ path: source, output, files: ['original.png'], width: 40 }),
      context,
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(hash(path.join(source, 'original.png')), before);
  assert.equal(fs.readdirSync(output).length, 1);
});

function streamInfo(file: string): { width?: number; height?: number; codec?: string } {
  const json = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file]).toString(),
  ) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }> };
  const stream = json.streams?.[0] ?? {};
  return { width: stream.width, height: stream.height, codec: stream.codec_name };
}

test('image_crop and image_rotate write new files and keep the source', async (t) => {
  const tools = await detectMediaTools();
  if (!tools.ffmpeg.available) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const source = path.join(tmp, 'crop-src.png');
  try {
    makeImage(source, 'color=c=green:s=80x60');
  } catch {
    t.skip('ffmpeg cannot create the fixture image');
    return;
  }
  const before = hash(source);

  const cropped = path.join(tmp, 'crop-out.png');
  await imageCropTool.execute(imageCropTool.inputSchema.parse({ path: source, output: cropped, x: 10, y: 5, width: 30, height: 20 }), context);
  assert.deepEqual([streamInfo(cropped).width, streamInfo(cropped).height], [30, 20]);
  assert.equal(hash(source), before);

  const rotated = path.join(tmp, 'rotate-out.png');
  await imageRotateTool.execute(imageRotateTool.inputSchema.parse({ path: source, output: rotated, degrees: 90 }), context);
  assert.deepEqual([streamInfo(rotated).width, streamInfo(rotated).height], [60, 80]);
  assert.equal(hash(source), before);

  await assert.rejects(
    imageCropTool.execute(imageCropTool.inputSchema.parse({ path: source, output: source, x: 0, y: 0, width: 10, height: 10 }), context),
    /in_place/,
  );

  const inPlace = path.join(tmp, 'crop-in-place.png');
  fs.copyFileSync(source, inPlace);
  const original = hash(inPlace);
  const replaced = parse(
    await imageCropTool.execute(imageCropTool.inputSchema.parse({ path: inPlace, x: 5, y: 5, width: 20, height: 20, in_place: true }), context),
  );
  assert.equal(replaced.in_place, true);
  assert.ok(replaced.backup && fs.existsSync(replaced.backup), 'an in-place edit keeps a backup');
  assert.equal(hash(replaced.backup), original);
  assert.deepEqual([streamInfo(inPlace).width, streamInfo(inPlace).height], [20, 20]);
});

test('video_merge and media_subtitle write new files and keep the sources', async (t) => {
  const tools = await detectMediaTools();
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    t.skip('ffmpeg/ffprobe are not installed');
    return;
  }
  const one = path.join(tmp, 'merge-1.mp4');
  const two = path.join(tmp, 'merge-2.mp4');
  const merged = path.join(tmp, 'merged.mp4');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:d=1', '-pix_fmt', 'yuv420p', '-y', one], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:d=1', '-pix_fmt', 'yuv420p', '-y', two], { stdio: 'ignore' });
  } catch {
    t.skip('ffmpeg cannot create the fixture videos');
    return;
  }
  const before = [hash(one), hash(two)];
  const result = parse(await videoMergeTool.execute(videoMergeTool.inputSchema.parse({ files: [one, two], output: merged }), context));
  assert.equal(result.ok, true);
  const duration = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', merged]).toString().trim(),
  );
  assert.ok(duration >= 1.8, `merged duration ${duration}`);
  assert.deepEqual([hash(one), hash(two)], before);

  const subtitles = path.join(tmp, 'subs.srt');
  fs.writeFileSync(subtitles, '1\n00:00:00,000 --> 00:00:00,800\nhello\n');
  const subtitled = path.join(tmp, 'subtitled.mp4');
  await mediaSubtitleTool.execute(
    mediaSubtitleTool.inputSchema.parse({ video: one, subtitles, output: subtitled, language: 'eng' }),
    context,
  );
  const streams = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', subtitled]).toString().trim();
  assert.match(streams, /mov_text/);

  const burned = path.join(tmp, 'subtitled-burn.mp4');
  await mediaSubtitleTool.execute(
    mediaSubtitleTool.inputSchema.parse({ video: one, subtitles, output: burned, mode: 'burn' }),
    context,
  );
  const burnedCodec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', burned]).toString().trim();
  assert.equal(burnedCodec, 'h264');

  const withAudio = path.join(tmp, 'with-audio.mp4');
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x48:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', '-y', withAudio],
    { stdio: 'ignore' },
  );
  const audio = path.join(tmp, 'extracted.mp3');
  const audioSourceHash = hash(withAudio);
  await mediaExtractAudioTool.execute(mediaExtractAudioTool.inputSchema.parse({ path: withAudio, output: audio }), context);
  assert.ok(fs.statSync(audio).size > 0);
  assert.equal(hash(withAudio), audioSourceHash, 'the source video is not changed');
  assert.deepEqual([hash(one), hash(two)], before);
});

test('media_trim writes a shorter video and leaves the source alone', async (t) => {
  const tools = await detectMediaTools();
  if (!tools.ffmpeg.available) {
    t.skip('ffmpeg is not installed');
    return;
  }
  const source = path.join(tmp, 'trim-src.mp4');
  const output = path.join(tmp, 'trim-out.mp4');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=3', '-pix_fmt', 'yuv420p', '-y', source], { stdio: 'ignore' });
  } catch {
    t.skip('ffmpeg cannot create the fixture video');
    return;
  }
  const before = hash(source);
  const result = parse(
    await mediaTrimTool.execute(
      mediaTrimTool.inputSchema.parse({ path: source, output, start_seconds: 0.5, duration_seconds: 1 }),
      context,
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(hash(source), before);
  assert.ok(fs.statSync(output).size > 0);
});
