import type { TaskPlanGroupView, TaskPlanView, TaskReceiptView, TaskVerificationView } from '@mimi/shared';
import { z } from 'zod';
import type { TaskRecipe } from './types.ts';
import { TaskStoppedError, parseToolJson } from './util.ts';

const inputSchema = z.object({
  path: z.string().min(1).describe('Photo folder'),
  output: z.string().optional().describe('New output folder (default: <path>/culled)'),
  recursive: z.boolean().optional(),
  blur_threshold: z.number().min(0).max(10_000).optional(),
  max_files: z.number().int().min(1).max(2_000).optional(),
  vision_samples: z.number().int().min(0).max(200).optional(),
  max_cost_usd: z.number().min(0).max(100).optional(),
});

type PhotoInput = z.infer<typeof inputSchema>;

interface PhotoFile {
  path: string;
  name: string;
  relative: string;
  size: number;
  width?: number;
  height?: number;
  blur?: number;
  createdAt?: string;
  camera?: string;
}

interface RejectedFile {
  path: string;
  reason: 'duplicate' | 'near-duplicate' | 'blurry' | 'vision';
  duplicateOf?: string;
}

interface ScanResult {
  ok: boolean;
  root: string;
  files: PhotoFile[];
  selected: PhotoFile[];
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

interface ApplyResult {
  ok: boolean;
  journal: string;
  summary: string;
}

interface VerifyResult {
  ok: boolean;
  checked: number;
  missing: string[];
  summary: string;
}

interface VisionScore {
  path: string;
  keep?: boolean;
  score?: number;
}

interface PhotoState {
  root?: string;
  output?: string;
  scan?: ScanResult;
  selected?: PhotoFile[];
  rejected?: RejectedFile[];
  preview?: string;
  previewError?: string;
  journal?: string;
  visionScores?: VisionScore[];
  visionError?: string;
}

function outputFor(state: PhotoState): string {
  return state.output ?? `${state.root}/culled`;
}

function planFor(state: PhotoState): TaskPlanView {
  const scan = state.scan!;
  const selected = state.selected ?? [];
  const rejected = state.rejected ?? [];
  const groups: TaskPlanGroupView[] = [];
  const push = (key: string, files: Array<{ path: string }>) => {
    if (files.length === 0) return;
    groups.push({ key, count: files.length, examples: files.slice(0, 5).map((file) => file.path.split(/[\\/]/).pop() ?? file.path) });
  };
  push('Selected', selected);
  push('Duplicates', rejected.filter((file) => file.reason === 'duplicate' || file.reason === 'near-duplicate'));
  push('Blurry', rejected.filter((file) => file.reason === 'blurry'));
  push('Vision rejects', rejected.filter((file) => file.reason === 'vision'));
  return {
    folder: scan.root,
    policy: 'rename',
    total: scan.files.length,
    groups,
    skipped: [],
  };
}

function parseScores(text: string): VisionScore[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        if (typeof item.path !== 'string') return null;
        return {
          path: item.path,
          ...(typeof item.keep === 'boolean' ? { keep: item.keep } : {}),
          ...(typeof item.score === 'number' ? { score: item.score } : {}),
        };
      })
      .filter((entry): entry is VisionScore => entry !== null);
  } catch {
    return [];
  }
}

function receiptFor(state: PhotoState, verification: TaskVerificationView): TaskReceiptView {
  const scan = state.scan!;
  const selected = state.selected ?? [];
  const rejected = state.rejected ?? [];
  const vision = scan.vision;
  return {
    summary: `Selected ${selected.length}, rejected ${rejected.length} of ${scan.files.length} photo(s) into ${outputFor(state)}; originals untouched. Vision ${vision.sampled}/${vision.requested} sample(s), $${vision.estimatedCostUsd} of $${vision.maxCostUsd}${verification.ok ? '' : '; verification failed'}.`,
    moved: selected.length,
    skipped: 0,
    failed: verification.ok ? 0 : 1,
    examples: selected.slice(0, 10).map((file) => file.name),
    ...(state.journal ? { journal: state.journal } : {}),
    undoable: Boolean(state.journal),
  };
}

/** Deterministic photo culling, with an optional sampled vision pass and a hard cost cap. */
export const photoCullRecipe: TaskRecipe<PhotoInput> = {
  name: 'photo-cull',
  description:
    'Scan photos for exact and near duplicates, blur and EXIF; preview a contact sheet; copy a keeper and the rejects into a new folder; verify and undo. Originals are read-only and vision scoring is sampled within max_cost_usd.',
  level: 'L3',
  inputSchema,
  interfaces: ['pc'],
  steps: [
    {
      id: 'scan',
      title: 'Scan photos',
      async run(context) {
        const state = context.state.data as unknown as PhotoState;
        state.root = context.input.path;
        state.output = context.input.output;
        const scan = parseToolJson<ScanResult>(
          await context.runPc('photo_scan', {
            path: context.input.path,
            ...(context.input.recursive ? { recursive: true } : {}),
            ...(context.input.blur_threshold !== undefined ? { blur_threshold: context.input.blur_threshold } : {}),
            ...(context.input.max_files !== undefined ? { max_files: context.input.max_files } : {}),
            vision_samples: context.input.vision_samples ?? 0,
            max_cost_usd: context.input.max_cost_usd ?? 0,
          }),
        );
        if (!scan.ok) throw new Error(scan.summary || 'The photo scan failed.');
        if (scan.files.length === 0) throw new Error(`No photos found in ${scan.root}.`);
        state.scan = scan;
        state.selected = [...scan.selected];
        state.rejected = [...scan.rejected];
        context.update({ plan: planFor(state) });
        return scan.summary;
      },
    },
    {
      id: 'confirm',
      title: 'Ask before copying photos',
      async run(context) {
        const state = context.state.data as unknown as PhotoState;
        const scan = state.scan!;
        const decision = await context.confirm({
          tool: 'photo_apply',
          risk: 'write',
          summary: `คัดรูป ${scan.files.length} รูปใน ${scan.root}: เก็บ ${(state.selected ?? []).length}, คัดออก ${(state.rejected ?? []).length} แล้วคัดลอกไป ${outputFor(state)} (ต้นฉบับไม่ถูกแก้ไข)`,
          input: {
            path: scan.root,
            output: outputFor(state),
            selected: (state.selected ?? []).length,
            rejected: (state.rejected ?? []).length,
            vision: scan.vision,
          },
        });
        if (!decision.allow) {
          throw new TaskStoppedError(
            decision.reason === 'timeout'
              ? 'The confirmation timed out; no photos were copied.'
              : 'The user did not approve copying the photos.',
          );
        }
        return 'Approved.';
      },
    },
    {
      id: 'vision',
      title: 'Optional vision scoring',
      async run(context) {
        const state = context.state.data as unknown as PhotoState;
        const scan = state.scan!;
        if (scan.vision.sampled === 0) return 'Vision scoring skipped (no samples or a zero cost cap).';
        if (scan.vision.estimatedCostUsd > scan.vision.maxCostUsd + 1e-9) {
          throw new Error(`The vision sample would cost $${scan.vision.estimatedCostUsd}, above the $${scan.vision.maxCostUsd} cap.`);
        }
        const sample = (state.selected ?? []).slice(0, scan.vision.sampled);
        if (sample.length === 0) return 'No selected photo to score.';
        const prompt = [
          'Score these photos for a keeper. Read each with read_document; do not edit anything.',
          ...sample.map((file) => `- ${file.path}`),
          'Reply with only a JSON array: [{"path":"...","keep":true,"score":0.0}] where score is 0-10.',
        ].join('\n');
        try {
          const answer = await context.runAgent(prompt, {
            tools: ['read_document'],
            maxRounds: Math.min(12, sample.length + 3),
          });
          const scores = parseScores(answer);
          state.visionScores = scores;
          if (scores.length === 0) {
            state.visionError = 'The vision reply was not a score array; deterministic cull kept the selection.';
          } else {
            const byPath = new Map(scores.map((score) => [score.path, score]));
            const kept: PhotoFile[] = [];
            for (const file of state.selected ?? []) {
              const score = byPath.get(file.path);
              if (score && score.keep === false) {
                state.rejected = [...(state.rejected ?? []), { path: file.path, reason: 'vision' }];
              } else {
                kept.push(file);
              }
            }
            state.selected = kept;
            context.update({ plan: planFor(state) });
          }
          return `Vision sampled ${sample.length} photo(s); ${scores.length} score(s) parsed.`;
        } catch (error) {
          state.visionError = (error as Error).message;
          return `Vision scoring skipped: ${state.visionError}`;
        }
      },
    },
    {
      id: 'preview',
      title: 'Make a contact sheet',
      async run(context) {
        const state = context.state.data as unknown as PhotoState;
        const selected = (state.selected ?? []).slice(0, 24);
        if (selected.length === 0) return 'No selected photo for a contact sheet.';
        try {
          const preview = parseToolJson<{ ok: boolean; path: string; summary: string }>(
            await context.runPc('media_contact_sheet', {
              path: state.root,
              output: `${outputFor(state)}/preview`,
              files: selected.map((file) => file.path),
              columns: 4,
              width: 240,
            }),
          );
          state.preview = preview.path;
          return preview.summary;
        } catch (error) {
          state.previewError = (error as Error).message;
          return `Contact sheet skipped: ${state.previewError}`;
        }
      },
    },
    {
      id: 'apply',
      title: 'Copy keepers and rejects',
      async run(context) {
        const state = context.state.data as unknown as PhotoState;
        const applied = parseToolJson<ApplyResult>(
          await context.runPc('photo_apply', {
            path: state.root,
            output: outputFor(state),
            keep: (state.selected ?? []).map((file) => file.path),
            reject: (state.rejected ?? []).map((file) => file.path),
          }),
        );
        state.journal = applied.journal;
        context.state.undo = {
          tool: 'photo_undo',
          input: { journal: applied.journal },
          verify: { tool: 'photo_verify', input: { journal: applied.journal } },
        };
        const verification: TaskVerificationView = { ok: true, summary: 'Waiting for verification.' };
        context.update({ receipt: receiptFor(state, verification) });
        return applied.summary;
      },
    },
    {
      id: 'verify',
      title: 'Verify the output',
      async run(context) {
        const state = context.state.data as unknown as PhotoState;
        if (!state.journal) throw new Error('The photo journal is missing.');
        const verified = parseToolJson<VerifyResult>(
          await context.runPc('photo_verify', { journal: state.journal }),
        );
        const verification: TaskVerificationView = { ok: verified.ok, summary: verified.summary };
        context.update({ verification });
        context.update({ receipt: receiptFor(state, verification) });
        if (!verified.ok) throw new Error(verified.summary);
        return verified.summary;
      },
    },
  ],
};
