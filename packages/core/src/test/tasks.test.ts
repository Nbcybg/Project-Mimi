import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentEvent } from '@mimi/shared';
import { pcTools } from '@mimi/pc-agent';
import { z } from 'zod';
import { openDb } from '../db/db.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { createDefaultRecipes, RecipeRegistry } from '../tasks/recipes.ts';
import { TaskRepo } from '../tasks/repo.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { TaskStoppedError } from '../tasks/util.ts';
import { FakeBroker, collect, eventsOf } from './helpers.ts';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-tasks-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function folderWith(files: Record<string, string>): string {
  const folder = path.join(tmp, `case-${counter++}`);
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(folder, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return folder;
}

function toolsFor(folder: string) {
  return async (toolName: string, input: unknown, context: { traceId: string; thread: string; agent: string; taskId: string; signal?: AbortSignal }) => {
    const tool = pcTools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`No PC tool "${toolName}".`);
    return tool.execute(tool.inputSchema.parse(input), {
      traceId: context.traceId,
      thread: context.thread,
      agent: context.agent,
      taskId: context.taskId,
      ...(context.signal ? { signal: context.signal } : {}),
      allowedDirs: [folder],
    });
  };
}

function runnerFor(
  folder: string,
  broker: FakeBroker,
  recipes = createDefaultRecipes(),
  timeoutMs = 2_000,
  agentPermissions?: Record<string, 'allow' | 'ask' | 'deny'>,
) {
  const repo = new TaskRepo(openDb(':memory:'));
  const gate = new PermissionGate(broker, { timeoutMs });
  const runner = new TaskRunner({ repo, recipes, gate, execute: toolsFor(folder), agentPermissions: () => agentPermissions });
  return { repo, gate, runner };
}

test('file-organizer: preview, one approval, receipt, verification and undo', async () => {
  const folder = folderWith({ 'photo.jpg': 'image', 'report.pdf': 'document' });
  const broker = new FakeBroker(true);
  const { repo, runner } = runnerFor(folder, broker);
  const events = await collect(
    runner.run({
      recipe: 'file-organizer',
      goal: 'จัดระเบียบโฟลเดอร์',
      input: { folder },
      traceId: 'trace-1',
      thread: 'main',
      agent: 'mimi',
    }),
  );

  const start = eventsOf(events, 'task-start')[0]!;
  assert.equal(start.task.status, 'running');
  const planned = eventsOf(events, 'task-plan')[0]!;
  assert.equal(planned.plan.total, 2);
  assert.equal(eventsOf(events, 'permission-request').length, 1);
  assert.equal(broker.requests.length, 1);

  const finish = eventsOf(events, 'task-finish')[0]!;
  assert.equal(finish.status, 'completed');
  const receipt = eventsOf(events, 'task-receipt')[0]!;
  assert.equal(receipt.receipt.moved, 2);
  assert.equal(receipt.receipt.undoable, true);
  assert.equal(fs.readFileSync(path.join(folder, 'Images', 'photo.jpg'), 'utf8'), 'image');
  assert.equal(fs.readFileSync(path.join(folder, 'Documents', 'report.pdf'), 'utf8'), 'document');

  const stored = repo.get(start.task.id)!;
  assert.equal(stored.status, 'completed');
  assert.equal(stored.verification?.ok, true);
  assert.ok(stored.undo);

  const undoEvents = await collect(runner.undo(stored));
  assert.deepEqual(eventsOf(undoEvents, 'task-finish')[0]!.status, 'undone');
  assert.equal(eventsOf(undoEvents, 'task-receipt')[0]!.undo, true);
  assert.equal(fs.readFileSync(path.join(folder, 'photo.jpg'), 'utf8'), 'image');
  assert.equal(fs.readFileSync(path.join(folder, 'report.pdf'), 'utf8'), 'document');
  const undone = repo.get(start.task.id)!;
  assert.equal(undone.status, 'undone');
  assert.ok(undone.receipt, 'the original receipt is kept');
  assert.ok(undone.undoReceipt, 'the undo receipt is kept too');
});

test('file-organizer: an agent policy of allow skips the approval prompt', async () => {
  const folder = folderWith({ 'photo.jpg': 'image' });
  const broker = new FakeBroker(false);
  const { runner } = runnerFor(folder, broker, createDefaultRecipes(), 2_000, { organize_files: 'allow' });
  const events = await collect(
    runner.run({ recipe: 'file-organizer', goal: 'organize', input: { folder }, traceId: 'trace-policy', thread: 'main', agent: 'mimi' }),
  );
  assert.equal(eventsOf(events, 'permission-request').length, 0);
  assert.equal(broker.requests.length, 0);
  assert.equal(eventsOf(events, 'task-finish')[0]!.status, 'completed');
  assert.equal(fs.existsSync(path.join(folder, 'Images', 'photo.jpg')), true);
});

test('file-organizer: an agent policy of deny refuses without asking', async () => {
  const folder = folderWith({ 'photo.jpg': 'image' });
  const broker = new FakeBroker(true);
  const { runner } = runnerFor(folder, broker, createDefaultRecipes(), 2_000, { organize_files: 'deny' });
  const events = await collect(
    runner.run({ recipe: 'file-organizer', goal: 'organize', input: { folder }, traceId: 'trace-deny', thread: 'main', agent: 'mimi' }),
  );
  assert.equal(eventsOf(events, 'permission-request').length, 0);
  assert.equal(broker.requests.length, 0);
  assert.notEqual(eventsOf(events, 'task-finish')[0]!.status, 'completed');
  assert.equal(fs.existsSync(path.join(folder, 'Images', 'photo.jpg')), false);
});

test('file-organizer: a refusal cancels the task and moves nothing', async () => {
  const folder = folderWith({ 'photo.jpg': 'image' });
  const { runner } = runnerFor(folder, new FakeBroker(false));
  const events = await collect(
    runner.run({
      recipe: 'file-organizer',
      goal: 'organize',
      input: { folder },
      traceId: 'trace-2',
      thread: 'main',
      agent: 'mimi',
    }),
  );
  assert.equal(eventsOf(events, 'task-finish')[0]!.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(folder, 'photo.jpg')), true);
  assert.equal(fs.existsSync(path.join(folder, 'Images')), false);
});

test('cancelling while the confirmation is open ends the task promptly', async () => {
  const folder = folderWith({ 'photo.jpg': 'image' });
  const broker = new FakeBroker('never');
  const { runner } = runnerFor(folder, broker, createDefaultRecipes(), 60_000);
  const iterator = runner.run({
    recipe: 'file-organizer',
    goal: 'organize',
    input: { folder },
    traceId: 'trace-3',
    thread: 'main',
    agent: 'mimi',
  });

  const seen: AgentEvent[] = [];
  let next = await iterator.next();
  while (!next.done) {
    seen.push(next.value);
    if (next.value.type === 'permission-request') break;
    next = await iterator.next();
  }
  const start = seen.find((event): event is Extract<AgentEvent, { type: 'task-start' }> => event.type === 'task-start')!;
  assert.ok(seen.some((event) => event.type === 'permission-request'));
  assert.equal(runner.control(start.task.id, 'cancel'), true);

  while (!next.done) {
    next = await iterator.next();
    if (!next.done) seen.push(next.value);
  }
  const finish = seen.find((event): event is Extract<AgentEvent, { type: 'task-finish' }> => event.type === 'task-finish')!;
  assert.equal(finish.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(folder, 'photo.jpg')), true);
});

test('pause between steps holds the task until resumed', async () => {
  let release: () => void = () => {};
  const blocking = new Promise<void>((resolve) => {
    release = resolve;
  });
  let secondRan = false;
  const recipes = new RecipeRegistry().register({
    name: 'blocking',
    description: 'test recipe',
    level: 'L1',
    interfaces: [],
    inputSchema: z.object({}),
    steps: [
      {
        id: 'first',
        title: 'First',
        async run(context) {
          await Promise.race([
            blocking,
            new Promise<never>((_, reject) => {
              context.signal?.addEventListener('abort', () => reject(new TaskStoppedError('stopped')), { once: true });
            }),
          ]);
        },
      },
      {
        id: 'second',
        title: 'Second',
        async run(context) {
          secondRan = true;
          context.update({ verification: { ok: true, summary: 'done' } });
        },
      },
    ],
  });
  const folder = folderWith({});
  const { runner } = runnerFor(folder, new FakeBroker(true), recipes);
  const iterator = runner.run({
    recipe: 'blocking',
    goal: 'pause me',
    input: {},
    traceId: 'trace-4',
    thread: 'main',
    agent: 'mimi',
  });

  const seen: AgentEvent[] = [];
  let next = await iterator.next();
  assert.equal(next.done, false);
  if (!next.done) seen.push(next.value);
  next = await iterator.next();
  if (!next.done) seen.push(next.value);
  const start = seen.find((event): event is Extract<AgentEvent, { type: 'task-start' }> => event.type === 'task-start')!;
  assert.equal(runner.control(start.task.id, 'pause'), true);
  release();

  let paused = false;
  for (let i = 0; i < 12 && !paused; i++) {
    next = await iterator.next();
    if (next.done) break;
    seen.push(next.value);
    if (next.value.type === 'task-update' && next.value.task.status === 'paused') paused = true;
  }
  assert.equal(paused, true);
  assert.equal(secondRan, false);
  assert.equal(runner.control(start.task.id, 'resume'), true);
  while (!next.done) {
    next = await iterator.next();
    if (!next.done) seen.push(next.value);
  }
  assert.equal(secondRan, true);
  const finish = seen.find((event): event is Extract<AgentEvent, { type: 'task-finish' }> => event.type === 'task-finish')!;
  assert.equal(finish.status, 'completed');
});
