'use strict';
// Mimi Workspace: a separate window with a browser, a folder tree and a terminal.
// It is opened from the tray menu or Settings; the window talks to this process over IPC.

const { BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const MAX_FILE = 1_500_000;
const MAX_ENTRIES = 2000;
const PAGE = path.join(__dirname, 'workspace.html');
const PRELOAD = path.join(__dirname, 'workspace-preload.cjs');

let win = null;
let root = '';
/** The running shell: `{ kind: 'pty', proc }` (node-pty) or `{ kind: 'pipe', proc }` (child process). */
let terminal = null;
/** node-pty, or null when it cannot load here (no prebuilt binary for this system); then a pipe is used. */
let ptyModule;

function loadPty() {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = require('node-pty');
  } catch (error) {
    console.warn(`workspace: no pseudo-terminal (${error.message}); the terminal falls back to a pipe`);
    ptyModule = null;
  }
  return ptyModule;
}

/** File URLs of the terminal emulator (xterm.js) for the page; empty when it is not installed. */
function terminalAssets() {
  try {
    return {
      xterm: pathToFileURL(require.resolve('@xterm/xterm/lib/xterm.js')).href,
      xtermCss: pathToFileURL(require.resolve('@xterm/xterm/css/xterm.css')).href,
      xtermFit: pathToFileURL(require.resolve('@xterm/addon-fit/lib/addon-fit.js')).href,
    };
  } catch {
    return {};
  }
}

function inside(rel) {
  if (!root) throw new Error('Choose a folder first.');
  const target = path.resolve(root, String(rel || ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('That path is outside the workspace folder.');
  return target;
}

function send(channel, value) {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  // A crashed or reloading page has no frame to send to ("Render frame was disposed").
  if (contents.isDestroyed() || contents.isCrashed()) return;
  try {
    contents.send(channel, value);
  } catch {
    // the page is going away
  }
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
  const current = terminal;
  terminal = null;
  if (!current) return;
  const { kind, proc } = current;
  if (kind === 'pipe') {
    try {
      proc.stdin.end();
    } catch {
      // already gone
    }
  }
  try {
    // A command the shell started (a dev server, ping -t) may have left the console, so the
    // whole tree goes, or it would keep running after "Restart".
    if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    else if (kind === 'pipe') proc.kill('SIGTERM');
  } catch {
    // already gone
  }
  if (kind === 'pty') {
    try {
      proc.kill();
    } catch {
      // already gone
    }
  }
}

/**
 * One typed line for the shell. PowerShell reads its piped stdin in the OEM code page, so a
 * line with Thai (or any non-ASCII) text goes as UTF-8 base64 and runs in the same scope.
 */
function shellLine(text) {
  const line = String(text ?? '').replace(/\r?\n$/, '');
  if (process.platform !== 'win32' || !/[^\x00-\x7f]/.test(line)) return `${line}\n`;
  const encoded = Buffer.from(line, 'utf8').toString('base64');
  return `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\n`;
}

const clampSize = (value, fallback, max) => Math.min(max, Math.max(2, Number.isInteger(value) ? value : fallback));

/**
 * Starts the shell. With node-pty it is a real terminal (ConPTY on Windows): colours, prompts,
 * Ctrl+C, full-screen programs and resizing work, and the page shows it with xterm.js. Without
 * it, a pipe with the line-by-line input box as before.
 */
function startTerminal(cwd, cols, rows) {
  stopTerminal();
  const workdir = cwd ? inside(cwd) : root || os.homedir();
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', POWERSHELL_TELEMETRY_OPTOUT: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const pty = loadPty();
  if (pty) {
    const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    const args = process.platform === 'win32' ? ['-NoLogo'] : ['-l'];
    let proc;
    try {
      proc = pty.spawn(shellPath, args, {
        name: 'xterm-256color',
        cols: clampSize(cols, 100, 500),
        rows: clampSize(rows, 30, 300),
        cwd: workdir,
        env,
        // The ConPTY that ships with node-pty: the same behaviour on every Windows 10/11 build,
        // and stopping it needs no helper process.
        useConptyDll: process.platform === 'win32',
      });
    } catch (error) {
      console.warn(`workspace: pseudo-terminal failed (${error.message}); using a pipe`);
      ptyModule = null;
      return startTerminal(cwd, cols, rows);
    }
    const current = { kind: 'pty', proc };
    terminal = current;
    proc.onData((data) => {
      if (terminal === current) send('workspace:terminal-data', data);
    });
    proc.onExit(({ exitCode }) => {
      if (terminal !== current) return;
      terminal = null;
      send('workspace:terminal-exit', exitCode ?? 0);
    });
    return { cwd: workdir, pty: true };
  }

  const shellPath = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : [];
  const child = spawn(shellPath, args, { cwd: workdir, env, windowsHide: true });
  const current = { kind: 'pipe', proc: child };
  terminal = current;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const push = (data) => send('workspace:terminal-data', cleanOutput(data));
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (error) => send('workspace:terminal-data', `\r\n${error.message}\r\n`));
  child.on('exit', (code) => {
    // A shell that was stopped or replaced (Restart, Ctrl+C, another folder) is not news:
    // its late exit would mark the new one as "exited".
    if (terminal !== current) return;
    terminal = null;
    send('workspace:terminal-exit', code ?? 0);
  });
  // Output in UTF-8 too, or Thai file names come out as "???".
  if (process.platform === 'win32') child.stdin.write('[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8\n');
  return { cwd: workdir, pty: false };
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
  win.loadFile(PAGE, { query: terminalAssets() });
  win.once('ready-to-show', () => win.show());
  // The shell belongs to the page that started it: when that page crashes or reloads, the
  // shell (and a dev server or ping -t it runs) goes too; the new page starts its own.
  let lastRecovery = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    stopTerminal();
    // A crashed page is a blank window; bring it back once, not in a loop.
    if (details.reason === 'clean-exit' || Date.now() - lastRecovery < 10_000) return;
    lastRecovery = Date.now();
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.webContents.reload();
    }, 500);
  });
  win.webContents.on('did-start-navigation', (details, _url, _inPlace, mainFrame) => {
    const isMain = details?.isMainFrame ?? mainFrame;
    const sameDocument = details?.isSameDocument ?? _inPlace;
    if (isMain && !sameDocument) stopTerminal();
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setUserAgent(userAgent());
    // Chromium writes cookies to disk in batches; a sign-in must survive the app being ended
    // abruptly (shutdown, update, crash), so each loaded page writes them out.
    guest.on('did-finish-load', () => void guest.session.cookies.flushStore().catch(() => {}));
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
  ipcMain.handle('workspace:terminal-start', (_event, cwd, cols, rows) => startTerminal(cwd, cols, rows));
  ipcMain.on('workspace:terminal-resize', (event, cols, rows) => {
    if (terminal?.kind !== 'pty' || !win || event.sender !== win.webContents) return;
    try {
      terminal.proc.resize(clampSize(cols, 100, 500), clampSize(rows, 30, 300));
    } catch {
      // shell closed
    }
  });
  ipcMain.handle('workspace:terminal-stop', () => {
    stopTerminal();
    return { ok: true };
  });
  ipcMain.on('workspace:terminal-input', (event, text) => {
    if (!terminal || !win || event.sender !== win.webContents) return;
    try {
      // A terminal takes keystrokes as they are; a pipe takes whole lines.
      if (terminal.kind === 'pty') terminal.proc.write(String(text ?? ''));
      else terminal.proc.stdin.write(shellLine(text));
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
