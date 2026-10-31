import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  missingPathError,
  PathNotAllowedError,
  ProjectNotAllowedError,
  readFileTool,
  resolveAllowedPath,
  resolveProjectPath,
  runShellTool,
  writeFileTool,
} from '@mimi/pc-agent';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-guard-')));
const allowed = path.join(root, 'allowed');
const outside = path.join(root, 'outside');
const sibling = path.join(root, 'allowed-evil');
for (const dir of [allowed, outside, sibling]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [allowed] };

test('relative paths resolve inside the working folder', () => {
  assert.equal(resolveAllowedPath('notes/a.txt', [allowed]), path.join(allowed, 'notes', 'a.txt'));
  assert.equal(resolveAllowedPath('.', [allowed]), allowed);
});

test('absolute paths inside an allowed folder pass', () => {
  const file = path.join(allowed, 'a.txt');
  assert.equal(resolveAllowedPath(file, [allowed]), file);
});

test('".." traversal out of the folder is rejected', () => {
  assert.throws(() => resolveAllowedPath('../outside/secret.txt', [allowed]), PathNotAllowedError);
  assert.throws(() => resolveAllowedPath('a/../../outside', [allowed]), PathNotAllowedError);
});

test('absolute paths outside are rejected, including a look-alike sibling folder', () => {
  assert.throws(() => resolveAllowedPath(path.join(outside, 'secret.txt'), [allowed]), PathNotAllowedError);
  assert.throws(() => resolveAllowedPath(path.join(sibling, 'x.txt'), [allowed]), PathNotAllowedError);
  assert.throws(() => resolveAllowedPath(os.homedir(), [allowed]), PathNotAllowedError);
});

test('an empty allowlist allows nothing', () => {
  assert.throws(() => resolveAllowedPath(path.join(allowed, 'a.txt'), []), PathNotAllowedError);
});

test('Windows specifics: case-insensitive match, other drives and UNC paths rejected', { skip: process.platform !== 'win32' }, () => {
  assert.doesNotThrow(() => resolveAllowedPath(path.join(allowed.toUpperCase(), 'a.txt'), [allowed]));
  const otherDrive = allowed.startsWith('C:') ? 'D:\\x.txt' : 'C:\\x.txt';
  assert.throws(() => resolveAllowedPath(otherDrive, [allowed]), PathNotAllowedError);
  assert.throws(() => resolveAllowedPath('\\\\server\\share\\x.txt', [allowed]), PathNotAllowedError);
});

test('a link inside the folder cannot be used to escape it', () => {
  const link = path.join(allowed, 'link');
  fs.symlinkSync(outside, link, 'junction');
  assert.throws(() => resolveAllowedPath('link/secret.txt', [allowed]), PathNotAllowedError);
});

test('file tools enforce the allowlist', async () => {
  await writeFileTool.execute({ path: 'sub/hello.txt', content: 'สวัสดี' }, context);
  assert.equal(await readFileTool.execute({ path: 'sub/hello.txt' }, context), 'สวัสดี');

  await assert.rejects(
    readFileTool.execute({ path: path.join(outside, 'secret.txt') }, context),
    PathNotAllowedError,
  );
  await assert.rejects(
    writeFileTool.execute({ path: '../outside/new.txt', content: 'x' }, context),
    PathNotAllowedError,
  );
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
});

test('missing read targets tell the agent where relative paths start', async () => {
  const error = await readFileTool.execute({ path: 'workspace/nope.txt' }, context).catch((e: Error) => e);
  assert.ok(error instanceof Error);
  assert.match(error.message, /ENOENT/);
  assert.match(error.message, new RegExp(allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(error.message, /working folder/);

  const unrelated = missingPathError(Object.assign(new Error('boom'), { code: 'EACCES' }), '/x', [allowed]);
  assert.equal(unrelated.message, 'boom', 'non-ENOENT errors are passed through unchanged');
});

test('run_shell runs in the working folder and refuses a cwd outside the allowlist', async () => {
  const output = await runShellTool.execute({ command: 'echo hello-from-shell' }, context);
  assert.match(output, /hello-from-shell/);
  assert.match(output, /\[exit code 0\]/);

  await assert.rejects(
    runShellTool.execute({ command: 'echo x', cwd: outside }, context),
    PathNotAllowedError,
  );
});

test('project roots narrow shell folders without ever widening the allowlist', () => {
  const project = path.join(allowed, 'project');
  const other = path.join(allowed, 'other');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  assert.equal(resolveProjectPath('project', [allowed], [project]), project);
  assert.equal(resolveProjectPath(path.join(project, 'src'), [allowed], [project]), path.join(project, 'src'));
  assert.throws(() => resolveProjectPath('other', [allowed], [project]), ProjectNotAllowedError);
  assert.throws(() => resolveProjectPath('other', [allowed], [project]), /approved project folders/);
  assert.throws(() => resolveProjectPath(path.join(outside, 'secret.txt'), [allowed], [project]), PathNotAllowedError);

  // A root the core asks for but this machine does not allow is ignored, not trusted.
  assert.throws(() => resolveProjectPath('other', [allowed], [outside]), /No approved project folder/);
  assert.throws(() => resolveProjectPath('other', [allowed], [outside, sibling]), /No approved project folder/);
  assert.throws(() => resolveProjectPath(path.join(outside, 'secret.txt'), [allowed], [outside]), PathNotAllowedError);

  // No project roots configured: the folder allowlist alone decides, as before.
  assert.equal(resolveProjectPath('other', [allowed], []), other);
  assert.equal(resolveProjectPath('other', [allowed], undefined), other);
});

test('run_shell follows the project allowlist when one is set', async () => {
  const project = path.join(allowed, 'shell-project');
  const other = path.join(allowed, 'shell-other');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const scoped = { ...context, projectRoots: [project] };
  const output = await runShellTool.execute({ command: 'echo inside-project', cwd: project }, scoped);
  assert.match(output, /inside-project/);

  await assert.rejects(runShellTool.execute({ command: 'echo x', cwd: other }, scoped), ProjectNotAllowedError);
  await assert.rejects(runShellTool.execute({ command: 'echo x', cwd: outside }, scoped), PathNotAllowedError);
});

test('run_shell kills a command that exceeds its timeout', async () => {
  const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const output = await runShellTool.execute({ command, timeout_ms: 500 }, context);
  assert.match(output, /timed out after 500 ms/);
});
