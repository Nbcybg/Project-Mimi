import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, resolveUserDir } from '../config.ts';
import { localAppDir, moveUserDataToDocuments } from '../app/user-home.ts';

// Every case uses a fake home folder: nothing here may touch the real Documents.
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-home-'));
  const home = path.join(base, 'home');
  const app = path.join(base, 'app');
  fs.mkdirSync(path.join(home, 'Documents'), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(base, 'local') } as NodeJS.ProcessEnv;
  return { base, home, app, env };
}

test('user data lives in Documents/Mimi, outside the app folder', () => {
  const { base, home, app, env } = sandbox();
  assert.deepEqual(resolveUserDir(app, env), { userDir: path.join(home, 'Documents', 'Mimi'), legacy: false });
  // MIMI_USER picks any folder; MIMI_ROOT (servers, tests) keeps it inside the root.
  assert.equal(resolveUserDir(app, { ...env, MIMI_USER: 'elsewhere' }).userDir, path.join(app, 'elsewhere'));
  assert.equal(resolveUserDir(app, { ...env, MIMI_ROOT: app }).userDir, path.join(app, 'user'));
  const config = loadConfig({ ...env, MIMI_ROOT: app });
  assert.equal(config.backupsDir, path.join(app, 'backups'));
  // The browser profiles are machine-local, unless a folder was picked by hand.
  assert.equal(localAppDir(config.dataDir, env), path.join(base, 'local', 'Mimi'));
  assert.equal(localAppDir(config.dataDir, { ...env, MIMI_USER: 'x' }), config.dataDir);
  fs.rmSync(base, { recursive: true, force: true });
});

test('an old install keeps working from <app>/user until the app moves it to Documents', () => {
  const { base, home, app, env } = sandbox();
  fs.mkdirSync(path.join(app, 'user', 'data', 'app-window', 'Default'), { recursive: true });
  fs.mkdirSync(path.join(app, 'user', 'agents', 'mimi'), { recursive: true });
  fs.writeFileSync(path.join(app, 'user', 'agents', 'mimi', 'agent.md'), 'x');
  fs.writeFileSync(path.join(app, 'user', 'data', 'mimi.db'), 'db');
  fs.writeFileSync(path.join(app, 'user', 'data', 'app-window', 'Default', 'Prefs'), '{}');
  fs.mkdirSync(path.join(app, 'backups'));
  fs.writeFileSync(path.join(app, 'backups', 'mimi-backup-1.tar.gz'), 'b');

  assert.deepEqual(resolveUserDir(app, env), { userDir: path.join(app, 'user'), legacy: true });
  assert.equal(moveUserDataToDocuments(app, { ...env, MIMI_ROOT: app }), null, 'a fixed root is never moved');

  const moved = moveUserDataToDocuments(app, env);
  const target = path.join(home, 'Documents', 'Mimi');
  assert.equal(moved, target);
  assert.equal(fs.existsSync(path.join(app, 'user')), false);
  assert.equal(fs.readFileSync(path.join(target, 'agents', 'mimi', 'agent.md'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(target, 'data', 'mimi.db'), 'utf8'), 'db');
  assert.ok(fs.existsSync(path.join(target, 'backups', 'mimi-backup-1.tar.gz')));
  // The window profile is a machine-local cache: it goes to LOCALAPPDATA, not Documents.
  assert.equal(fs.existsSync(path.join(target, 'data', 'app-window')), false);
  assert.ok(fs.existsSync(path.join(base, 'local', 'Mimi', 'app-window', 'Default', 'Prefs')));
  assert.deepEqual(resolveUserDir(app, env), { userDir: target, legacy: false });

  // Once moved (or with MIMI_USER) nothing happens again.
  assert.equal(moveUserDataToDocuments(app, env), null);
  assert.equal(moveUserDataToDocuments(app, { ...env, MIMI_USER: 'x' }), null);
  fs.rmSync(base, { recursive: true, force: true });
});
