import { createHash, randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { runProcess, sanitizedEnv } from '../process.ts';
import { resolveAllowedPath } from './path-guard.ts';

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

export const mediaTools = [
  mediaProbeTool,
  photoScanTool,
  photoApplyTool,
  photoUndoTool,
  photoVerifyTool,
  mediaContactSheetTool,
  mediaTransformTool,
  mediaMuxCoverTool,
];
