import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Desktop updates from GitHub releases (packages/desktop/updater.cjs): the app asks first,
// downloads the zip for this computer, and a script swaps the files once the app has quit.
interface Update {
  version: string;
  url: string;
  name: string;
  size: number;
}
interface Release {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: Array<{ name: string; browser_download_url: string; size?: number }>;
}
const updater = createRequire(import.meta.url)('../../../desktop/updater.cjs') as {
  isNewer(candidate: string, current: string): boolean;
  assetFor(release: Release, platform?: string, arch?: string): { name: string } | null;
  findUpdate(repo: string, current: string, fetchFn: typeof fetch, platform?: string, arch?: string): Promise<Update | null>;
  installTarget(execPath: string, platform: string): string;
  swapScript(options: { pid: number; source: string; target: string; stageDir: string; platform: string; keepQuarantine?: boolean }): string;
  expectedHash(sums: string, name: string): string | null;
  checkDownload(zip: string, update: Update, sums: string): Promise<void>;
  checkSignature(options: { current: string; next: string; platform: string; run: SpawnLike }): { required: boolean };
  download(update: Update & { sumsUrl?: string | null }, stageDir: string, fetchFn: typeof fetch, platform?: string): Promise<string>;
};
type SpawnLike = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => { status: number; stdout: string; stderr: string };

const release: Release = {
  tag_name: 'v0.6.0',
  assets: [
    { name: 'Mimi-0.6.0-win-x64.zip', browser_download_url: 'https://example.com/win.zip', size: 150 * 1048576 },
    { name: 'Mimi-0.6.0-mac-arm64.zip', browser_download_url: 'https://example.com/mac.zip' },
    { name: 'Mimi-0.6.0-android.apk', browser_download_url: 'https://example.com/app.apk' },
  ],
};
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test('updater: versions compare by number, not text', () => {
  assert.equal(updater.isNewer('v0.6.0', '0.5.0'), true);
  assert.equal(updater.isNewer('0.5.10', '0.5.9'), true);
  assert.equal(updater.isNewer('v0.5.0', '0.5.0'), false);
  assert.equal(updater.isNewer('0.4.9', '0.5.0'), false);
  assert.equal(updater.isNewer('1.0.0-beta', '0.9.0'), true);
});

test('updater: the asset for this computer only, and only a newer, published release', async () => {
  assert.equal(updater.assetFor(release, 'win32', 'x64')?.name, 'Mimi-0.6.0-win-x64.zip');
  assert.equal(updater.assetFor(release, 'darwin', 'arm64')?.name, 'Mimi-0.6.0-mac-arm64.zip');
  assert.equal(updater.assetFor(release, 'darwin', 'x64'), null, 'no Intel build in this release');
  assert.equal(updater.assetFor(release, 'linux', 'x64'), null);

  const found = await updater.findUpdate('o/r', '0.5.0', answer(release), 'win32', 'x64');
  assert.deepEqual({ version: found?.version, url: found?.url, size: found?.size }, { version: '0.6.0', url: 'https://example.com/win.zip', size: 150 * 1048576 });
  assert.equal(await updater.findUpdate('o/r', '0.6.0', answer(release), 'win32', 'x64'), null, 'already up to date');
  assert.equal(await updater.findUpdate('o/r', '0.5.0', answer({ ...release, prerelease: true }), 'win32', 'x64'), null);
  assert.equal(await updater.findUpdate('o/r', '0.5.0', answer({ message: 'Not Found' }, 404), 'win32', 'x64'), null, 'no release yet');
});

test('updater: the swap waits for the app, replaces it, starts it again', () => {
  assert.equal(updater.installTarget('C:\\Apps\\Mimi\\Mimi.exe', 'win32'), path.dirname('C:\\Apps\\Mimi\\Mimi.exe'));
  assert.equal(updater.installTarget('/Applications/Mimi.app/Contents/MacOS/Mimi', 'darwin'), path.resolve('/Applications/Mimi.app'));

  const win = updater.swapScript({ pid: 4242, source: 'C:\\stage\\new\\Mimi', target: 'C:\\Apps\\Mimi', stageDir: 'C:\\stage', platform: 'win32' });
  assert.match(win, /PID eq 4242/);
  assert.match(win, /robocopy "C:\\stage\\new\\Mimi" "C:\\Apps\\Mimi" \/MIR/);
  assert.ok(win.indexOf('robocopy') < win.indexOf('start ""'), 'files are in place before the app starts');

  const mac = updater.swapScript({ pid: 77, source: "/tmp/it's/Mimi.app", target: '/Applications/Mimi.app', stageDir: '/tmp/stage', platform: 'darwin' });
  assert.match(mac, /kill -0 77/);
  assert.match(mac, /'\/tmp\/it'\\''s\/Mimi\.app'/, 'paths are quoted for the shell');
  assert.match(mac, /mv '\/Applications\/Mimi\.app\.old' '\/Applications\/Mimi\.app'/, 'a failed copy puts the old app back');
});

test('updater: the release must publish SHA256SUMS.txt and the zip must match it', async (t) => {
  const withSums = { ...release, assets: [...release.assets, { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.com/sums' }] };
  const found = await updater.findUpdate('o/r', '0.5.0', answer(withSums), 'win32', 'x64');
  assert.equal((found as Update & { sumsUrl?: string }).sumsUrl, 'https://example.com/sums');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-updater-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'Mimi-0.6.0-win-x64.zip');
  fs.writeFileSync(zip, 'zip bytes');
  const hash = createHash('sha256').update('zip bytes').digest('hex');
  const update = { version: '0.6.0', url: 'u', name: 'Mimi-0.6.0-win-x64.zip', size: 9 };
  const sums = `${'0'.repeat(64)}  Mimi-0.6.0-mac-arm64.zip\n${hash} *Mimi-0.6.0-win-x64.zip\n`;
  assert.equal(updater.expectedHash(sums, update.name), hash);
  await updater.checkDownload(zip, update, sums);
  await assert.rejects(updater.checkDownload(zip, { ...update, size: 10 }, sums), /9 bytes, the release says 10/);
  await assert.rejects(updater.checkDownload(zip, update, `${'f'.repeat(64)}  ${update.name}`), /does not match the checksum/);
  await assert.rejects(updater.checkDownload(zip, update, 'nothing here'), /does not list/);
  await assert.rejects(updater.download({ ...update, sumsUrl: null }, path.join(dir, 'stage'), answer({})), /no SHA256SUMS\.txt/);
});

test('updater: a signed app accepts only an update from the same publisher', () => {
  const runFor = (answers: Record<string, string>): SpawnLike => (_command, args, options) => {
    const target = options.env?.MIMI_SIGNED_FILE ?? args.at(-1)!;
    const value = answers[target] ?? 'NotSigned|';
    return { status: 0, stdout: value, stderr: '' };
  };
  const same = runFor({ 'C:/old/Mimi.exe': 'Valid|CN=Mimi Publisher', 'C:/new/Mimi.exe': 'Valid|CN=Mimi Publisher' });
  assert.deepEqual(updater.checkSignature({ current: 'C:/old/Mimi.exe', next: 'C:/new/Mimi.exe', platform: 'win32', run: same }), { required: true });
  const other = runFor({ 'C:/old/Mimi.exe': 'Valid|CN=Mimi Publisher', 'C:/new/Mimi.exe': 'Valid|CN=Someone Else' });
  assert.throws(() => updater.checkSignature({ current: 'C:/old/Mimi.exe', next: 'C:/new/Mimi.exe', platform: 'win32', run: other }), /same publisher/);
  const unsignedNew = runFor({ 'C:/old/Mimi.exe': 'Valid|CN=Mimi Publisher' });
  assert.throws(() => updater.checkSignature({ current: 'C:/old/Mimi.exe', next: 'C:/new/Mimi.exe', platform: 'win32', run: unsignedNew }), /same publisher/);
  const unsignedOld = runFor({});
  assert.deepEqual(updater.checkSignature({ current: 'C:/old/Mimi.exe', next: 'C:/new/Mimi.exe', platform: 'win32', run: unsignedOld }), { required: false });

  const mac: SpawnLike = (_command, args) => {
    const target = args.at(-1)!;
    if (args[0] === '--verify') return { status: target.includes('broken') ? 1 : 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: target.includes('adhoc') ? 'TeamIdentifier=not set' : 'Authority=Developer ID Application\nTeamIdentifier=ABCDE12345' };
  };
  assert.deepEqual(updater.checkSignature({ current: '/Applications/Mimi.app', next: '/tmp/new/Mimi.app', platform: 'darwin', run: mac }), { required: true });
  assert.throws(() => updater.checkSignature({ current: '/Applications/Mimi.app', next: '/tmp/broken/Mimi.app', platform: 'darwin', run: mac }), /same publisher/);
  assert.deepEqual(updater.checkSignature({ current: '/Applications/adhoc/Mimi.app', next: '/tmp/new/Mimi.app', platform: 'darwin', run: mac }), { required: false });

  const keep = updater.swapScript({ pid: 1, source: '/s', target: '/Applications/Mimi.app', stageDir: '/t', platform: 'darwin', keepQuarantine: true });
  assert.doesNotMatch(keep, /quarantine/, 'a notarized app keeps the download flag');
  assert.match(updater.swapScript({ pid: 1, source: '/s', target: '/Applications/Mimi.app', stageDir: '/t', platform: 'darwin' }), /quarantine/);
});
