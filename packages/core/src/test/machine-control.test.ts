import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { moveToTrash, parseProcessList, pcTools, powerInvocation, wildcardToRegExp } from '@mimi/pc-agent';
import { FileSnapshots, SnapshotExecutor } from '../chat/file-snapshots.ts';
import { openDb } from '../db/db.ts';
import { LocalExecutor } from '../tools/executor.ts';
import { magicPacket } from '../tools/wake-tools.ts';
import { makeTestCore } from './core-helpers.ts';

// realpath: on macOS os.tmpdir() is /var/..., a symlink to /private/var/..., and the
// path guard and snapshots work with the canonical path.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-machine-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const folder = path.join(tmp, 'work');
fs.mkdirSync(folder, { recursive: true });
const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [folder] };
const tool = (name: string) => pcTools.find((candidate) => candidate.name === name)!;
const run = (name: string, input: unknown) => tool(name).execute(tool(name).inputSchema.parse(input), context);

test('folders: list, info, find, make, copy, move, with the allowed-folder guard', async () => {
  fs.mkdirSync(path.join(folder, 'docs', 'old'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'docs', 'a.txt'), 'Hello Rain');
  fs.writeFileSync(path.join(folder, 'docs', 'old', 'b.txt'), 'nothing');
  fs.writeFileSync(path.join(folder, 'report.pdf'), 'x');

  const top = await run('list_dir', {});
  assert.match(top, /d {2}docs\//);
  assert.match(top, /f {2}report\.pdf {2}1 B/);
  assert.doesNotMatch(top, /a\.txt/, 'depth 1 stays at the top');
  assert.match(await run('list_dir', { depth: 3 }), /docs[\\/]old[\\/]b\.txt/);
  assert.match(await run('file_info', { path: 'docs' }), /type: folder\nentries: 2/);
  assert.match(await run('file_info', { path: 'report.pdf' }), /size: 1 B/);

  assert.equal(wildcardToRegExp('*.TXT').test('a.txt'), true);
  assert.equal(wildcardToRegExp('a?c').test('abc'), true);
  assert.equal(wildcardToRegExp('a.c').test('abc'), false, 'a dot is a dot');
  const found = await run('find_files', { name: '*.txt' });
  assert.match(found, /2 file\(s\)/);
  assert.match(found, /a\.txt/);
  assert.match(found, /b\.txt/);
  assert.match(await run('find_files', { name: '*.txt', contains: 'rain' }), /1 file\(s\)[\s\S]*a\.txt/);
  assert.equal(await run('find_files', { name: '*.zip' }), 'No files found.');

  await run('make_dir', { path: 'new/deep' });
  assert.ok(fs.statSync(path.join(folder, 'new', 'deep')).isDirectory());
  await run('copy_path', { from: 'docs', to: 'copy' });
  assert.equal(fs.readFileSync(path.join(folder, 'copy', 'a.txt'), 'utf8'), 'Hello Rain');
  await assert.rejects(run('copy_path', { from: 'docs', to: 'copy' }), /already exists/);
  await run('move_path', { from: 'copy', to: 'moved/copy2' });
  assert.equal(fs.existsSync(path.join(folder, 'copy')), false);
  assert.ok(fs.existsSync(path.join(folder, 'moved', 'copy2', 'old', 'b.txt')));
  await assert.rejects(run('move_path', { from: 'moved', to: 'docs' }), /already exists/);
  await assert.rejects(run('move_path', { from: '.', to: 'x' }), /allowed folder itself/);
  await assert.rejects(run('list_dir', { path: '..' }), /outside the allowed folders/);
  await assert.rejects(run('move_path', { from: 'docs', to: '../escape' }), /outside the allowed folders/);
});

test('edit_file replaces one unique occurrence; the rewind puts the file back', async () => {
  const file = path.join(folder, 'edit.txt');
  fs.writeFileSync(file, 'one two two');
  await assert.rejects(run('edit_file', { path: 'edit.txt', old_string: 'three', new_string: 'x' }), /not found/);
  await assert.rejects(run('edit_file', { path: 'edit.txt', old_string: 'two', new_string: 'x' }), /2 times/);
  const snapshots = new FileSnapshots(openDb(':memory:'));
  const executor = new SnapshotExecutor(new LocalExecutor(), snapshots, { localPcTools: true });
  const since = new Date(Date.now() - 1).toISOString();
  await executor.execute(tool('edit_file'), { path: 'edit.txt', old_string: 'one', new_string: '1' }, context);
  assert.equal(fs.readFileSync(file, 'utf8'), '1 two two');
  assert.match(await run('edit_file', { path: 'edit.txt', old_string: 'two', new_string: '2', replace_all: true }), /Replaced 2 occurrences/);
  assert.equal(fs.readFileSync(file, 'utf8'), '1 2 2');
  assert.deepEqual(snapshots.restoreSince('main', since).restored, [file]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one two two');
});

test('delete_path: the trash folder off Windows, the Recycle Bin on it, permanent on request, never a root', async () => {
  const doomed = path.join(folder, 'doomed.txt');
  fs.writeFileSync(doomed, 'bye');
  const where = await moveToTrash(doomed, [folder], 'linux');
  assert.equal(fs.existsSync(doomed), false);
  assert.match(where, /\.mimi-trash/);
  assert.equal(fs.readFileSync(where, 'utf8'), 'bye');

  const recycled: Array<[string, boolean]> = [];
  fs.mkdirSync(path.join(folder, 'bin-me'));
  const target = path.join(folder, 'bin-me');
  assert.equal(await moveToTrash(target, [folder], 'win32', async (file, isDirectory) => void recycled.push([file, isDirectory])), 'the Recycle Bin');
  assert.deepEqual(recycled, [[target, true]]);

  fs.writeFileSync(path.join(folder, 'gone.txt'), 'x');
  assert.match(await run('delete_path', { path: 'gone.txt', permanent: true }), /permanently/);
  assert.equal(fs.existsSync(path.join(folder, 'gone.txt')), false);
  await assert.rejects(run('delete_path', { path: '.' }), /allowed folder itself/);
  await assert.rejects(run('delete_path', { path: 'nothing.txt' }), /does not exist/);
  assert.equal(tool('delete_path').risk, 'delete');
});

test('power: the OS commands, and that every call needs approval', () => {
  assert.deepEqual(powerInvocation('shutdown', 90, 'win32'), { file: 'shutdown.exe', args: ['/s', '/t', '90'] });
  assert.deepEqual(powerInvocation('restart', 0, 'win32'), { file: 'shutdown.exe', args: ['/r', '/t', '0'] });
  assert.deepEqual(powerInvocation('cancel', 0, 'win32'), { file: 'shutdown.exe', args: ['/a'] });
  assert.deepEqual(powerInvocation('lock', 0, 'win32'), { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] });
  assert.equal(powerInvocation('sleep', 0, 'win32').file, 'rundll32.exe');
  assert.deepEqual(powerInvocation('shutdown', 90, 'linux'), { file: 'shutdown', args: ['-h', '+2'] });
  assert.deepEqual(powerInvocation('shutdown', 0, 'darwin'), { file: 'shutdown', args: ['-h', 'now'] });
  assert.deepEqual(powerInvocation('sleep', 0, 'linux'), { file: 'systemctl', args: ['suspend'] });
  assert.equal(tool('power').risk, 'shell');
  assert.equal(tool('stop_process').risk, 'shell');
});

test('processes and opening: parsing, protected programs, and no running code through open_path', async () => {
  assert.deepEqual(
    parseProcessList('"chrome.exe","1234","Console","1","200,000 K"\r\n"notepad.exe","55","Console","1","9 K"\r\n', 'win32'),
    [{ pid: 1234, name: 'chrome.exe' }, { pid: 55, name: 'notepad.exe' }],
  );
  assert.deepEqual(parseProcessList('  1 systemd\n 22 bash\n', 'linux'), [{ pid: 1, name: 'systemd' }, { pid: 22, name: 'bash' }]);
  await assert.rejects(run('stop_process', {}), /exactly one/);
  await assert.rejects(run('stop_process', { pid: process.pid }), /protected/);
  await assert.rejects(run('stop_process', { name: 'node.exe' }), /protected/);
  await assert.rejects(run('stop_process', { name: 'C:\\Windows\\x.exe' }), /protected|plain program/);
  await assert.rejects(run('open_path', { target: 'setup.exe' }), /Programs and scripts/);
  await assert.rejects(run('open_path', { target: '../outside.pdf' }), /outside the allowed folders/);
  assert.match(await run('system_info', {}), /allowed folders:/);
});

test('wake_pc: the magic packet, and it reaches a UDP listener', async () => {
  const packet = magicPacket('1a:2b:3c:4d:5e:6f');
  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  assert.deepEqual([...packet.subarray(96)], [0x1a, 0x2b, 0x3c, 0x4d, 0x5e, 0x6f]);
  assert.equal(magicPacket('1A-2B-3C-4D-5E-6F').equals(packet), true);
  assert.throws(() => magicPacket('not a mac'), /not a MAC/);

  const server = dgram.createSocket('udp4');
  const received = new Promise<Buffer>((resolve) => server.once('message', resolve));
  await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
  const target = await makeTestCore({});
  const wake = target.core.tools.get('wake_pc')!;
  assert.equal(wake.risk, 'network');
  const answer = await wake.execute({ mac: '1a:2b:3c:4d:5e:6f', broadcast: '127.0.0.1', port: server.address().port }, { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] }, {});
  assert.match(answer, /Sent the wake-up signal/);
  assert.equal((await received).equals(packet), true);
  server.close();
  await target.cleanup();
});
