import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../db/db.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { createDefaultRecipes } from '../tasks/recipes.ts';
import { TaskRepo } from '../tasks/repo.ts';
import { TaskRunner } from '../tasks/runner.ts';
import { FakeBroker, collect, eventsOf } from './helpers.ts';

const BASE_NODES = [
  { ref: 'c0', role: 'Button', name: 'Add Account' },
  { ref: 'c1', role: 'Edit', name: 'Full Name' },
  { ref: 'c2', role: 'Edit', name: 'Email Address' },
  { ref: 'c3', role: 'Edit', name: 'Incoming Server' },
  { ref: 'c4', role: 'Edit', name: 'Outgoing Server' },
  { ref: 'c5', role: 'Edit', name: 'Password', secure: true },
  { ref: 'c6', role: 'Button', name: 'Test' },
  { ref: 'c7', role: 'Text', name: 'Connection successful' },
  { ref: 'c8', role: 'Button', name: 'Compose' },
];

const COMPOSE_NODES = [
  { ref: 'c20', role: 'Edit', name: 'To' },
  { ref: 'c21', role: 'Edit', name: 'Subject' },
  { ref: 'c22', role: 'Edit', name: 'Body' },
  { ref: 'c23', role: 'Button', name: 'Send' },
  { ref: 'c24', role: 'Text', name: 'Message sent' },
];

function fakeComputer() {
  let compose = false;
  let sent = false;
  const typed: Array<{ ref: string; text: string }> = [];
  const clicked: string[] = [];
  const execute = async (tool: string, input: any) => {
    switch (tool) {
      case 'computer_app':
        if (input.action === 'list') return JSON.stringify({ ok: true, apps: [{ name: 'Mail', active: true, windows: ['Inbox'] }] });
        return JSON.stringify({ ok: true });
      case 'computer_menu':
        return JSON.stringify({ ok: true });
      case 'computer_observe':
        return JSON.stringify({ ok: true, activeApp: 'Mail', nodes: compose ? [...BASE_NODES, ...COMPOSE_NODES] : BASE_NODES });
      case 'computer_type':
        typed.push({ ref: input.ref, text: input.text });
        return JSON.stringify({ ok: true });
      case 'computer_click':
        clicked.push(input.ref);
        if (input.ref === 'c8') compose = true;
        if (input.ref === 'c23') sent = true;
        return JSON.stringify({ ok: true });
      case 'computer_wait':
        return JSON.stringify({ ok: true, activeApp: 'Mail', nodes: sent ? COMPOSE_NODES : BASE_NODES });
      default:
        throw new Error(`Unexpected tool ${tool}`);
    }
  };
  return { execute, typed, clicked, isSent: () => sent };
}

function runnerFor(computer: ReturnType<typeof fakeComputer>) {
  const repo = new TaskRepo(openDb(':memory:'));
  const gate = new PermissionGate(new FakeBroker(true), { timeoutMs: 2_000 });
  const runner = new TaskRunner({
    repo,
    recipes: createDefaultRecipes(),
    gate,
    execute: async (tool, input) => computer.execute(tool, input),
  });
  return { repo, runner };
}

test('mail-pop3 recipe fills non-secret fields, hands off the password and sends a test mail', async () => {
  const computer = fakeComputer();
  const { runner, repo } = runnerFor(computer);
  const events = await collect(
    runner.run({
      recipe: 'mail-pop3',
      goal: 'set up POP3 mail',
      input: {
        app: 'apple-mail',
        email: 'alice@example.com',
        provider: 'gmail',
        display_name: 'Alice',
        test_recipient: 'alice@example.com',
      },
      traceId: 'mail-trace',
      thread: 'main',
      agent: 'mimi',
    }),
  );
  const finish = eventsOf(events, 'task-finish')[0]!;
  assert.equal(finish.status, 'completed', finish.receipt?.summary ?? '');
  assert.equal(eventsOf(events, 'permission-request').length, 3, 'control + password handoff + test mail');
  assert.equal(computer.typed.some((entry) => entry.ref === 'c5'), false, 'the password field was never typed');
  assert.equal(computer.typed.some((entry) => entry.text === 'pop.gmail.com'), true);
  assert.equal(computer.typed.some((entry) => entry.text === 'alice@example.com'), true);
  assert.equal(computer.isSent(), true);
  const receipt = eventsOf(events, 'task-receipt')[0]!;
  assert.match(receipt.receipt.summary, /password typed by the user/);
  assert.equal(repo.get(eventsOf(events, 'task-start')[0]!.task.id)!.status, 'completed');
});
