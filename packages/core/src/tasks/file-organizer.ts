import type { TaskReceiptView } from '@mimi/shared';
import { z } from 'zod';
import type { TaskRecipe } from './types.ts';
import { TaskStoppedError, parseToolJson, planFrom, receiptFrom, verificationFrom } from './util.ts';

const inputSchema = z.object({
  folder: z.string().min(1).describe('The folder whose top-level files should be organized'),
  policy: z.enum(['rename', 'skip', 'overwrite']).optional().describe('What to do when a destination name exists; default rename'),
  max_files: z.number().int().min(1).max(2_000).optional().describe('Files per run; default 500'),
});

type FileOrganizerInput = z.infer<typeof inputSchema>;

interface OrganizerPlanResult {
  ok: boolean;
  summary: string;
  folder: string;
  journal: string;
  policy: 'rename' | 'skip' | 'overwrite';
  total: number;
  deferred?: number;
  groups: Array<{ key: string; count: number; examples: string[] }>;
  skipped: Array<{ name: string; reason: string }>;
}

interface OrganizerApplyResult {
  ok: boolean;
  summary: string;
  journal: string;
  moved: number;
  skipped: number;
  failed: number;
  examples: string[];
  deferred?: number;
}

interface OrganizerVerifyResult {
  ok: boolean;
  summary: string;
  checked: number;
  missing: string[];
}

interface OrganizerState {
  journal?: string;
  empty?: boolean;
}

/**
 * Sprint 1's proof recipe: a safe file task with a preview, one confirmation, a
 * receipt and an undo path. Originals are never deleted; only moved.
 */
export const fileOrganizerRecipe: TaskRecipe<FileOrganizerInput> = {
  name: 'file-organizer',
  description:
    'Organizes the top-level files of a folder into type folders (Images, Documents, Audio, Video, Archives, Code, Installers, Other). Shows a plan first, asks once, applies, verifies and leaves an undo receipt.',
  level: 'L3',
  inputSchema,
  interfaces: ['pc'],
  resumable: true,
  steps: [
    {
      id: 'plan',
      title: 'Scan and plan',
      async run(context) {
        const state = context.state.data as OrganizerState;
        const raw = await context.runPc('organize_files', {
          folder: context.input.folder,
          dry_run: true,
          policy: context.input.policy ?? 'rename',
          max_files: context.input.max_files ?? 500,
        });
        const result = parseToolJson<OrganizerPlanResult>(raw);
        if (result.ok !== true) throw new Error(result.summary || 'The organizer could not plan this folder.');
        if (!result.journal) throw new Error('The organizer did not return a plan journal.');
        state.journal = result.journal;
        state.empty = result.total === 0;
        context.update({ plan: planFrom(result) });
        return result.summary;
      },
    },
    {
      id: 'confirm',
      title: 'Ask for confirmation',
      async run(context) {
        const state = context.state.data as OrganizerState;
        if (state.empty) return 'Nothing to move.';
        const plan = context.state.plan;
        if (!plan) throw new Error('The organizer plan is missing.');
        const decision = await context.confirm({
          tool: 'organize_files',
          risk: 'write',
          summary: `ย้าย ${plan.total} ไฟล์ใน ${plan.folder} ไปโฟลเดอร์ย่อยตามชนิดไฟล์ (นโยบายเมื่อชื่อซ้ำ: ${plan.policy})`,
          input: {
            folder: plan.folder,
            total: plan.total,
            deferred: plan.deferred ?? 0,
            policy: plan.policy,
          },
        });
        if (!decision.allow) {
          throw new TaskStoppedError(
            decision.reason === 'timeout'
              ? 'The confirmation timed out; no files were moved.'
              : 'The user did not approve moving the files.',
          );
        }
        return 'Approved.';
      },
    },
    {
      id: 'apply',
      title: 'Move the files',
      async run(context) {
        const state = context.state.data as OrganizerState;
        if (state.empty) {
          const receipt: TaskReceiptView = {
            summary: 'No files needed moving.',
            moved: 0,
            skipped: 0,
            failed: 0,
            examples: [],
            undoable: false,
          };
          context.update({ receipt });
          return receipt.summary;
        }
        if (!state.journal) throw new Error('The organizer plan journal is missing.');
        const raw = await context.runPc('organize_files', { journal: state.journal, dry_run: false });
        const result = parseToolJson<OrganizerApplyResult>(raw);
        const receipt = receiptFrom({ ...result, journal: state.journal });
        context.update({ receipt });
        context.state.undo = {
          tool: 'undo_organize',
          input: { journal: state.journal },
          verify: { tool: 'organize_files', input: { journal: state.journal, verify: true } },
        };
        if (result.failed > 0) throw new Error(result.summary || 'Some files could not be moved.');
        return result.summary;
      },
    },
    {
      id: 'verify',
      title: 'Verify the result',
      async run(context) {
        const state = context.state.data as OrganizerState;
        if (state.empty) {
          const verification = { ok: true, summary: 'No files to move.' };
          context.update({ verification });
          return verification.summary;
        }
        if (!state.journal) throw new Error('The organizer plan journal is missing.');
        const raw = await context.runPc('organize_files', { journal: state.journal, verify: true });
        const result = parseToolJson<OrganizerVerifyResult>(raw);
        const verification = verificationFrom(result);
        context.update({ verification });
        if (!verification.ok) throw new Error(result.summary || 'The organizer could not verify the moved files.');
        return result.summary;
      },
    },
  ],
};
