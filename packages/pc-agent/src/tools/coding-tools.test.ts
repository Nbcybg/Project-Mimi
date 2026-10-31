import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyPatchTool } from './patch.ts';
import { grepTool } from './search.ts';
import { gitCommitTool, gitStatusTool } from './git.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-coding-'));
const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [dir] };

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('grep: finds text by pattern and limits to a glob', async () => {
  fs.writeFileSync(path.join(dir, 'a.ts'), 'const answer = 42;\n// TODO: fix\n');
  fs.writeFileSync(path.join(dir, 'b.md'), 'TODO in docs\n');
  const result = await grepTool.execute({ pattern: 'TODO' }, context);
  assert.match(result, /a\.ts:2:/);
  assert.match(result, /b\.md:1:/);
  const onlyTs = await grepTool.execute({ pattern: 'todo', glob: '*.ts', ignore_case: true }, context);
  assert.match(onlyTs, /a\.ts/);
  assert.doesNotMatch(onlyTs, /b\.md/);
  await assert.rejects(grepTool.execute({ pattern: '(' }, context), /Invalid regular expression/);
});

test('apply_patch: changes several files, and one bad hunk changes nothing', async () => {
  const one = path.join(dir, 'one.txt');
  const two = path.join(dir, 'two.txt');
  fs.writeFileSync(one, 'a=1\n');
  fs.writeFileSync(two, 'b=2\n');

  const result = await applyPatchTool.execute(
    {
      patches: [
        { path: 'one.txt', old_string: 'a=1', new_string: 'a=10' },
        { path: 'two.txt', old_string: 'b=2', new_string: 'b=20' },
      ],
    },
    context,
  );
  assert.match(result, /one\.txt/);
  assert.equal(fs.readFileSync(one, 'utf8'), 'a=10\n');
  assert.equal(fs.readFileSync(two, 'utf8'), 'b=20\n');

  await assert.rejects(
    applyPatchTool.execute(
      {
        patches: [
          { path: 'one.txt', old_string: 'a=10', new_string: 'a=11' },
          { path: 'two.txt', old_string: 'missing', new_string: 'x' },
        ],
      },
      context,
    ),
    /not found/,
  );
  assert.equal(fs.readFileSync(one, 'utf8'), 'a=10\n', 'a failed patch leaves the first file alone');
});

test('git_status: reports a folder that is not a repository clearly', async () => {
  await assert.rejects(gitStatusTool.execute({}, context), /not a git repository/);
});

test('git_commit: secret-looking files are refused unless allow_secrets is set', async () => {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const runGit = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  runGit(['init']);
  runGit(['config', 'user.email', 'test@example.com']);
  runGit(['config', 'user.name', 'Mimi Test']);

  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(repo, '.env.example'), 'TOKEN=\n');
  assert.match(await gitCommitTool.execute({ path: 'repo', message: 'first' }, context), /first/);
  assert.match(runGit(['log', '-1', '--name-only', '--pretty=format:']), /\.env\.example/);

  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=supersecret\n');
  await assert.rejects(gitCommitTool.execute({ path: 'repo', message: 'leak' }, context), /secret-looking files: \.env/);
  assert.match(runGit(['status', '--porcelain']), /^\?\? \.env$/m);

  fs.writeFileSync(path.join(repo, 'server.key'), 'private\n');
  assert.match(await gitCommitTool.execute({ path: 'repo', message: 'intentional', allow_secrets: true }, context), /intentional/);
  assert.match(runGit(['status', '--porcelain']), /^$/);
});
