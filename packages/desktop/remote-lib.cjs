'use strict';
// The parts of the remote desktop app that need no Electron: checks, the config file, and
// where things are kept on this computer. Tested in packages/core/src/test/desktop-remote.test.ts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCK_CHOICES = [0, 5, 15, 30, 60];

/** Where this app keeps things, under the OS account's own folders. Nothing of a person's Mimi data is here. */
function locations(appData, cacheDir) {
  const root = path.join(appData, 'Mimi');
  return {
    root,
    /** Server URL, window place, auto-lock and PC agent choices: settings, no personal data. */
    config: path.join(root, 'config.json'),
    /** The session token, encrypted with the OS keychain (safeStorage); only while signed in. */
    session: path.join(root, 'session.bin'),
    /** Chromium's own folder. The window's web data is kept in memory; what Chromium still writes here is wiped. */
    chromium: path.join(root, 'chromium'),
    /** Temporary files of a signed-in session: the agent's browser profile. Wiped on sign-out. */
    cache: path.join(cacheDir, 'Mimi'),
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Only an origin; https, except a server on this computer. */
function normalizeServerUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error('ที่อยู่ไม่ถูกต้อง ใส่แบบ https://mimi.example.com');
  }
  const local = LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('ต้องเป็น https:// (http:// ใช้ได้เฉพาะเซิร์ฟเวอร์ในเครื่องนี้)');
  }
  if (url.username || url.password) throw new Error('ที่อยู่ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่านอยู่ข้างใน');
  return url.origin;
}

/** The PC agent may only use folders inside the OS account's home (and never the home itself). */
function folderProblem(dir, home) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return 'ต้องเป็นโฟลเดอร์แบบเต็ม (absolute path)';
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch {
    real = path.resolve(dir);
  }
  const homeReal = fs.existsSync(home) ? fs.realpathSync(home) : path.resolve(home);
  if (real === homeReal) return 'เลือกโฟลเดอร์ย่อยในโฮม ไม่ใช่โฮมทั้งหมด';
  if (!real.startsWith(homeReal + path.sep)) return 'ต้องอยู่ในโฮมของผู้ใช้เครื่องนี้';
  const first = real.slice(homeReal.length + 1).split(path.sep)[0];
  // Keychains, app data and SSH keys of the OS account stay out of reach.
  if (['Library', '.ssh', '.gnupg', 'AppData', '.mimi'].includes(first)) return `"${first}" เป็นโฟลเดอร์ของระบบ ใช้ไม่ได้`;
  return null;
}

function defaultConfig(home) {
  return {
    server: '',
    autoLockMinutes: 0,
    // shell: tools with the OS account's full rights (commands, power, MCP); off unless chosen.
    pcAgent: { enabled: false, shell: false, folders: [path.join(home, 'Mimi-Workspace')] },
    window: { bounds: null, maximized: false, hideOnBlur: false, onTop: false },
  };
}

function readConfig(file, home) {
  const base = defaultConfig(home);
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return base;
  }
  const folders = Array.isArray(saved.pcAgent?.folders) ? saved.pcAgent.folders.filter((dir) => folderProblem(dir, home) === null) : base.pcAgent.folders;
  let server = '';
  try {
    server = saved.server ? normalizeServerUrl(saved.server) : '';
  } catch {
    server = '';
  }
  return {
    server,
    autoLockMinutes: LOCK_CHOICES.includes(saved.autoLockMinutes) ? saved.autoLockMinutes : 0,
    pcAgent: {
      enabled: saved.pcAgent?.enabled === true,
      shell: saved.pcAgent?.shell === true,
      folders: folders.length > 0 ? folders : base.pcAgent.folders,
    },
    window: { ...base.window, ...(saved.window && typeof saved.window === 'object' ? saved.window : {}) },
  };
}

function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The agent's browser profile of one Mimi account on one server; the name does not reveal the account. */
function agentBrowserDir(cache, server, username) {
  const id = crypto.createHash('sha256').update(`${server}\n${username || ''}`).digest('hex').slice(0, 16);
  return path.join(cache, 'agent-browser', id);
}

function wsUrl(server) {
  const url = new URL('/ws', server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** Removes everything in a folder except the names `keep` matches. */
function emptyFolder(dir, keep = () => false) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (!keep(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

/** What is left of a signed-in session: the token file and the temporary cache. */
function wipeSession(where) {
  fs.rmSync(where.session, { force: true });
  fs.rmSync(where.cache, { recursive: true, force: true });
}

module.exports = {
  LOCK_CHOICES,
  agentBrowserDir,
  defaultConfig,
  emptyFolder,
  folderProblem,
  locations,
  normalizeServerUrl,
  readConfig,
  wipeSession,
  writeConfig,
  wsUrl,
};
