import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { isOrganizerReadOnly, organizeFilesTool, undoOrganizeTool } from '@mimi/pc-agent';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-organize-')));
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

const context = (folder: string) => ({ traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [folder] });
const parse = (text: string) => JSON.parse(text) as Record<string, any>;

async function runPlan(folder: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return parse(
    await organizeFilesTool.execute(
      organizeFilesTool.inputSchema.parse({ folder, dry_run: true, ...extra }),
      context(folder),
    ),
  );
}

async function runApply(folder: string, journal: string): Promise<Record<string, any>> {
  return parse(
    await organizeFilesTool.execute(organizeFilesTool.inputSchema.parse({ journal, dry_run: false }), context(folder)),
  );
}

async function runVerify(folder: string, journal: string): Promise<Record<string, any>> {
  return parse(
    await organizeFilesTool.execute(organizeFilesTool.inputSchema.parse({ journal, verify: true }), context(folder)),
  );
}

async function runUndo(folder: string, journal: string): Promise<Record<string, any>> {
  return parse(
    await undoOrganizeTool.execute(undoOrganizeTool.inputSchema.parse({ journal }), context(folder)),
  );
}

test('plan, apply, verify and undo move only regular files and restore every one', async () => {
  const folder = folderWith({
    'photo.JPG': 'image',
    'report.pdf': 'document',
    'song.mp3': 'audio',
    'backup.zip': 'archive',
    'script.ts': 'code',
    'setup.exe': 'installer',
    'mystery.xyz': 'other',
    '.hidden': 'hidden',
    'download.part': 'partial',
    '~$draft.docx': 'office temp',
    'folder/nested.txt': 'nested',
  });
  let linked = false;
  try {
    fs.symlinkSync(path.join(folder, 'photo.JPG'), path.join(folder, 'link.jpg'));
    linked = true;
  } catch {
    // Windows without developer mode cannot make symlinks; the other skips still run.
  }

  const planned = await runPlan(folder);
  assert.equal(planned.mode, 'plan');
  assert.equal(planned.total, 7);
  assert.ok(planned.journal.startsWith(path.join(folder, '.mimi-organize')));
  assert.ok(fs.existsSync(planned.journal));
  const skippedNames = (planned.skipped as Array<{ name: string }>).map((entry) => entry.name);
  for (const name of ['.hidden', 'download.part', '~$draft.docx']) assert.ok(skippedNames.includes(name), name);
  if (linked) assert.ok(skippedNames.includes('link.jpg'));
  assert.equal(fs.readFileSync(path.join(folder, 'photo.JPG'), 'utf8'), 'image', 'the plan changes nothing');

  const applied = await runApply(folder, planned.journal);
  assert.equal(applied.moved, 7);
  assert.equal(applied.failed, 0);
  assert.equal(fs.readFileSync(path.join(folder, 'Images', 'photo.JPG'), 'utf8'), 'image');
  assert.equal(fs.readFileSync(path.join(folder, 'Documents', 'report.pdf'), 'utf8'), 'document');
  assert.equal(fs.readFileSync(path.join(folder, 'Audio', 'song.mp3'), 'utf8'), 'audio');
  assert.equal(fs.readFileSync(path.join(folder, 'Archives', 'backup.zip'), 'utf8'), 'archive');
  assert.equal(fs.readFileSync(path.join(folder, 'Code', 'script.ts'), 'utf8'), 'code');
  assert.equal(fs.readFileSync(path.join(folder, 'Installers', 'setup.exe'), 'utf8'), 'installer');
  assert.equal(fs.readFileSync(path.join(folder, 'Other', 'mystery.xyz'), 'utf8'), 'other');
  assert.equal(fs.existsSync(path.join(folder, '.hidden')), true);
  assert.equal(fs.existsSync(path.join(folder, 'folder', 'nested.txt')), true);

  const verified = await runVerify(folder, planned.journal);
  assert.equal(verified.ok, true);
  assert.equal(verified.checked, 7);

  const undone = await runUndo(folder, planned.journal);
  assert.equal(undone.restored, 7);
  assert.equal(undone.failed, 0);
  for (const name of ['photo.JPG', 'report.pdf', 'song.mp3', 'backup.zip', 'script.ts', 'setup.exe', 'mystery.xyz']) {
    assert.equal(fs.existsSync(path.join(folder, name)), true, name);
  }
  const afterUndo = await runVerify(folder, planned.journal);
  assert.equal(afterUndo.ok, true);

  // A second undo is harmless and reports that it was already done.
  const again = await runUndo(folder, planned.journal);
  assert.equal(again.alreadyUndone, true);
});

test('conflict policies: rename, skip and a safe overwrite that undo restores', async () => {
  const renameFolder = folderWith({ 'photo.jpg': 'new photo', 'Images/photo.jpg': 'old photo' });
  const renamePlan = await runPlan(renameFolder, { policy: 'rename' });
  const renamed = await runApply(renameFolder, renamePlan.journal);
  assert.equal(renamed.moved, 1);
  assert.equal(fs.readFileSync(path.join(renameFolder, 'Images', 'photo.jpg'), 'utf8'), 'old photo');
  assert.equal(fs.readFileSync(path.join(renameFolder, 'Images', 'photo (1).jpg'), 'utf8'), 'new photo');
  await runUndo(renameFolder, renamePlan.journal);
  assert.equal(fs.readFileSync(path.join(renameFolder, 'photo.jpg'), 'utf8'), 'new photo');
  assert.equal(fs.readFileSync(path.join(renameFolder, 'Images', 'photo.jpg'), 'utf8'), 'old photo');

  const skipFolder = folderWith({ 'notes.txt': 'new', 'Documents/notes.txt': 'old' });
  const skipPlan = await runPlan(skipFolder, { policy: 'skip' });
  const skipped = await runApply(skipFolder, skipPlan.journal);
  assert.equal(skipped.moved, 0);
  assert.equal(skipped.skipped, 1);
  assert.equal(fs.readFileSync(path.join(skipFolder, 'notes.txt'), 'utf8'), 'new');

  const overwriteFolder = folderWith({ 'notes.txt': 'new', 'Documents/notes.txt': 'old' });
  const overwritePlan = await runPlan(overwriteFolder, { policy: 'overwrite' });
  const overwritten = await runApply(overwriteFolder, overwritePlan.journal);
  assert.equal(overwritten.moved, 1);
  assert.equal(fs.readFileSync(path.join(overwriteFolder, 'Documents', 'notes.txt'), 'utf8'), 'new');
  const backups = fs.readdirSync(path.join(overwriteFolder, '.mimi-organize', 'backups'), { recursive: true });
  assert.ok(backups.some((entry) => String(entry).includes('notes.txt')));
  await runUndo(overwriteFolder, overwritePlan.journal);
  assert.equal(fs.readFileSync(path.join(overwriteFolder, 'notes.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(overwriteFolder, 'Documents', 'notes.txt'), 'utf8'), 'old');
});

test('max_files caps one run and leaves the rest for later', async () => {
  const folder = folderWith({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  const planned = await runPlan(folder, { max_files: 2 });
  assert.equal(planned.total, 2);
  assert.equal(planned.deferred, 1);
  const applied = await runApply(folder, planned.journal);
  assert.equal(applied.moved, 2);
  assert.equal(applied.deferred, 1);
  assert.equal(fs.readdirSync(folder).filter((name) => name.endsWith('.txt')).length, 1);
});

test('only apply counts as a side effect for local consent', () => {
  assert.equal(isOrganizerReadOnly({}), true);
  assert.equal(isOrganizerReadOnly({ journal: 'plan.json', dry_run: true }), true);
  assert.equal(isOrganizerReadOnly({ journal: 'plan.json', verify: true }), true);
  assert.equal(isOrganizerReadOnly({ journal: 'plan.json', dry_run: false }), false);
});

test('the path guard refuses a folder outside the allowed list', async () => {
  const allowed = folderWith({ 'a.txt': 'a' });
  const outside = folderWith({ 'b.txt': 'b' });
  await assert.rejects(
    organizeFilesTool.execute(organizeFilesTool.inputSchema.parse({ folder: outside, dry_run: true }), context(allowed)),
    /outside the allowed folders/,
  );
  await assert.rejects(
    undoOrganizeTool.execute(undoOrganizeTool.inputSchema.parse({ journal: path.join(outside, 'x.json') }), context(allowed)),
    /outside the allowed folders/,
  );
});
