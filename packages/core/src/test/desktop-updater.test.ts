import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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
  swapScript(options: { pid: number; source: string; target: string; stageDir: string; platform: string }): string;
};

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
