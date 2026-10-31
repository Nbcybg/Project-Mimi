import type { TaskView } from '@mimi/shared';
import { z } from 'zod';
import { defineTool } from '../tools/registry.ts';
import type { TaskRepo } from './repo.ts';
import type { TaskRunner } from './runner.ts';

export interface TaskToolDeps {
  runner: TaskRunner;
  repo: TaskRepo;
  /** The chat a thread belongs to, so the task card lands in the right conversation. */
  chatIdForThread?: (thread: string) => number | undefined;
}

function taskSummary(task: TaskView): string {
  const lines = [`Task ${task.id} · ${task.recipe} · ${task.level} · ${task.status}`];
  if (task.plan) {
    const groups = task.plan.groups.map((group) => `${group.key}: ${group.count}`).join(', ');
    lines.push(`Plan: ${task.plan.total} file(s)${groups ? ` (${groups})` : ''}.`);
    if (task.plan.deferred) lines.push(`${task.plan.deferred} file(s) were left for a later run.`);
  }
  if (task.receipt) lines.push(`Receipt: ${task.receipt.summary}`);
  if (task.undoReceipt) lines.push(`Undo: ${task.undoReceipt.summary}`);
  if (task.verification) lines.push(`Verification: ${task.verification.ok ? 'passed' : 'failed'} — ${task.verification.summary}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.receipt?.undoable) lines.push('The receipt in the chat has an undo button.');
  return lines.join('\n');
}

/** Tools the model uses to start and undo a recipe task. The recipe's gates do the asking. */
export function createTaskTools(deps: TaskToolDeps) {
  const run = defineTool({
    name: 'task_run',
    description:
      'Run a task recipe on the user\'s computer. "file-organizer" previews and organizes a folder\'s top-level files into type folders. "developer" inspects a git workspace, reproduces a failing test, checkpoints, fixes it with a developer agent, reruns the tests, shows the diff and leaves an undo. "photo-cull" finds duplicates/blurry photos, shows a plan, optionally samples vision within a cost cap, copies keepers/rejects to a new folder and leaves an undo. "youtube-upload" validates a local video, hands login/2FA/CAPTCHA to the user, uploads it with metadata, asks again before a public publish and verifies the URL. Never commit, push or merge. Provide the folder or file path; never guess a path the user did not name.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      recipe: z.string().min(1).describe('Recipe name: "file-organizer", "developer", "photo-cull" or "youtube-upload"'),
      goal: z.string().optional().describe('What the user asked for, in their words'),
      folder: z.string().optional().describe('File-organizer: the folder to organize'),
      path: z.string().optional().describe('Developer/photo-cull/youtube-upload: workspace, photo folder or file'),
      output: z.string().optional().describe('Photo-cull/youtube-upload: output folder or muxed file'),
      title: z.string().max(100).optional().describe('YouTube: video title'),
      description: z.string().max(5_000).optional().describe('YouTube: video description'),
      visibility: z.enum(['private', 'unlisted', 'public']).optional().describe('YouTube: visibility (default unlisted)'),
      made_for_kids: z.boolean().optional().describe('YouTube: audience'),
      tags: z.array(z.string().max(100)).max(30).optional().describe('YouTube: tags'),
      audio_only: z.boolean().optional().describe('YouTube: mux audio with a cover'),
      cover: z.string().optional().describe('YouTube: cover image for audio_only'),
      instructions: z.string().optional().describe('Developer: what the user asked for'),
      test_command: z.string().optional().describe('Developer: override the detected test command'),
      policy: z.enum(['rename', 'skip', 'overwrite']).optional().describe('File-organizer: conflict policy (default rename)'),
      max_files: z.number().int().min(1).max(2_000).optional().describe('File-organizer/photo-cull: files per run'),
      max_rounds: z.number().int().min(2).max(40).optional().describe('Developer: most agent rounds for the fix'),
      blur_threshold: z.number().min(0).max(10_000).optional().describe('Photo-cull: sharpness below this is blurry'),
      vision_samples: z.number().int().min(0).max(200).optional().describe('Photo-cull: optional vision samples'),
      max_cost_usd: z.number().min(0).max(100).optional().describe('Photo-cull: vision cost cap'),
      input: z.record(z.string(), z.unknown()).optional().describe('Recipe input for other recipes'),
    }),
    summarize: (input) => `Start ${input.recipe}${input.folder ?? input.path ? ` in ${input.folder ?? input.path}` : ''}`,
    async execute(input, context) {
      if (!deps.runner.recipe(input.recipe)) {
        throw new Error(`Unknown task recipe "${input.recipe}". Use task_run only with an available recipe.`);
      }
      const recipeInput =
        input.input ??
        ({
          ...(input.folder ? { folder: input.folder } : {}),
          ...(input.path ? { path: input.path } : {}),
          ...(input.output ? { output: input.output } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.made_for_kids !== undefined ? { made_for_kids: input.made_for_kids } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          ...(input.audio_only !== undefined ? { audio_only: input.audio_only } : {}),
          ...(input.cover ? { cover: input.cover } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...(input.test_command ? { test_command: input.test_command } : {}),
          ...(input.max_rounds ? { max_rounds: input.max_rounds } : {}),
          ...(input.blur_threshold !== undefined ? { blur_threshold: input.blur_threshold } : {}),
          ...(input.vision_samples !== undefined ? { vision_samples: input.vision_samples } : {}),
          ...(input.max_cost_usd !== undefined ? { max_cost_usd: input.max_cost_usd } : {}),
          ...(input.policy ? { policy: input.policy } : {}),
          ...(input.max_files ? { max_files: input.max_files } : {}),
        } as Record<string, unknown>);
      if (Object.keys(recipeInput).length === 0) throw new Error('This task recipe needs an input.');

      const chatId = deps.chatIdForThread?.(context.thread);
      const generator = deps.runner.run({
        recipe: input.recipe,
        goal: input.goal?.trim() || `${input.recipe}${input.folder ? `: ${input.folder}` : ''}`,
        input: recipeInput,
        traceId: context.traceId,
        thread: context.thread,
        agent: context.agent,
        ...(chatId !== undefined ? { chatId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });

      let next = await generator.next();
      while (!next.done) {
        context.emit?.(next.value);
        next = await generator.next();
      }
      return taskSummary(next.value);
    },
  });

  const undo = defineTool({
    name: 'task_undo',
    description:
      'Undo a finished task from its receipt: restore every file the task moved. Only use it when the user asks to undo that task.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      task_id: z.string().min(1).describe('The task id shown in the receipt'),
    }),
    summarize: (input) => `Undo task ${input.task_id}`,
    async execute(input, context) {
      const task = deps.repo.get(input.task_id);
      if (!task) throw new Error(`No task "${input.task_id}".`);
      const generator = deps.runner.undo(task, {
        traceId: context.traceId,
        thread: context.thread,
        agent: context.agent,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      let next = await generator.next();
      while (!next.done) {
        context.emit?.(next.value);
        next = await generator.next();
      }
      return taskSummary(next.value);
    },
  });

  return [run, undo];
}
