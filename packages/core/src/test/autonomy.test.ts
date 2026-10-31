import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent } from '@mimi/shared';
import { z } from 'zod';
import { openDb } from '../db/db.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { RecipeRegistry } from '../tasks/recipes.ts';
import { TaskRepo } from '../tasks/repo.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { createTaskTools } from '../tasks/tools.ts';
import { TaskStoppedError } from '../tasks/util.ts';
import { FakeBroker, collect, eventsOf } from './helpers.ts';

function tinyRecipe(name: string, resumable = false) {
  return {
    name,
    description: 'test',
    level: 'L3' as const,
    interfaces: [],
    resumable,
    inputSchema: z.object({}),
    steps: [
      {
        id: 'one',
        title: 'One',
        async run(context: any) {
          context.update({
            verification: { ok: true, summary: 'done' },
            receipt: { summary: 'test receipt', moved: 0, skipped: 0, failed: 0, examples: [], undoable: false },
          });
        },
      },
    ],
  };
}

function runnerFor(repo: TaskRepo, recipe: ReturnType<typeof tinyRecipe>, notify?: (task: any) => void) {
  const registry = new RecipeRegistry().register(recipe);
  return new TaskRunner({
    repo,
    recipes: registry,
    gate: new PermissionGate(new FakeBroker(true), { timeoutMs: 1_000 }),
    execute: async () => '',
    ...(notify ? { notify } : {}),
  });
}

test('interrupted tasks are marked paused and audit rows export as JSONL', () => {
  const repo = new TaskRepo(openDb(':memory:'));
  const task = repo.create({
    goal: 'organize',
    recipe: 'file-organizer',
    level: 'L3',
    agent: 'mimi',
    traceId: 't',
    thread: 'main',
    input: { folder: 'x' },
    steps: [{ id: 'one', title: 'One' }],
  });
  assert.equal(task.status, 'running');
  assert.equal(repo.markInterrupted(), 1);
  const paused = repo.get(task.id)!;
  assert.equal(paused.status, 'paused');
  assert.match(paused.error ?? '', /Interrupted/);
  const jsonl = repo.exportJsonl({ thread: 'main' });
  const row = JSON.parse(jsonl) as Record<string, unknown>;
  assert.equal(row.id, task.id);
  assert.equal('undo' in row, false);
});

test('a background task notifies when it finishes', async () => {
  const repo = new TaskRepo(openDb(':memory:'));
  const notified: string[] = [];
  const runner = runnerFor(repo, tinyRecipe('tiny'), (task) => notified.push(task.id));
  const events = await collect(
    runner.run({
      recipe: 'tiny',
      goal: 'notify me',
      input: {},
      traceId: 't',
      thread: 'main',
      agent: 'mimi',
      notify: true,
    }),
  );
  assert.equal(eventsOf(events, 'task-finish')[0]!.status, 'completed');
  assert.equal(notified.length, 1);
  assert.equal(notified[0], eventsOf(events, 'task-start')[0]!.task.id);
});

test('a paused resumable task resumes as a new task and keeps the old one for audit', async () => {
  const repo = new TaskRepo(openDb(':memory:'));
  const runner = runnerFor(repo, tinyRecipe('tiny', true));
  const old = repo.create({
    goal: 'old goal',
    recipe: 'tiny',
    level: 'L3',
    agent: 'mimi',
    traceId: 't',
    thread: 'main',
    input: {},
    steps: [{ id: 'one', title: 'One' }],
  });
  old.status = 'paused';
  repo.save(old);
  const events = await collect(runner.resumeTask(old.id));
  const start = eventsOf(events, 'task-start')[0]!;
  assert.notEqual(start.task.id, old.id);
  assert.equal(eventsOf(events, 'task-finish')[0]!.status, 'completed');
  assert.equal(repo.get(start.task.id)!.status, 'completed');
  assert.equal(repo.get(old.id)!.status, 'cancelled');
  assert.match(repo.get(old.id)!.error ?? '', /Resumed as task/);
});

test('the kill switch stops every running task', async () => {
  const repo = new TaskRepo(openDb(':memory:'));
  const registry = new RecipeRegistry().register({
    name: 'hold',
    description: 'test',
    level: 'L3',
    interfaces: [],
    inputSchema: z.object({}),
    steps: [
      {
        id: 'wait',
        title: 'Wait',
        async run(context: any) {
          await new Promise<never>((_, reject) => {
            context.signal?.addEventListener('abort', () => reject(new TaskStoppedError('stopped')), { once: true });
          });
        },
      },
    ],
  });
  const runner = new TaskRunner({
    repo,
    recipes: registry,
    gate: new PermissionGate(new FakeBroker(true), { timeoutMs: 1_000 }),
    execute: async () => '',
  });
  const iterator = runner.run({ recipe: 'hold', goal: 'hold', input: {}, traceId: 't', thread: 'main', agent: 'mimi' });
  const first = await iterator.next();
  assert.equal(first.done, false);
  await iterator.next(); // the step is now waiting
  assert.equal(runner.cancelAll(), 1);
  const rest: AgentEvent[] = [];
  let next = await iterator.next();
  while (!next.done) {
    rest.push(next.value);
    next = await iterator.next();
  }
  const finish = rest.find((event): event is Extract<AgentEvent, { type: 'task-finish' }> => event.type === 'task-finish');
  assert.equal(finish?.status, 'cancelled');
});

test('task_run background mode is opt-in', async () => {
  const repo = new TaskRepo(openDb(':memory:'));
  const runner = runnerFor(repo, tinyRecipe('tiny'));
  const tools = createTaskTools({ runner, repo });
  const run = tools.find((tool) => tool.name === 'task_run')!;
  const previous = process.env.MIMI_ALLOW_BACKGROUND_TASKS;
  delete process.env.MIMI_ALLOW_BACKGROUND_TASKS;
  try {
    await assert.rejects(
      run.execute(
        { recipe: 'tiny', background: true } as never,
        { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] },
      ),
      /opt-in/,
    );
  } finally {
    if (previous === undefined) delete process.env.MIMI_ALLOW_BACKGROUND_TASKS;
    else process.env.MIMI_ALLOW_BACKGROUND_TASKS = previous;
  }
});
