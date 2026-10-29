import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// The Electron-free half of the remote desktop app (packages/desktop/remote-lib.cjs).
interface Where {
  root: string;
  config: string;
  session: string;
  chromium: string;
  cache: string;
}
interface Config {
  server: string;
  autoLockMinutes: number;
  pcAgent: { enabled: boolean; shell: boolean; folders: string[] };
  window: Record<string, unknown>;
}
const lib = createRequire(import.meta.url)('../../../desktop/remote-lib.cjs') as {
  normalizeServerUrl(raw: string): string;
  folderProblem(dir: string, home: string): string | null;
  readConfig(file: string, home: string): Config;
  writeConfig(file: string, config: Config): void;
  locations(appData: string, cacheDir: string): Where;
  agentBrowserDir(cache: string, server: string, username: string): string;
  wipeSession(where: Where): void;
  emptyFolder(dir: string, keep?: (name: string) => boolean): void;
  chromiumKeeps(name: string): boolean;
  wsUrl(server: string): string;
};

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-desktop-home-')));

test('server address: https only, except a server on this computer; nothing but the origin', () => {
  assert.equal(lib.normalizeServerUrl(' https://mimi.example.com/some/page?x=1 '), 'https://mimi.example.com');
  assert.equal(lib.normalizeServerUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(lib.normalizeServerUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.throws(() => lib.normalizeServerUrl('http://mimi.example.com'), /https/);
  assert.throws(() => lib.normalizeServerUrl('https://user:pw@mimi.example.com'), /ชื่อผู้ใช้หรือรหัสผ่าน/);
  assert.throws(() => lib.normalizeServerUrl('not a url'), /ไม่ถูกต้อง/);
  assert.throws(() => lib.normalizeServerUrl('file:///etc/passwd'), /https/);
});

test('PC agent folders: only inside the OS account home, never the home itself or system folders', () => {
  const inside = path.join(home, 'Mimi-Workspace');
  fs.mkdirSync(inside, { recursive: true });
  assert.equal(lib.folderProblem(inside, home), null);
  assert.equal(lib.folderProblem(path.join(home, 'not-yet', 'made'), home), null, 'a folder to be created is fine');
  assert.match(lib.folderProblem(home, home)!, /ไม่ใช่โฮมทั้งหมด/);
  assert.match(lib.folderProblem('/etc', home)!, /ในโฮม/);
  assert.match(lib.folderProblem(path.join(home, '..', 'someone-else'), home)!, /ในโฮม/);
  assert.match(lib.folderProblem(path.join(home, 'Library', 'Keychains'), home)!, /ระบบ/);
  assert.match(lib.folderProblem(path.join(home, '.ssh'), home)!, /ระบบ/);
  assert.match(lib.folderProblem('relative/path', home)!, /absolute/);
  // A link inside the home that leads out of it does not count as inside.
  const link = path.join(home, 'escape');
  fs.symlinkSync(os.tmpdir(), link);
  assert.match(lib.folderProblem(link, home)!, /ในโฮม/);
});

test('config: defaults are off; bad values from the file are dropped', () => {
  const file = path.join(home, 'config.json');
  const fresh = lib.readConfig(file, home);
  assert.deepEqual({ server: fresh.server, lock: fresh.autoLockMinutes, pc: fresh.pcAgent.enabled, shell: fresh.pcAgent.shell }, { server: '', lock: 0, pc: false, shell: false });
  assert.deepEqual(fresh.pcAgent.folders, [path.join(home, 'Mimi-Workspace')]);

  lib.writeConfig(file, { ...fresh, server: 'https://mimi.example.com', autoLockMinutes: 15, pcAgent: { enabled: true, shell: true, folders: [path.join(home, 'work')] } });
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'readable by its owner only');
  const saved = lib.readConfig(file, home);
  assert.deepEqual({ server: saved.server, lock: saved.autoLockMinutes, pc: saved.pcAgent }, {
    server: 'https://mimi.example.com',
    lock: 15,
    pc: { enabled: true, shell: true, folders: [path.join(home, 'work')] },
  });

  fs.writeFileSync(file, JSON.stringify({ server: 'http://evil.example', autoLockMinutes: 7, pcAgent: { enabled: 'yes', shell: 'yes', folders: ['/etc', home] } }));
  const cleaned = lib.readConfig(file, home);
  assert.deepEqual({ server: cleaned.server, lock: cleaned.autoLockMinutes, pc: cleaned.pcAgent.enabled, shell: cleaned.pcAgent.shell }, { server: '', lock: 0, pc: false, shell: false });
  assert.deepEqual(cleaned.pcAgent.folders, [path.join(home, 'Mimi-Workspace')], 'folders outside the rules fall back to the default');
});

test('sign-out wipe: the token file and the temporary cache go, the settings stay', () => {
  const where = lib.locations(path.join(home, 'AppSupport'), path.join(home, 'Caches'));
  // Electron on Windows gives the same folder for "cache" and "appData": the wipe must not reach the settings.
  const same = lib.locations(path.join(home, 'Roaming'), path.join(home, 'Roaming'));
  assert.equal(same.cache, path.join(same.root, 'cache'));
  const browser = lib.agentBrowserDir(where.cache, 'https://mimi.example.com', 'alice');
  assert.ok(browser.startsWith(where.cache));
  assert.ok(!browser.includes('alice'), 'the folder name does not reveal the account');
  assert.notEqual(browser, lib.agentBrowserDir(where.cache, 'https://mimi.example.com', 'bob'), 'one profile per Mimi account');
  for (const file of [where.config, where.session, path.join(browser, 'Default', 'Cookies')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
  }
  lib.wipeSession(where);
  assert.equal(fs.existsSync(where.session), false);
  assert.equal(fs.existsSync(where.cache), false);
  assert.equal(fs.existsSync(where.config), true);

  fs.mkdirSync(path.join(where.chromium, 'GPUCache'), { recursive: true });
  for (const name of ['SingletonLock', 'lockfile', 'Local State', 'Network Persistent State']) fs.writeFileSync(path.join(where.chromium, name), 'x');
  lib.emptyFolder(where.chromium, lib.chromiumKeeps);
  assert.deepEqual(fs.readdirSync(where.chromium).sort(), ['Local State', 'SingletonLock', 'lockfile'], 'Chromium keeps its lock (Windows: lockfile) and the key session.bin is sealed with');
  assert.equal(lib.wsUrl('https://mimi.example.com'), 'wss://mimi.example.com/ws');
  assert.equal(lib.wsUrl('http://localhost:8787'), 'ws://localhost:8787/ws');
});

test('PC agent without shell: only file and browser tools inside the allowed folders are offered', async () => {
  const { PcAgent } = await import('@mimi/pc-agent');
  const full = new PcAgent({ url: 'ws://127.0.0.1:1/ws', token: 'x', allowedDirs: [home] }).offered();
  const limited = new PcAgent({ url: 'ws://127.0.0.1:1/ws', token: 'x', allowedDirs: [home], shell: false }).offered();
  for (const name of ['run_shell', 'power', 'stop_process']) {
    assert.ok(full.includes(name), name);
    assert.ok(!limited.includes(name), name);
  }
  assert.ok(full.some((name) => !limited.includes(name) && name.includes('mcp')), 'MCP servers on the PC go too');
  for (const name of ['read_file', 'write_file', 'list_dir', 'browser_open']) assert.ok(limited.includes(name), name);
});
