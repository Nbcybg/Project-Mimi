import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeTestCore } from './core-helpers.ts';
import { collect, eventsOf, scriptedModel, textStep, toolStep } from './helpers.ts';

function sampleWorkspace(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(dir, 'value.js'), 'module.exports = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'test.js'),
    "const value = require('./value.js');\nif (value !== 42) { console.error('expected 42, got ' + value); process.exit(1); }\nconsole.log('ok');\n",
  );
}

test('developer recipe: reproduce, checkpoint, fix with an agent, verify, diff and undo', async () => {
  const target = await makeTestCore({
    models: {
      // The nested developer agent sees the workspace relative to the allowed folder.
      mimi: scriptedModel([
        toolStep('edit_file', {
          path: 'developer-repo/value.js',
          old_string: 'module.exports = 1;',
          new_string: 'module.exports = 42;',
        }),
        textStep('I changed value.js from 1 to 42.'),
      ]),
    },
  });
  try {
    const workspace = path.join(target.config.allowedDirs[0]!, 'developer-repo');
    sampleWorkspace(workspace);

    const events = await collect(
      target.core.taskRunner.run({
        recipe: 'developer',
        goal: 'fix the failing test',
        input: { path: 'developer-repo', test_command: 'node test.js' },
        traceId: 'developer-trace',
        thread: 'main',
        agent: 'mimi',
      }),
    );

    const start = eventsOf(events, 'task-start')[0]!;
    const titles = eventsOf(events, 'task-step').map((event) => event.step.title).join('\n');
    assert.match(titles, /Inspect/);
    assert.match(titles, /Reproduce/);
    assert.match(titles, /Checkpoint/);
    assert.match(titles, /Fix/);
    assert.match(titles, /Run the tests again/);
    assert.match(titles, /Show the diff/);
    assert.ok(eventsOf(events, 'permission-request').length > 0);

    const finish = eventsOf(events, 'task-finish')[0]!;
    assert.equal(finish.status, 'completed', finish.receipt?.summary ?? '');
    const receipt = eventsOf(events, 'task-receipt')[0]!;
    assert.equal(receipt.receipt.undoable, true);
    assert.match(receipt.receipt.summary, /tests pass/);
    assert.equal(fs.readFileSync(path.join(workspace, 'value.js'), 'utf8').replace(/\r\n/g, '\n'), 'module.exports = 42;\n');

    const stored = target.core.tasks.get(start.task.id)!;
    assert.equal(stored.status, 'completed');
    assert.equal(stored.verification?.ok, true);

    const undoEvents = await collect(target.core.taskRunner.undo(stored));
    assert.equal(eventsOf(undoEvents, 'task-finish')[0]!.status, 'undone');
    assert.equal(fs.readFileSync(path.join(workspace, 'value.js'), 'utf8').replace(/\r\n/g, '\n'), 'module.exports = 1;\n');
    assert.equal(target.core.tasks.get(start.task.id)!.status, 'undone');
  } finally {
    await target.cleanup();
  }
});
