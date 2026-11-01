import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { runProcess, sanitizedEnv } from '../process.ts';
import { resolveAllowedPath } from './path-guard.ts';
import { atomicOutput, resolveSingleOutput } from './output-target.ts';

const MEDIA_DIR = '.mimi-media';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif']);
const DEFAULT_MAX_FILES = 300;
const MAX_FILES = 2_000;
const DEFAULT_BLUR_THRESHOLD = 40;
const DEFAULT_VISION_SAMPLES = 0;
const VISION_COST_PER_SAMPLE = 0.002;

interface ToolInfo {
  available: boolean;
  version?: string;
  command: string;
  error?: string;
}

interface MediaTools {
  ffmpeg: ToolInfo;
  ffprobe: ToolInfo;
  imagemagick: ToolInfo;
  python: ToolInfo;
}

interface ProbedFile {
  path: string;
  name: string;
  relative: string;
  size: number;
  sha256: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  codec?: string;
  createdAt?: string;
  camera?: string;
  phash?: string;
  blur?: number;
}

interface RejectedFile {
  path: string;
  reason: 'duplicate' | 'near-duplicate' | 'blurry';
  duplicateOf?: string;
}

interface PhotoGroup {
  id: string;
  kind: 'exact' | 'near';
  files: string[];
  keep: string;
}

interface ScanResult {
  ok: boolean;
  root: string;
  tools: MediaTools;
  files: ProbedFile[];
  exactGroups: PhotoGroup[];
  nearGroups: PhotoGroup[];
  selected: ProbedFile[];
  rejected: RejectedFile[];
  vision: {
    requested: number;
    sampled: number;
    skipped: number;
    maxCostUsd: number;
    estimatedCostUsd: number;
    note: string;
  };
  summary: string;
}

async function detectCommand(command: string, args: string[]): Promise<ToolInfo> {
  try {
    const result = await runProcess(command, args, {
      cwd: process.cwd(),
      env: sanitizedEnv(),
      timeoutMs: 5_000,
      maxOutput: 2_000,
    });
    if (result.exitCode === 0) return { available: true, command, version: result.output.split(/\r?\n/)[0]?.trim() };
    return { available: false, command, error: result.output.split(/\r?\n/)[0]?.trim() || `exit code ${result.exitCode}` };
  } catch (error) {
    return { available: false, command, error: (error as Error).message };
  }
}

export async function detectMediaTools(): Promise<MediaTools> {
  const magick = await detectCommand('magick', ['-version']);
  return {
    ffmpeg: await detectCommand('ffmpeg', ['-version']),
    ffprobe: await detectCommand('ffprobe', ['-version']),
    imagemagick: magick.available ? magick : await detectCommand('convert', ['-version']),
    python: await detectCommand(process.platform === 'win32' ? 'python' : 'python3', ['--version']),
  };
}

function requireTool(tool: ToolInfo, label: string): void {
  if (!tool.available) {
    throw new Error(`${label} is not installed (${tool.command}). Install it and try again: ${tool.error ?? 'not found'}`);
  }
}

/** One retry for a transient reader/decoder failure; the batch does not stop for one photo. */
async function runMedia(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; maxOutput?: number; binary?: boolean; signal?: AbortSignal },
) {
  const run = () =>
    runProcess(command, args, {
      cwd: options.cwd,
      env: sanitizedEnv(),
      timeoutMs: options.timeoutMs ?? 20_000,
      maxOutput: options.maxOutput ?? 1024 * 1024,
      ...(options.binary ? { binary: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  let result = await run();
  if (result.exitCode !== 0 && !result.cancelled) result = await run();
  return result;
}

async function probeFile(root: string, file: string, tools: MediaTools): Promise<ProbedFile> {
  const stat = await fs.stat(file);
  const sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const base: ProbedFile = {
    path: file,
    name: path.basename(file),
    relative: path.relative(root, file),
    size: stat.size,
    sha256,
  };
  if (!tools.ffprobe.available) return base;
  const result = await runMedia(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { cwd: path.dirname(file), timeoutMs: 20_000, maxOutput: 1024 * 1024 },
  );
  if (result.exitCode !== 0) return base;
  try {
    const data = JSON.parse(result.output) as {
      format?: { duration?: string; tags?: Record<string, string> };
      streams?: Array<{ width?: number; height?: number; codec_name?: string; tags?: Record<string, string> }>;
    };
    const stream = data.streams?.find((entry) => entry.width && entry.height);
    const tags = { ...data.format?.tags, ...stream?.tags };
    const camera = [tags.Make ?? tags.make, tags.Model ?? tags.model].filter(Boolean).join(' ');
    return {
      ...base,
      ...(stream?.width ? { width: stream.width } : {}),
      ...(stream?.height ? { height: stream.height } : {}),
      ...(data.format?.duration ? { durationSeconds: Number(data.format.duration) } : {}),
      ...(stream?.codec_name ? { codec: stream.codec_name } : {}),
      ...(tags.DateTimeOriginal || tags.creation_time || tags.date
        ? { createdAt: tags.DateTimeOriginal ?? tags.creation_time ?? tags.date }
        : {}),
      ...(camera ? { camera } : {}),
    };
  } catch {
    return base;
  }
}

async function phash(file: string, tools: MediaTools): Promise<string | undefined> {
  if (!tools.ffmpeg.available) return undefined;
  const result = await runMedia(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', 'scale=9:8:flags=area,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'],
    { cwd: path.dirname(file), timeoutMs: 20_000, maxOutput: 1024, binary: true },
  );
  if (result.exitCode !== 0 || !result.buffer || result.buffer.length < 72) return undefined;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const at = y * 9 + x;
      bits += result.buffer[at]! < result.buffer[at + 1]! ? '1' : '0';
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

async function blurScore(file: string, tools: MediaTools): Promise<number | undefined> {
  if (!tools.ffmpeg.available) return undefined;
  const result = await runMedia(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', 'scale=64:64:flags=area,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'],
    { cwd: path.dirname(file), timeoutMs: 20_000, maxOutput: 4096, binary: true },
  );
  if (result.exitCode !== 0 || !result.buffer || result.buffer.length < 64 * 64) return undefined;
  const data = result.buffer;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < 63; y++) {
    for (let x = 1; x < 63; x++) {
      const at = y * 64 + x;
      const laplacian = 4 * data[at]! - data[at - 1]! - data[at + 1]! - data[at - 64]! - data[at + 64]!;
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count++;
    }
  }
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

function hamming(left: string, right: string): number {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let bits = 0;
  while (value > 0n) {
    bits += Number(value & 1n);
    value >>= 1n;
  }
  return bits;
}

async function walkImages(root: string, recursive: boolean, maxFiles: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= maxFiles) return;
      if (entry.name === MEDIA_DIR || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      found.push(full);
    }
  };
  await walk(root);
  return found;
}

function groupsByExact(files: ProbedFile[]): PhotoGroup[] {
  const byHash = new Map<string, ProbedFile[]>();
  for (const file of files) {
    const group = byHash.get(file.sha256) ?? [];
    group.push(file);
    byHash.set(file.sha256, group);
  }
  return [...byHash.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || b.size - a.size);
      return {
        id: `exact-${randomUUID().slice(0, 8)}`,
        kind: 'exact' as const,
        files: sorted.map((file) => file.path),
        keep: sorted[0]!.path,
      };
    });
}

function groupsByNear(files: ProbedFile[]): PhotoGroup[] {
  const hashed = files.filter((file) => file.phash);
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    let current = value;
    while (parent.get(current) !== current) current = parent.get(current)!;
    while (parent.get(value) !== current) {
      const next = parent.get(value)!;
      parent.set(value, current);
      value = next;
    }
    return current;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(b, a);
  };
  for (const file of hashed) parent.set(file.path, file.path);
  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      if (hamming(hashed[i]!.phash!, hashed[j]!.phash!) <= 5) union(hashed[i]!.path, hashed[j]!.path);
    }
  }
  const grouped = new Map<string, ProbedFile[]>();
  for (const file of hashed) {
    const key = find(file.path);
    const group = grouped.get(key) ?? [];
    group.push(file);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort((a, b) => (b.blur ?? 0) - (a.blur ?? 0) || b.size - a.size);
      return {
        id: `near-${randomUUID().slice(0, 8)}`,
        kind: 'near' as const,
        files: sorted.map((file) => file.path),
        keep: sorted[0]!.path,
      };
    });
}

async function scanPhotos(
  root: string,
  options: { recursive: boolean; maxFiles: number; blurThreshold: number; visionSamples: number; maxCostUsd: number },
  signal?: AbortSignal,
): Promise<ScanResult> {
  const tools = await detectMediaTools();
  requireTool(tools.ffprobe, 'ffprobe');
  const files = await walkImages(root, options.recursive, options.maxFiles);
  const probed: ProbedFile[] = [];
  for (let i = 0; i < files.length; i += 4) {
    const batch = files.slice(i, i + 4);
    const results = await Promise.all(
      batch.map(async (file) => {
        const base = await probeFile(root, file, tools);
        const [phashValue, blur] = await Promise.all([phash(file, tools), blurScore(file, tools)]);
        return { ...base, ...(phashValue ? { phash: phashValue } : {}), ...(blur !== undefined ? { blur } : {}) };
      }),
    );
    for (const file of results) probed.push(file);
    if (signal?.aborted) throw new Error('cancelled');
  }
  probed.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.relative.localeCompare(b.relative));

  const exactGroups = groupsByExact(probed);
  const nearGroups = groupsByNear(probed);
  const rejected: RejectedFile[] = [];
  const rejectedPaths = new Set<string>();
  for (const group of exactGroups) {
    for (const file of group.files) {
      if (file === group.keep) continue;
      rejected.push({ path: file, reason: 'duplicate', duplicateOf: group.keep });
      rejectedPaths.add(file);
    }
  }
  for (const group of nearGroups) {
    // The exact-duplicate pass may already have rejected the sharpest frame in this
    // near group; keep another frame instead of rejecting the whole group.
    const keep = group.files.find((file) => !rejectedPaths.has(file));
    if (!keep) continue;
    group.keep = keep;
    for (const file of group.files) {
      if (file === keep || rejectedPaths.has(file)) continue;
      rejected.push({ path: file, reason: 'near-duplicate', duplicateOf: keep });
      rejectedPaths.add(file);
    }
  }
  for (const file of probed) {
    if (rejectedPaths.has(file.path)) continue;
    if (file.blur !== undefined && file.blur < options.blurThreshold) {
      rejected.push({ path: file.path, reason: 'blurry' });
      rejectedPaths.add(file.path);
    }
  }
  const selected = probed.filter((file) => !rejectedPaths.has(file.path));

  const requested = Math.max(0, options.visionSamples);
  const costCapSamples = options.maxCostUsd > 0 ? Math.floor(options.maxCostUsd / VISION_COST_PER_SAMPLE) : 0;
  const sampled = Math.min(requested, costCapSamples);
  const vision = {
    requested,
    sampled,
    skipped: Math.max(0, requested - sampled),
    maxCostUsd: options.maxCostUsd,
    estimatedCostUsd: Number((sampled * VISION_COST_PER_SAMPLE).toFixed(4)),
    note:
      sampled > 0
        ? 'Vision scoring is sampled within the cost cap; the deterministic cull below does not depend on it.'
        : 'Vision scoring skipped (0 samples or the cost cap allows none); deterministic cull only.',
  };
  const exactCount = exactGroups.reduce((total, group) => total + group.files.length - 1, 0);
  const nearCount = nearGroups.reduce((total, group) => total + group.files.length - 1, 0);
  const blurryCount = rejected.filter((file) => file.reason === 'blurry').length;
  return {
    ok: true,
    root,
    tools,
    files: probed,
    exactGroups,
    nearGroups,
    selected,
    rejected,
    vision,
    summary: `${probed.length} photo(s): ${selected.length} selected, ${exactCount} exact duplicate(s), ${nearCount} near duplicate(s), ${blurryCount} blurry; vision ${vision.sampled}/${vision.requested} sample(s), $${vision.estimatedCostUsd} of $${vision.maxCostUsd}.`,
  };
}

async function uniquePath(target: string): Promise<string> {
  if (!fsSync.existsSync(target)) return target;
  const dir = path.dirname(target);
  const extension = path.extname(target);
  const base = path.basename(target, extension);
  for (let n = 1; n < 10_000; n++) {
    const candidate = path.join(dir, `${base} (${n})${extension}`);
    if (!fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find a free name next to ${target}.`);
}

async function copyTo(source: string, destination: string): Promise<string> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const target = await uniquePath(destination);
  await fs.copyFile(source, target);
  return target;
}

interface JournalEntry {
  from: string;
  to: string;
  kind: 'keep' | 'reject';
}

interface PhotoJournal {
  version: 1;
  id: string;
  root: string;
  output: string;
  createdAt: string;
  status: 'applied' | 'undone';
  entries: JournalEntry[];
}

async function applyPhotos(
  root: string,
  output: string,
  keep: string[],
  reject: string[],
  context: { allowedDirs: string[] },
): Promise<{ journal: string; entries: JournalEntry[]; summary: string }> {
  const entries: JournalEntry[] = [];
  const copies: Array<{ source: string; kind: 'keep' | 'reject' }> = [
    ...keep.map((source) => ({ source, kind: 'keep' as const })),
    ...reject.map((source) => ({ source, kind: 'reject' as const })),
  ];
  for (const copy of copies) {
    const source = resolveAllowedPath(copy.source, context.allowedDirs, root);
    const target = await copyTo(source, path.join(output, copy.kind, path.basename(source)));
    entries.push({ from: source, to: target, kind: copy.kind });
  }
  const journalDir = path.join(output, MEDIA_DIR);
  await fs.mkdir(journalDir, { recursive: true });
  const journal: PhotoJournal = {
    version: 1,
    id: randomUUID().slice(0, 12),
    root,
    output,
    createdAt: new Date().toISOString(),
    status: 'applied',
    entries,
  };
  const file = path.join(journalDir, `journal-${journal.id}.json`);
  await fs.writeFile(file, JSON.stringify(journal, null, 2), 'utf8');
  return {
    journal: file,
    entries,
    summary: `Copied ${keep.length} selected and ${reject.length} rejected photo(s) to ${output}; originals were not changed.`,
  };
}

async function readJournal(file: string, context: { allowedDirs: string[] }): Promise<PhotoJournal> {
  const resolved = resolveAllowedPath(file, context.allowedDirs);
  if (path.basename(path.dirname(resolved)) !== MEDIA_DIR || path.extname(resolved) !== '.json') {
    throw new Error(`"${file}" is not a media journal.`);
  }
  const journal = JSON.parse(await fs.readFile(resolved, 'utf8')) as PhotoJournal;
  if (journal.version !== 1 || !Array.isArray(journal.entries) || !journal.output) throw new Error(`"${file}" is not a valid media journal.`);
  resolveAllowedPath(journal.output, context.allowedDirs);
  return journal;
}

async function undoPhotos(file: string, context: { allowedDirs: string[] }): Promise<{ summary: string; moved: number; backupDir: string }> {
  const journal = await readJournal(file, context);
  if (journal.status === 'undone') return { summary: 'This media plan was already undone.', moved: 0, backupDir: journal.output };
  const backupDir = path.join(journal.output, MEDIA_DIR, 'trash', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(backupDir, { recursive: true });
  let moved = 0;
  for (const entry of journal.entries) {
    const source = resolveAllowedPath(entry.to, context.allowedDirs);
    if (!fsSync.existsSync(source)) continue;
    const target = await uniquePath(path.join(backupDir, entry.kind, path.basename(source)));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    moved++;
  }
  journal.status = 'undone';
  await fs.writeFile(resolveAllowedPath(file, context.allowedDirs), JSON.stringify(journal, null, 2), 'utf8');
  return { summary: `Moved ${moved} output file(s) to ${backupDir}; nothing was deleted.`, moved, backupDir };
}

async function verifyPhotos(file: string, context: { allowedDirs: string[] }): Promise<{ ok: boolean; checked: number; missing: string[]; summary: string }> {
  const journal = await readJournal(file, context);
  const missing: string[] = [];
  let checked = 0;
  for (const entry of journal.entries) {
    const target = resolveAllowedPath(entry.to, context.allowedDirs);
    const original = resolveAllowedPath(entry.from, context.allowedDirs);
    checked++;
    if (journal.status === 'undone') {
      if (fsSync.existsSync(target)) missing.push(path.basename(target));
    } else if (!fsSync.existsSync(target) || !fsSync.existsSync(original)) {
      missing.push(path.basename(target));
    }
  }
  return {
    ok: missing.length === 0,
    checked,
    missing,
    summary: missing.length === 0 ? `Verified ${checked} file(s).` : `${missing.length} of ${checked} file(s) are missing.`,
  };
}

async function contactSheet(
  root: string,
  output: string,
  files: string[],
  columns: number,
  width: number,
  context: { allowedDirs: string[] },
  signal?: AbortSignal,
): Promise<{ path: string; summary: string }> {
  const tools = await detectMediaTools();
  requireTool(tools.ffmpeg, 'ffmpeg');
  const chosen = files.slice(0, 24).map((file) => resolveAllowedPath(file, context.allowedDirs, root));
  if (chosen.length === 0) throw new Error('No photos to show.');
  await fs.mkdir(output, { recursive: true });
  const list = path.join(output, MEDIA_DIR, `list-${Date.now()}.txt`);
  await fs.mkdir(path.dirname(list), { recursive: true });
  await fs.writeFile(
    list,
    chosen
      .map((file) => `file '${file.replaceAll("'", "'\\''").replaceAll('\\', '/')}'`)
      .join('\n'),
    'utf8',
  );
  const height = Math.round(width * 0.75);
  const rows = Math.ceil(chosen.length / columns);
  const target = path.join(output, 'contact-sheet.jpg');
  const result = await runMedia(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${columns}x${rows}`,
      '-frames:v',
      '1',
      '-y',
      target,
    ],
    { cwd: root, timeoutMs: 120_000, maxOutput: 2 * 1024 * 1024, ...(signal ? { signal } : {}) },
  );
  await fs.rm(list, { force: true });
  if (result.exitCode !== 0) throw new Error(`The contact sheet could not be made: ${result.output.trim() || `exit ${result.exitCode}`}`);
  return { path: target, summary: `Contact sheet saved to ${target}` };
}

export const mediaProbeTool = defineTool({
  name: 'media_probe',
  description:
    'Check for ffmpeg, ffprobe, ImageMagick and Python, and read metadata (size, dimensions, duration, codec, camera, date) of media files in a folder.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Folder; defaults to the working folder'),
    recursive: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  summarize: (input) => `Probe media in ${input.path ?? '.'}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    const tools = await detectMediaTools();
    const files = await walkImages(root, input.recursive === true, input.limit ?? 50);
    const probed = [];
    for (const file of files) {
      const base = await probeFile(root, file, tools);
      const [phashValue, blur] = await Promise.all([phash(file, tools), blurScore(file, tools)]);
      probed.push({ ...base, ...(phashValue ? { phash: phashValue } : {}), ...(blur !== undefined ? { blur } : {}) });
    }
    return JSON.stringify({ ok: true, root, tools, files: probed, summary: `${probed.length} media file(s).` }, null, 2);
  },
});

export const photoScanTool = defineTool({
  name: 'photo_scan',
  description:
    'Scan photos for duplicate groups (exact hash and perceptual dHash), blur scores, EXIF dates and camera, and select one sharp keeper per group. Reads only; originals are never changed. Vision scoring is optional and sampled within max_cost_usd.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Photo folder; defaults to the working folder'),
    recursive: z.boolean().optional(),
    max_files: z.number().int().min(1).max(MAX_FILES).optional(),
    blur_threshold: z.number().min(0).max(10_000).optional().describe('Sharpness below this is blurry (default 40)'),
    vision_samples: z.number().int().min(0).max(200).optional().describe('Optional vision samples (default 0)'),
    max_cost_usd: z.number().min(0).max(100).optional().describe('Vision cost cap (default 0)'),
  }),
  summarize: (input) => `Scan photos in ${input.path ?? '.'}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    const result = await scanPhotos(
      root,
      {
        recursive: input.recursive === true,
        maxFiles: input.max_files ?? DEFAULT_MAX_FILES,
        blurThreshold: input.blur_threshold ?? DEFAULT_BLUR_THRESHOLD,
        visionSamples: input.vision_samples ?? DEFAULT_VISION_SAMPLES,
        maxCostUsd: input.max_cost_usd ?? 0,
      },
      context.signal,
    );
    return JSON.stringify(result, null, 2);
  },
});

export const photoApplyTool = defineTool({
  name: 'photo_apply',
  description:
    'Copy selected and rejected photos into keep/ and reject/ folders under an output folder, with a journal for undo. Originals are read-only; nothing is moved or deleted.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Original photo folder'),
    output: z.string().min(1).describe('New output folder'),
    keep: z.array(z.string()).default([]),
    reject: z.array(z.string()).default([]),
  }),
  summarize: (input) => `Apply photo cull: ${input.keep.length} keep, ${input.reject.length} reject`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path, context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    const result = await applyPhotos(root, output, input.keep, input.reject, context);
    return JSON.stringify({ ok: true, ...result }, null, 2);
  },
});

export const photoUndoTool = defineTool({
  name: 'photo_undo',
  description: 'Undo a photo_apply: move the copied keep/reject output into the output journal trash. Originals are never touched.',
  risk: 'delete',
  target: 'pc',
  inputSchema: z.object({ journal: z.string().min(1) }),
  summarize: (input) => `Undo photo cull ${path.basename(input.journal)}`,
  async execute(input, context) {
    const result = await undoPhotos(input.journal, context);
    return JSON.stringify({ ok: true, ...result }, null, 2);
  },
});

export const photoVerifyTool = defineTool({
  name: 'photo_verify',
  description: 'Verify a photo_apply journal: every output file exists (or was moved to trash after undo) and every original still exists.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({ journal: z.string().min(1) }),
  summarize: (input) => `Verify photo cull ${path.basename(input.journal)}`,
  async execute(input, context) {
    const result = await verifyPhotos(input.journal, context);
    return JSON.stringify(result, null, 2);
  },
});

export const mediaContactSheetTool = defineTool({
  name: 'media_contact_sheet',
  description: 'Make a JPEG contact sheet (up to 24 photos) in an output folder, using ffmpeg.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional(),
    output: z.string().min(1),
    files: z.array(z.string()).min(1),
    columns: z.number().int().min(1).max(8).optional(),
    width: z.number().int().min(80).max(640).optional(),
  }),
  summarize: (input) => `Contact sheet for ${input.files.length} photo(s)`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    const result = await contactSheet(root, output, input.files, input.columns ?? 4, input.width ?? 240, context, context.signal);
    return JSON.stringify({ ok: true, ...result }, null, 2);
  },
});

export const mediaTransformTool = defineTool({
  name: 'media_transform',
  description:
    'Resize or convert images into a new output folder with ffmpeg; originals are never changed. Supports jpg, png, webp and other ffmpeg image formats.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional(),
    output: z.string().min(1),
    files: z.array(z.string()).optional(),
    width: z.number().int().min(16).max(8_000).optional(),
    height: z.number().int().min(16).max(8_000).optional(),
    format: z.enum(['jpg', 'jpeg', 'png', 'webp']).optional(),
    quality: z.number().int().min(1).max(31).optional(),
  }),
  summarize: (input) => `Transform media into ${input.output}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    const sourceFiles = input.files ?? (await walkImages(root, false, 300));
    await fs.mkdir(output, { recursive: true });
    const made: string[] = [];
    for (const requested of sourceFiles) {
      const source = resolveAllowedPath(requested, context.allowedDirs, root);
      const extension = input.format ? `.${input.format === 'jpeg' ? 'jpg' : input.format}` : path.extname(source);
      const target = await uniquePath(path.join(output, `${path.basename(source, path.extname(source))}${extension}`));
      const args = ['-v', 'error', '-i', source, '-frames:v', '1'];
      if (input.width || input.height) {
        args.push('-vf', `scale=${input.width ?? -2}:${input.height ?? -2}:force_original_aspect_ratio=decrease`);
      }
      if (input.quality) args.push('-q:v', String(input.quality));
      args.push('-y', target);
      const result = await runMedia('ffmpeg', args, {
        cwd: path.dirname(source),
        timeoutMs: 120_000,
        maxOutput: 1024 * 1024,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) throw new Error(`ffmpeg failed for ${path.basename(source)}: ${result.output.trim() || `exit ${result.exitCode}`}`);
      made.push(target);
    }
    return JSON.stringify({ ok: true, output, made, summary: `Wrote ${made.length} transformed image(s) to ${output}; originals were not changed.` }, null, 2);
  },
});

export const mediaMuxCoverTool = defineTool({
  name: 'media_mux_cover',
  description: 'Make an uploadable MP4 from an audio file and a cover image with ffmpeg. The source files are never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    audio: z.string().min(1),
    cover: z.string().min(1),
    output: z.string().min(1).describe('New .mp4 path'),
  }),
  summarize: (input) => `Mux ${path.basename(input.audio)} with cover`,
  async execute(input, context) {
    const audio = resolveAllowedPath(input.audio, context.allowedDirs);
    const cover = resolveAllowedPath(input.cover, context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const result = await runMedia(
      'ffmpeg',
      [
        '-v', 'error',
        '-loop', '1',
        '-i', cover,
        '-i', audio,
        '-c:v', 'libx264',
        '-tune', 'stillimage',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        '-y', output,
      ],
      { cwd: path.dirname(audio), timeoutMs: 300_000, maxOutput: 2 * 1024 * 1024, ...(context.signal ? { signal: context.signal } : {}) },
    );
    if (result.exitCode !== 0) throw new Error(`ffmpeg could not mux the cover: ${result.output.trim() || `exit ${result.exitCode}`}`);
    return JSON.stringify({ ok: true, output, summary: `Wrote ${output}` }, null, 2);
  },
});

export const mediaTrimTool = defineTool({
  name: 'media_trim',
  description:
    'Trim a video or audio file with ffmpeg (start + duration, in seconds). Set in_place to replace the source; the previous version is then kept as a .mimi-backup copy. Video becomes H.264/AAC MP4 when the output ends in .mp4/.mov; audio is copied or re-encoded.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source media file inside the allowed folders'),
    output: z.string().min(1).optional().describe('New file path (e.g. clips/intro.mp4); omit when in_place is true'),
    start_seconds: z.number().min(0).max(86_400).optional().describe('Default 0'),
    duration_seconds: z.number().positive().max(86_400).describe('How many seconds to keep'),
    reencode: z.boolean().optional().describe('Re-encode instead of stream copy (default true)'),
    in_place: z.boolean().optional().describe('Replace the source file instead of writing a new one'),
    backup: z.boolean().optional().describe('Keep <name>.mimi-backup<ext> when editing in place (default true)'),
  }),
  summarize: (input) => `Trim ${input.path} to ${input.duration_seconds}s → ${input.in_place ? 'in place' : input.output}`,
  async execute(input, context) {
    const target = resolveSingleOutput(input, context.allowedDirs);
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(target.output), { recursive: true });
    const start = input.start_seconds ?? 0;
    const video = /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(target.output);
    const atomic = atomicOutput(target, input.backup !== false);
    const args = ['-v', 'error', '-ss', String(start), '-i', target.source, '-t', String(input.duration_seconds)];
    if (input.reencode === false) args.push('-c', 'copy');
    else if (video) args.push('-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
    else args.push('-vn', '-c:a', 'aac');
    args.push('-y', atomic.writePath);
    let backup: string | undefined;
    try {
      const result = await runMedia('ffmpeg', args, {
        cwd: path.dirname(target.source),
        timeoutMs: 300_000,
        maxOutput: 1024 * 1024,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) throw new Error(`ffmpeg failed: ${result.output.trim() || `exit ${result.exitCode}`}`);
      backup = await atomic.commit();
    } catch (error) {
      await atomic.abort();
      throw error;
    }
    return JSON.stringify(
      {
        ok: true,
        source: target.source,
        output: target.output,
        in_place: target.inPlace,
        ...(backup ? { backup } : {}),
        start,
        duration: input.duration_seconds,
        summary: `Wrote ${target.output}`,
      },
      null,
      2,
    );
  },
});

export const imageCropTool = defineTool({
  name: 'image_crop',
  description:
    'Crop an image to a rectangle with ffmpeg. Set in_place to replace the source; the previous version is then kept as a .mimi-backup copy. Without in_place the source is never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source image inside the allowed folders'),
    output: z.string().min(1).optional().describe('New file path, e.g. cropped/photo.jpg; omit when in_place is true'),
    x: z.number().int().min(0).describe('Left edge in pixels'),
    y: z.number().int().min(0).describe('Top edge in pixels'),
    width: z.number().int().min(1).max(20_000),
    height: z.number().int().min(1).max(20_000),
    in_place: z.boolean().optional().describe('Replace the source file instead of writing a new one'),
    backup: z.boolean().optional().describe('Keep <name>.mimi-backup<ext> when editing in place (default true)'),
  }),
  summarize: (input) => `Crop ${path.basename(input.path)} to ${input.width}x${input.height}${input.in_place ? ' in place' : ''}`,
  async execute(input, context) {
    const target = resolveSingleOutput(input, context.allowedDirs);
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(target.output), { recursive: true });
    const atomic = atomicOutput(target, input.backup !== false);
    let backup: string | undefined;
    try {
      const result = await runMedia(
        'ffmpeg',
        ['-v', 'error', '-i', target.source, '-vf', `crop=${input.width}:${input.height}:${input.x}:${input.y}`, '-frames:v', '1', '-y', atomic.writePath],
        { cwd: path.dirname(target.source), timeoutMs: 120_000, maxOutput: 1024 * 1024, ...(context.signal ? { signal: context.signal } : {}) },
      );
      if (result.exitCode !== 0) throw new Error(`ffmpeg could not crop the image: ${result.output.trim() || `exit ${result.exitCode}`}`);
      backup = await atomic.commit();
    } catch (error) {
      await atomic.abort();
      throw error;
    }
    return JSON.stringify(
      {
        ok: true,
        source: target.source,
        output: target.output,
        in_place: target.inPlace,
        ...(backup ? { backup } : {}),
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        summary: `Wrote ${target.output}`,
      },
      null,
      2,
    );
  },
});

export const imageRotateTool = defineTool({
  name: 'image_rotate',
  description:
    'Rotate an image clockwise by any angle with ffmpeg. Set in_place to replace the source; the previous version is then kept as a .mimi-backup copy. Without in_place the source is never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source image inside the allowed folders'),
    output: z.string().min(1).optional().describe('New file path; omit when in_place is true'),
    degrees: z.number().min(-360).max(360).describe('Clockwise degrees; 90 / 180 / 270 keep the best quality'),
    background: z.string().optional().describe('Colour behind an arbitrary rotation (default black)'),
    in_place: z.boolean().optional().describe('Replace the source file instead of writing a new one'),
    backup: z.boolean().optional().describe('Keep <name>.mimi-backup<ext> when editing in place (default true)'),
  }),
  summarize: (input) => `Rotate ${path.basename(input.path)} by ${input.degrees}°${input.in_place ? ' in place' : ''}`,
  async execute(input, context) {
    const target = resolveSingleOutput(input, context.allowedDirs);
    if (input.degrees === 0) throw new Error('Nothing to rotate: give a non-zero angle.');
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(target.output), { recursive: true });
    const normalized = ((input.degrees % 360) + 360) % 360;
    const filter =
      normalized === 90
        ? 'transpose=1'
        : normalized === 180
          ? 'transpose=1,transpose=1'
          : normalized === 270
            ? 'transpose=2'
            : `rotate=${normalized}*PI/180:ow=rotw(${normalized}*PI/180):oh=roth(${normalized}*PI/180):c=${input.background?.trim() || 'black'}`;
    const atomic = atomicOutput(target, input.backup !== false);
    let backup: string | undefined;
    try {
      const result = await runMedia('ffmpeg', ['-v', 'error', '-i', target.source, '-vf', filter, '-frames:v', '1', '-y', atomic.writePath], {
        cwd: path.dirname(target.source),
        timeoutMs: 120_000,
        maxOutput: 1024 * 1024,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) throw new Error(`ffmpeg could not rotate the image: ${result.output.trim() || `exit ${result.exitCode}`}`);
      backup = await atomic.commit();
    } catch (error) {
      await atomic.abort();
      throw error;
    }
    return JSON.stringify(
      {
        ok: true,
        source: target.source,
        output: target.output,
        in_place: target.inPlace,
        ...(backup ? { backup } : {}),
        degrees: input.degrees,
        summary: `Wrote ${target.output}`,
      },
      null,
      2,
    );
  },
});

/** A path as the concat demuxer reads it: forward slashes, single quotes escaped. */
function concatLine(file: string): string {
  return `file '${path.resolve(file).replace(/\\/g, '/').replaceAll("'", "'\\''")}'`;
}

export const videoMergeTool = defineTool({
  name: 'video_merge',
  description:
    'Join videos into one file, in the order given, by stream copy (the inputs should share codecs, e.g. clips from the same phone). The source files are never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    files: z.array(z.string()).min(2).describe('Video paths inside the allowed folders, in order'),
    output: z.string().min(1).describe('New .mp4/.mov/.mkv path'),
  }),
  summarize: (input) => `Merge ${input.files.length} videos into ${input.output}`,
  async execute(input, context) {
    const sources = input.files.map((file) => resolveAllowedPath(file, context.allowedDirs));
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    if (sources.some((source) => source.toLowerCase() === output.toLowerCase())) throw new Error('The output must be a new file, not one of the sources.');
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const list = path.join(path.dirname(output), `.mimi-concat-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(list, `${sources.map(concatLine).join('\n')}\n`, 'utf8');
    try {
      const result = await runMedia('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', output], {
        cwd: path.dirname(output),
        timeoutMs: 600_000,
        maxOutput: 2 * 1024 * 1024,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `ffmpeg could not join the videos: ${result.output.trim() || `exit ${result.exitCode}`}. The clips probably use different codecs; re-encode or trim them to the same format first.`,
        );
      }
    } finally {
      await fs.rm(list, { force: true });
    }
    return JSON.stringify({ ok: true, output, sources, summary: `Merged ${sources.length} videos into ${output}.` }, null, 2);
  },
});

export const mediaSubtitleTool = defineTool({
  name: 'media_subtitle',
  description:
    'Add an SRT subtitle file to a video. mode "soft" (default) adds a track without re-encoding (MP4/mov_text); mode "burn" draws the text into the picture (re-encodes, works for MP4/MKV/MOV). Set in_place to replace the video; the previous version is then kept as a .mimi-backup copy.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    video: z.string().min(1).describe('Source video inside the allowed folders'),
    subtitles: z.string().min(1).describe('SRT file inside the allowed folders'),
    output: z.string().min(1).optional().describe('New video path; omit when in_place is true'),
    language: z.string().optional().describe('Soft track language tag, e.g. tha or eng (default und)'),
    mode: z.enum(['soft', 'burn']).optional().describe('Default soft (a track the viewer can switch off)'),
    in_place: z.boolean().optional().describe('Replace the source video instead of writing a new one'),
    backup: z.boolean().optional().describe('Keep <name>.mimi-backup<ext> when editing in place (default true)'),
  }),
  summarize: (input) =>
    `Add ${input.mode === 'burn' ? 'burned-in ' : ''}subtitles to ${path.basename(input.video)}${input.in_place ? ' in place' : ` -> ${input.output}`}`,
  async execute(input, context) {
    const target = resolveSingleOutput({ path: input.video, ...(input.output ? { output: input.output } : {}), ...(input.in_place ? { in_place: true } : {}) }, context.allowedDirs);
    const subtitles = resolveAllowedPath(input.subtitles, context.allowedDirs);
    const mode = input.mode ?? 'soft';
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(target.output), { recursive: true });
    const atomic = atomicOutput(target, input.backup !== false);
    const language = (input.language ?? 'und').trim() || 'und';
    let temporarySubtitle: string | undefined;
    let backup: string | undefined;
    try {
      let args: string[];
      if (mode === 'burn') {
        if (!/\.(mp4|mkv|mov)$/i.test(target.output)) throw new Error('Burning subtitles needs an .mp4, .mkv or .mov output.');
        temporarySubtitle = path.join(path.dirname(target.source), `.mimi-sub-${randomUUID()}.srt`);
        await fs.copyFile(subtitles, temporarySubtitle);
        args = [
          '-v', 'error',
          '-i', target.source,
          '-vf', `subtitles=${path.basename(temporarySubtitle)}`,
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-pix_fmt', 'yuv420p',
          ...(/\.(mp4|mov)$/i.test(target.output) ? ['-movflags', '+faststart'] : []),
          '-y', atomic.writePath,
        ];
      } else {
        if (!/\.mp4$/i.test(target.output)) throw new Error('A soft subtitle track needs an .mp4 output (mov_text). Use mode "burn" for other formats.');
        args = [
          '-v', 'error',
          '-i', target.source,
          '-i', subtitles,
          '-map', '0',
          '-map', '1',
          '-c', 'copy',
          '-c:s', 'mov_text',
          '-metadata:s:s:0', `language=${language}`,
          '-y', atomic.writePath,
        ];
      }
      const result = await runMedia('ffmpeg', args, {
        cwd: path.dirname(target.source),
        timeoutMs: 300_000,
        maxOutput: 2 * 1024 * 1024,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) throw new Error(`ffmpeg could not add the subtitles: ${result.output.trim() || `exit ${result.exitCode}`}`);
      backup = await atomic.commit();
    } catch (error) {
      await atomic.abort();
      throw error;
    } finally {
      if (temporarySubtitle) await fs.rm(temporarySubtitle, { force: true });
    }
    return JSON.stringify(
      {
        ok: true,
        video: target.source,
        subtitles,
        output: target.output,
        in_place: target.inPlace,
        ...(backup ? { backup } : {}),
        mode,
        ...(mode === 'soft' ? { language } : {}),
        summary: `Wrote ${target.output} with ${mode === 'burn' ? 'burned-in' : `a ${language}`} subtitles.`,
      },
      null,
      2,
    );
  },
});

export const mediaExtractAudioTool = defineTool({
  name: 'media_extract_audio',
  description:
    'Extract the audio track of a video or audio file into a new file with ffmpeg. The codec follows the output extension: .mp3, .m4a, .wav, .ogg or .opus. The source is never changed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Source media file inside the allowed folders'),
    output: z.string().min(1).describe('New audio path, e.g. audio/track.mp3'),
    bitrate: z.number().int().min(64).max(320).optional().describe('kbps for lossy outputs (default 192)'),
  }),
  summarize: (input) => `Extract audio from ${path.basename(input.path)} -> ${input.output}`,
  async execute(input, context) {
    const source = resolveAllowedPath(input.path, context.allowedDirs);
    const output = resolveAllowedPath(input.output, context.allowedDirs);
    if (output.toLowerCase() === source.toLowerCase()) throw new Error('The output must be a new file, not the source.');
    const extension = path.extname(output).toLowerCase();
    const codec =
      extension === '.mp3'
        ? ['-c:a', 'libmp3lame', '-b:a', `${input.bitrate ?? 192}k`]
        : extension === '.m4a' || extension === '.aac'
          ? ['-c:a', 'aac', '-b:a', `${input.bitrate ?? 192}k`]
          : extension === '.wav'
            ? ['-c:a', 'pcm_s16le']
            : extension === '.ogg' || extension === '.opus'
              ? ['-c:a', 'libopus', '-b:a', `${input.bitrate ?? 192}k`]
              : undefined;
    if (!codec) throw new Error('Choose an audio output ending in .mp3, .m4a, .wav, .ogg or .opus.');
    const tools = await detectMediaTools();
    requireTool(tools.ffmpeg, 'ffmpeg');
    await fs.mkdir(path.dirname(output), { recursive: true });
    const result = await runMedia('ffmpeg', ['-v', 'error', '-i', source, '-vn', ...codec, '-y', output], {
      cwd: path.dirname(source),
      timeoutMs: 300_000,
      maxOutput: 1024 * 1024,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`ffmpeg could not extract the audio: ${result.output.trim() || `exit ${result.exitCode}`}`);
    return JSON.stringify({ ok: true, source, output, codec: codec[1], summary: `Wrote ${output}` }, null, 2);
  },
});

export const mediaTools = [
  mediaProbeTool,
  photoScanTool,
  photoApplyTool,
  photoUndoTool,
  photoVerifyTool,
  mediaContactSheetTool,
  mediaTransformTool,
  mediaMuxCoverTool,
  mediaTrimTool,
  imageCropTool,
  imageRotateTool,
  videoMergeTool,
  mediaSubtitleTool,
  mediaExtractAudioTool,
];
