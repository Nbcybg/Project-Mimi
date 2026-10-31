import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { isWorkspaceCommandBlocked, isWorkspaceDestructive, pcTools } from '@mimi/pc-agent';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-workspace-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const parse = (text: string) => JSON.parse(text) as Record<string, any>;
const tool = (name: string) => pcTools.find((candidate) => candidate.name === name)!;
const context = (dir: string) => ({ traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [dir] });
const run = (name: string, input: unknown, dir: string) => {
  const definition = tool(name);
  return definition.execute(definition.inputSchema.parse(input), context(dir));
};

function sampleRepo(): string {
  const dir = path.join(tmp, `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
  fs.writeFileSync(path.join(dir, 'value.js'), 'module.exports = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'test.js'),
    "const value = require('./value.js');\nif (value !== 42) { console.error('expected 42, got ' + value); process.exit(1); }\nconsole.log('ok');\n",
  );
  fs.writeFileSync(path.join(dir, 'env.js'), "console.log(process.env.MIMI_TEST_SECRET || 'none');\n");
  return dir;
}

test('workspace_create initializes git and detects the test command', async () => {
  const dir = sampleRepo();
  const created = parse(await run('workspace_create', { path: dir }, dir));
  assert.equal(created.ok, true);
  assert.equal(created.git.repo, true);
  assert.equal(created.git.initialized, true);
  assert.match(created.testCommand.command, /test/);
  assert.ok(fs.existsSync(path.join(dir, '.git')));

  const info = parse(await run('workspace_info', { path: dir }, dir));
  assert.equal(info.git.repo, true);
  assert.match(info.summary, /test/);
  assert.ok(fs.existsSync(path.join(dir, '.git/info/exclude')));
  assert.match(fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8'), /\.mimi-workspace/);
});

test('workspace_run uses the saved environment and applies the command policy', async () => {
  const dir = sampleRepo();
  await run('workspace_create', { path: dir }, dir);
  const previous = process.env.MIMI_TEST_SECRET;
  process.env.MIMI_TEST_SECRET = 'must-not-leak';
  try {
    const env = parse(await run('workspace_run', { path: dir, command: 'node env.js' }, dir));
    assert.equal(env.ok, true);
    assert.equal(env.output.trim(), 'none');
  } finally {
    if (previous === undefined) delete process.env.MIMI_TEST_SECRET;
    else process.env.MIMI_TEST_SECRET = previous;
  }

  const failing = parse(await run('workspace_run', { path: dir, command: 'node test.js' }, dir));
  assert.equal(failing.ok, false);
  assert.equal(failing.exitCode, 1);
  assert.match(failing.output, /expected 42/);

  await assert.rejects(run('workspace_run', { path: dir, command: 'git push origin main' }, dir), /never pushes/);
  await assert.rejects(run('workspace_run', { path: dir, command: 'git merge other' }, dir), /never pushes/);
  await assert.rejects(run('workspace_run', { path: dir, command: 'rm -rf build' }, dir), /destructive/);
  assert.equal(isWorkspaceCommandBlocked('git push origin main'), true);
  assert.equal(isWorkspaceDestructive('rm -rf build'), true);

  const slow = parse(await run('workspace_run', { path: dir, command: 'node -e "setTimeout(() => {}, 5000)"', timeout_ms: 1000 }, dir));
  assert.equal(slow.timedOut, true);
  assert.equal(slow.ok, false);
});

test('checkpoint, diff and undo restore tracked and untracked files', async () => {
  const dir = sampleRepo();
  await run('workspace_create', { path: dir }, dir);
  const checkpoint = parse(await run('workspace_checkpoint', { path: dir, label: 'before fix' }, dir));
  assert.equal(checkpoint.ok, true);

  fs.writeFileSync(path.join(dir, 'value.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(dir, 'added.txt'), 'new file\n');
  const changed = parse(await run('workspace_run', { path: dir, command: 'node test.js' }, dir));
  assert.equal(changed.ok, true);

  const preview = parse(await run('workspace_diff', { path: dir, checkpoint: checkpoint.id }, dir));
  assert.equal(preview.clean, false);
  assert.match(preview.diff, /module\.exports = 42/);
  assert.ok(preview.untracked.includes('added.txt'));

  const undone = parse(await run('workspace_undo', { path: dir, checkpoint: checkpoint.id }, dir));
  assert.equal(undone.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'value.js'), 'utf8').replace(/\r\n/g, '\n'), 'module.exports = 1;\n');
  assert.equal(fs.existsSync(path.join(dir, 'added.txt')), false);
  assert.ok(fs.existsSync(path.join(undone.backupDir, 'added.txt')), 'the added file is backed up, not lost');

  const clean = parse(await run('workspace_diff', { path: dir, checkpoint: checkpoint.id, expect_clean: true }, dir));
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(clean.clean, true, JSON.stringify(clean));
});

test('workspace paths stay inside the allowed folders', async () => {
  const allowed = sampleRepo();
  const outside = sampleRepo();
  await assert.rejects(run('workspace_info', { path: outside }, allowed), /outside the allowed folders/);
  await assert.rejects(run('workspace_create', { path: outside }, allowed), /outside the allowed folders/);
});
