import type { TaskReceiptView, TaskVerificationView } from '@mimi/shared';
import { z } from 'zod';
import type { TaskRecipe } from './types.ts';
import { TaskStoppedError, parseToolJson } from './util.ts';

const inputSchema = z.object({
  path: z.string().min(1).describe('Workspace folder to fix'),
  instructions: z.string().optional().describe('What the user asked for, in their words'),
  test_command: z.string().optional().describe('Override the detected test command'),
  max_rounds: z.number().int().min(2).max(40).optional().describe('Most agent rounds for the fix (default 20)'),
});

type DeveloperInput = z.infer<typeof inputSchema>;

interface WorkspaceInfoResult {
  ok: boolean;
  path: string;
  git: { repo: boolean; root?: string; initialized?: boolean; error?: string };
  status?: { branch?: string; clean: boolean; changes: string[] };
  files?: number;
  testCommand?: { command: string; source: string } | null;
  summary: string;
}

interface WorkspaceRunResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  summary: string;
}

interface CheckpointResult {
  ok: boolean;
  id: string;
  commit: string;
  path: string;
  summary: string;
}

interface DiffResult {
  ok: boolean;
  summary: string;
  clean: boolean;
  status: string[];
  untracked: string[];
  diff: string;
}

interface DeveloperState {
  root: string;
  testCommand: string;
  failure?: string;
  checkpoint?: string;
  changedFiles?: string[];
  fix?: string;
}

function truncate(text: string, limit = 12_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]` : text;
}

function changedNames(diff: DiffResult): string[] {
  const names = new Set<string>();
  for (const line of diff.status) {
    const name = line.slice(3).trim();
    if (name) names.add(name);
  }
  for (const name of diff.untracked) names.add(name);
  return [...names];
}

function receiptFor(state: DeveloperState, verification: TaskVerificationView): TaskReceiptView {
  const changed = state.changedFiles ?? [];
  return {
    summary: `Workspace ${state.root}: ${verification.ok ? 'tests pass' : 'tests still fail'}${changed.length > 0 ? `; ${changed.length} file(s) changed` : ''}. No commit or push was made.`,
    moved: 0,
    skipped: 0,
    failed: verification.ok ? 0 : 1,
    examples: changed.slice(0, 10),
    ...(state.checkpoint ? { journal: state.checkpoint } : {}),
    undoable: Boolean(state.checkpoint),
  };
}

/**
 * The developer task: inspect, reproduce, checkpoint, let an agent fix it with
 * workspace tools, run the tests again, show the diff and leave an undo point.
 * Commits, pushes and merges are blocked by workspace_run itself.
 */
export const developerRecipe: TaskRecipe<DeveloperInput> = {
  name: 'developer',
  description:
    'Inspect a git workspace, find and reproduce the failing test, checkpoint, fix it with an agent using workspace tools, run the tests, show the diff and leave an undo. Never commits, pushes or merges.',
  level: 'L3',
  inputSchema,
  interfaces: ['pc'],
  steps: [
    {
      id: 'inspect',
      title: 'Inspect the workspace',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const info = parseToolJson<WorkspaceInfoResult>(
          await context.runPc('workspace_info', { path: context.input.path }),
        );
        if (!info.ok) throw new Error(info.summary || 'The workspace could not be inspected.');
        if (info.git.error) throw new Error(info.git.error);
        state.root = info.path;
        const test = context.input.test_command?.trim() || info.testCommand?.command;
        if (!test) throw new Error('No test command was detected. Pass test_command or add a test script.');
        state.testCommand = test;
        const status = info.status ? (info.status.clean ? 'clean' : `${info.status.changes.length} change(s)`) : 'not a git repository';
        return `${info.path}: ${status}; test: ${test}`;
      },
    },
    {
      id: 'confirm',
      title: 'Ask before changing the workspace',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const decision = await context.confirm({
          tool: 'workspace_run',
          risk: 'shell',
          summary: `à¸•à¸£à¸§à¸ˆà¸ªà¸­à¸šà¹à¸¥à¸°à¹à¸à¹‰à¹‚à¸„à¹‰à¸”à¹ƒà¸™ ${state.root} à¹‚à¸”à¸¢à¸£à¸±à¸™ "${state.testCommand}", à¹à¸à¹‰à¹„à¸Ÿà¸¥à¹Œà¸—à¸µà¹ˆà¸ˆà¸³à¹€à¸›à¹‡à¸™ à¹à¸¥à¸°à¸£à¸±à¸™ diff (à¹„à¸¡à¹ˆ commit / à¹„à¸¡à¹ˆ push)`,
          input: { path: state.root, testCommand: state.testCommand },
        });
        if (!decision.allow) {
          throw new TaskStoppedError(
            decision.reason === 'timeout'
              ? 'The confirmation timed out; the workspace was not changed.'
              : 'The user did not approve changing the workspace.',
          );
        }
        return 'Approved.';
      },
    },
    {
      id: 'prepare',
      title: 'Prepare git and the test command',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const created = parseToolJson<WorkspaceInfoResult & { created?: boolean }>(
          await context.runPc('workspace_create', { path: state.root }),
        );
        if (!created.ok) throw new Error(created.summary || 'The workspace could not be prepared.');
        if (created.git.error) throw new Error(created.git.error);
        if (created.testCommand?.command && !context.input.test_command) state.testCommand = created.testCommand.command;
        return created.summary;
      },
    },
    {
      id: 'reproduce',
      title: 'Reproduce the failing test',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const run = parseToolJson<WorkspaceRunResult>(
          await context.runPc('workspace_run', { path: state.root, command: state.testCommand }),
        );
        if (run.ok) throw new Error('The tests already pass; there is nothing to fix.');
        state.failure = truncate(run.output);
        return run.summary;
      },
    },
    {
      id: 'checkpoint',
      title: 'Checkpoint before editing',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const saved = parseToolJson<CheckpointResult>(
          await context.runPc('workspace_checkpoint', { path: state.root, label: 'developer task' }),
        );
        if (!saved.ok) throw new Error(saved.summary || 'The checkpoint could not be saved.');
        state.checkpoint = saved.id;
        context.state.undo = {
          tool: 'workspace_undo',
          input: { path: state.root, checkpoint: saved.id },
          verify: { tool: 'workspace_diff', input: { path: state.root, checkpoint: saved.id, expect_clean: true } },
        };
        return saved.summary;
      },
    },
    {
      id: 'fix',
      title: 'Fix the failure with the developer agent',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const prompt = [
          `Fix the failing tests in the workspace at ${state.root}.`,
          `Test command: ${state.testCommand}`,
          '',
          'The tests currently fail with:',
          '```',
          state.failure ?? '(no output)',
          '```',
          '',
          context.input.instructions ? `What the user asked for: ${context.input.instructions}` : '',
          'Use the workspace tools. Read the relevant files before editing. Make the smallest change that makes the tests pass.',
          'Do not run git commit, push, merge, rebase or publish. Do not delete files. Run the tests before you finish.',
          'Reply with a short summary of what you changed.',
        ]
          .filter(Boolean)
          .join('\n');
        const answer = await context.runAgent(prompt, { maxRounds: context.input.max_rounds ?? 20 });
        state.fix = answer;
        return answer.slice(0, 2000);
      },
    },
    {
      id: 'verify',
      title: 'Run the tests again',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const run = parseToolJson<WorkspaceRunResult>(
          await context.runPc('workspace_run', { path: state.root, command: state.testCommand }),
        );
        const verification: TaskVerificationView = {
          ok: run.ok,
          summary: run.ok ? `Tests pass: ${state.testCommand}` : `Tests still fail (exit ${run.exitCode}): ${truncate(run.output, 3000)}`,
        };
        context.update({ verification });
        if (!run.ok) {
          context.update({ receipt: receiptFor(state, verification) });
          throw new Error(verification.summary);
        }
        return verification.summary;
      },
    },
    {
      id: 'diff',
      title: 'Show the diff',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        if (!state.checkpoint) throw new Error('No checkpoint was saved.');
        const diff = parseToolJson<DiffResult>(
          await context.runPc('workspace_diff', { path: state.root, checkpoint: state.checkpoint }),
        );
        state.changedFiles = changedNames(diff);
        if (diff.clean) return 'No files changed from the checkpoint.';
        return `${state.changedFiles.length} file(s) changed.\n${truncate(diff.diff.trim() || '(no textual diff)', 4_000)}`;
      },
    },
    {
      id: 'report',
      title: 'Report the result',
      async run(context) {
        const state = context.state.data as unknown as DeveloperState;
        const verification: TaskVerificationView =
          context.state.verification ?? { ok: false, summary: 'The tests were not verified.' };
        context.update({ receipt: receiptFor(state, verification) });
        return verification.summary;
      },
    },
  ],
};

