'use strict';
// Mimi Workspace: a separate window with a browser, a folder tree and a terminal.
// It is opened from the tray menu or Settings; the window talks to this process over IPC.

const { BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_FILE = 1_500_000;
const MAX_ENTRIES = 2000;
const PAGE = path.join(__dirname, 'workspace.html');
const PRELOAD = path.join(__dirname, 'workspace-preload.cjs');

let win = null;
let root = '';
let terminal = null;

function inside(rel) {
  if (!root) throw new Error('Choose a folder first.');
  const target = path.resolve(root, String(rel || ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('That path is outside the workspace folder.');
  return target;
}

function send(channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function cleanOutput(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

async function listDirectory(rel) {
  const dir = inside(rel);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    let size = 0;
    try {
      size = (await fs.promises.stat(full)).size;
    } catch {
      // vanished while reading
    }
    rows.push({ name: entry.name, dir: entry.isDirectory(), size });
    if (rows.length >= MAX_ENTRIES) break;
  }
  rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: path.relative(root, dir).split(path.sep).join('/'), entries: rows, root };
}

async function readFile(rel) {
  const file = inside(rel);
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('That is not a file.');
  if (stat.size > MAX_FILE) throw new Error(`This file is too large to open here (${Math.round(stat.size / 1024)} KB).`);
  const buffer = await fs.promises.readFile(file);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error('This looks like a binary file.');
  return { text: buffer.toString('utf8'), size: stat.size };
}

async function writeFile(rel, text) {
  const file = inside(rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, String(text ?? ''), 'utf8');
  return { ok: true };
}

function stopTerminal() {
  const child = terminal;
  terminal = null;
  if (!child) return;
  try {
    child.stdin.end();
  } catch {
    // already gone
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

function startTerminal(cwd) {
  stopTerminal();
  const workdir = cwd ? inside(cwd) : root || os.homedir();
  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : [];
  const env = { ...process.env, TERM: 'xterm-256color', POWERSHELL_TELEMETRY_OPTOUT: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(shellPath, args, { cwd: workdir, env, windowsHide: true });
  terminal = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const push = (data) => send('workspace:terminal-data', cleanOutput(data));
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (error) => send('workspace:terminal-data', `\r\n${error.message}\r\n`));
  child.on('exit', (code) => {
    if (terminal === child) terminal = null;
    send('workspace:terminal-exit', code ?? 0);
  });
  return { cwd: workdir };
}

function userAgent() {
  const chrome = process.versions.chrome || '131.0.0.0';
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function createWindow(options = {}) {
  let start = options.defaultRoot ? path.resolve(options.defaultRoot) : path.join(os.homedir(), 'Mimi-Workspace');
  try {
    fs.mkdirSync(start, { recursive: true });
  } catch {
    start = path.join(os.homedir(), 'Mimi-Workspace');
    fs.mkdirSync(start, { recursive: true });
  }
  root = start;
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 580,
    title: 'Mimi Workspace',
    icon: options.icon,
    backgroundColor: '#171215',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(PAGE);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setUserAgent(userAgent());
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) send('workspace:open-url', url);
      return { action: 'deny' };
    });
  });
  win.on('closed', () => {
    stopTerminal();
    win = null;
  });
}

function openWorkspace(options = {}) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }
  createWindow(options);
  return win;
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  ipcMain.handle('workspace:root', () => ({ root, home: os.homedir() }));
  ipcMain.handle('workspace:choose-root', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(owner || undefined, { title: 'โฟลเดอร์สำหรับ Workspace', defaultPath: root || os.homedir(), properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    root = path.resolve(picked.filePaths[0]);
    stopTerminal();
    return { root };
  });
  ipcMain.handle('workspace:list', (_event, rel) => listDirectory(rel));
  ipcMain.handle('workspace:read', (_event, rel) => readFile(rel));
  ipcMain.handle('workspace:write', (_event, rel, text) => writeFile(rel, text));
  ipcMain.handle('workspace:terminal-start', (_event, cwd) => startTerminal(cwd));
  ipcMain.handle('workspace:terminal-stop', () => {
    stopTerminal();
    return { ok: true };
  });
  ipcMain.on('workspace:terminal-input', (event, text) => {
    if (!terminal || !win || event.sender !== win.webContents) return;
    try {
      terminal.stdin.write(String(text ?? ''));
    } catch {
      // shell closed
    }
  });
  ipcMain.handle('workspace:open-external', (_event, raw) => {
    let parsed;
    try {
      parsed = new URL(String(raw));
    } catch {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    shell.openExternal(parsed.toString()).catch(() => {});
    return true;
  });
}

module.exports = {
  openWorkspace: (options = {}) => {
    wire();
    return openWorkspace(options);
  },
};
