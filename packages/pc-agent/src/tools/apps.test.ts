import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { installAppTool, packageCommand, setPackageProbe, setPackageRunner } from './apps.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-apps-'));
after(() => {
  setPackageRunner(null);
  setPackageProbe(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [dir] };
const ok = { output: 'installed', exitCode: 0, timedOut: false, cancelled: false, truncated: 0 };

test('package commands are fixed arguments, never a shell line', () => {
  assert.deepEqual(packageCommand('winget', 'install', 'Google.Chrome'), {
    file: 'winget',
    args: [
      'install',
      '--id', 'Google.Chrome',
      '--exact',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
  });
  assert.deepEqual(packageCommand('winget', 'update', 'Google.Chrome').args[0], 'upgrade');
  assert.deepEqual(packageCommand('brew', 'install', 'firefox', true), { file: 'brew', args: ['install', '--cask', 'firefox'] });
  assert.deepEqual(packageCommand('choco', 'install', 'firefox'), { file: 'choco', args: ['install', 'firefox', '-y', '--no-progress'] });
  assert.deepEqual(packageCommand('scoop', 'update', 'extras/vscode'), { file: 'scoop', args: ['update', 'extras/vscode'] });
  assert.deepEqual(packageCommand('apt', 'install', 'curl', false, false), {
    file: 'sudo',
    args: ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', 'curl'],
  });
});

test('install_app runs the manager once and reports its output', async () => {
  let seen: { file: string; args: string[]; cwd: string } | undefined;
  setPackageProbe(async () => true);
  setPackageRunner(async (command, options) => {
    seen = { file: command.file, args: command.args, cwd: options.cwd };
    return ok;
  });
  const result = JSON.parse(await installAppTool.execute({ id: 'Google.Chrome', manager: 'winget' }, context)) as {
    ok: boolean;
    manager: string;
    summary: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.manager, 'winget');
  assert.equal(seen?.file, 'winget');
  assert.deepEqual(seen?.args.slice(0, 3), ['install', '--id', 'Google.Chrome']);
  assert.equal(seen?.cwd, dir);
});

test('install_app refuses flags, unknown managers and failing managers', async () => {
  let called = false;
  setPackageProbe(async () => true);
  setPackageRunner(async () => {
    called = true;
    return ok;
  });
  await assert.rejects(installAppTool.execute({ id: '--help', manager: 'winget' }, context), /not a package id/);
  assert.equal(called, false, 'nothing ran for an invalid id');
  await assert.rejects(installAppTool.execute({ id: 'firefox', cask: true, manager: 'winget' }, context), /only for Homebrew/);

  setPackageRunner(async () => ({ ...ok, exitCode: 1, output: 'package not found' }));
  await assert.rejects(installAppTool.execute({ id: 'nope', manager: 'winget' }, context), /package not found/);

  setPackageProbe(async () => false);
  await assert.rejects(installAppTool.execute({ id: 'firefox', manager: 'brew' }, context), /not installed/);
});
