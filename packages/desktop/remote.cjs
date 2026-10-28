'use strict';
// The Mimi desktop app for a Mimi server elsewhere (the accounts gateway, or one core).
// It is only a window onto that server: no core, no database and no files of anyone's
// Mimi live on this computer. What it keeps (remote-lib.cjs, locations()):
//   config.json  server address, window place, auto-lock and PC agent choices (no personal data)
//   session.bin  the session token, encrypted by the OS keychain (safeStorage), while signed in
//   chromium/    Chromium's own folder: the window's web data is kept in memory, the rest is wiped
//   <cache>/Mimi the agent's browser profile while signed in, when the PC agent is on
// Signing out (in the app, from the tray, by auto-lock, or an expired session) ends the
// session on the server, stops the PC agent, wipes all of that except config.json, and
// restarts the app at the sign-in page. Closing the window only hides it (tray).
//
// The packaged app is built by scripts/build-mac.mjs; from the sources: npm run desktop

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const lib = require('./remote-lib.cjs');

const home = os.homedir();
app.setName('Mimi');
const where = lib.locations(app.getPath('appData'), app.getPath('cache'));
app.setPath('userData', where.chromium);
app.setPath('sessionData', where.chromium);
app.setPath('crashDumps', path.join(where.chromium, 'Crashpad'));

// A packaged app takes no debugging switches: they would hand the signed-in window to any program.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'];
if (app.isPackaged && DEBUG_SWITCHES.some((name) => app.commandLine.hasSwitch(name))) process.exit(1);
// From the sources only: a test may drive the window over the DevTools protocol.
if (!app.isPackaged && process.env.MIMI_DESKTOP_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.MIMI_DESKTOP_DEBUG_PORT);

if (!app.requestSingleInstanceLock()) process.exit(0);
// Leftovers of earlier runs in Chromium's folder (caches, crash dumps) go before it is used.
lib.emptyFolder(where.chromium, (name) => name.startsWith('Singleton'));

app.setAppUserModelId('app.mimi');
nativeTheme.themeSource = 'dark';
Menu.setApplicationMenu(null);

const PARTITION = 'mimi'; // no "persist:" prefix: cookies, storage and cache live in memory only
const CONNECT_PAGE = path.join(__dirname, 'connect.html');
const ICON_FILE = path.join(__dirname, 'icon.png');
const ICON = fs.existsSync(ICON_FILE) ? nativeImage.createFromPath(ICON_FILE) : undefined;
const DEFAULT_SIZE = { width: 410, height: 820 };
const MIN_SIZE = { width: 340, height: 560 };
const MARGIN = 12;
const VIEWS = ['chat', 'agents', 'hub', 'settings'];

let config = lib.readConfig(where.config, home);
let saveTimer = null;
const saveConfig = (now = false) => {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      lib.writeConfig(where.config, config);
    } catch {
      // not being able to remember a window size is no reason to stop
    }
  };
  if (now) write();
  else saveTimer = setTimeout(write, 300);
};

// ---------- the session ----------

/** { token, username, remember } while signed in. */
let current = null;
let quitting = false;

/** True when safeStorage really encrypts (Linux without a keyring would only obfuscate). */
const keychainUsable = () =>
  safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');

function loadSession() {
  try {
    if (!keychainUsable() || !config.server) return null;
    const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(where.session)));
    if (saved.server !== config.server || typeof saved.token !== 'string') return null;
    return { token: saved.token, username: String(saved.username || ''), remember: true };
  } catch {
    return null;
  }
}

function storeSession() {
  if (!current?.remember || !keychainUsable()) {
    fs.rmSync(where.session, { force: true });
    return;
  }
  fs.mkdirSync(where.root, { recursive: true });
  const sealed = safeStorage.encryptString(JSON.stringify({ server: config.server, token: current.token, username: current.username }));
  fs.writeFileSync(where.session, sealed, { mode: 0o600 });
}

async function revokeOnServer(token) {
  if (!config.server || !token) return;
  try {
    await fetch(`${config.server}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  } catch {
    // offline: the session lapses on the server by itself
  }
}

let signingOut = false;
/**
 * Ends this device's session and wipes what the app kept for it (all but config.json).
 * `then`: 'relaunch' (back at the sign-in page), 'quit', or 'connect' (choose another server).
 */
async function signOut(reason, then = 'relaunch') {
  if (signingOut) return;
  signingOut = true;
  const was = current;
  current = null;
  await stopPcAgent();
  if (was) await revokeOnServer(was.token);
  const web = session.fromPartition(PARTITION);
  await Promise.allSettled([web.clearStorageData(), web.clearCache(), web.clearAuthCache()]);
  lib.wipeSession(where);
  if (reason === 'locked' && Notification.isSupported()) {
    new Notification({ title: 'Mimi ออกจากระบบแล้ว', body: 'ไม่ได้ใช้งานนานเกินเวลาที่ตั้งไว้ เข้าสู่ระบบใหม่เพื่อใช้ต่อ', icon: ICON }).show();
  }
  if (then === 'connect') {
    config.server = '';
    saveConfig(true);
  }
  quitting = true;
  // Restarting lets Chromium's folder be emptied before anything uses it again.
  if (then !== 'quit') app.relaunch({ args: process.argv.slice(1) });
  app.exit(0);
}

// ---------- the PC agent ----------

/** { child, stopping } while the PC agent runs. */
let pc = null;
let pcStatus = 'ปิด';
let pcRetryMs = 2000;

function pcAgentEntry() {
  return path.join(path.dirname(require.resolve('@mimi/pc-agent')), 'main.ts');
}

function startPcAgent() {
  if (pc || !current || !config.server || !config.pcAgent.enabled) return;
  const folders = config.pcAgent.folders.filter((dir) => lib.folderProblem(dir, home) === null);
  if (folders.length === 0) {
    pcStatus = 'ไม่มีโฟลเดอร์ที่ใช้ได้';
    refreshMenu();
    return;
  }
  for (const dir of folders) fs.mkdirSync(dir, { recursive: true });
  // Only what a shell needs, plus where to connect. The token goes through stdin, not the
  // environment, which other programs of this OS account could read.
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    USER: os.userInfo().username,
    LANG: process.env.LANG || 'en_US.UTF-8',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
    MIMI_TOKEN_STDIN: '1',
    MIMI_PC_SHELL: config.pcAgent.shell ? '1' : '0',
    MIMI_CORE_URL: lib.wsUrl(config.server),
    ALLOWED_DIRS: folders.join(';'),
    MIMI_BROWSER_PROFILE: lib.agentBrowserDir(where.cache, config.server, current.username),
    MIMI_PC_NAME: `${os.userInfo().username}@${os.hostname()}`,
  };
  const child = spawn(process.execPath, [pcAgentEntry()], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const running = { child, stopping: false };
  pc = running;
  pcStatus = 'กำลังเชื่อมต่อ…';
  child.stdin.write(`${current.token}\n`); // stdin stays open: closing it stops the agent
  const watch = (data) => {
    const text = String(data);
    if (/connected to /.test(text)) {
      pcStatus = 'เชื่อมต่อแล้ว';
      pcRetryMs = 2000;
    } else if (/rejected the token/.test(text)) {
      pcStatus = 'เซิร์ฟเวอร์ไม่รับ';
    } else if (/disconnected/.test(text)) {
      pcStatus = 'หลุด กำลังต่อใหม่…';
    }
    refreshMenu();
  };
  child.stdout.on('data', watch);
  child.stderr.on('data', watch);
  child.on('error', () => {});
  child.on('exit', () => {
    if (pc === running) pc = null;
    if (running.stopping || !current || !config.pcAgent.enabled) {
      pcStatus = 'ปิด';
    } else {
      pcStatus = 'หยุดไป กำลังเริ่มใหม่…';
      setTimeout(startPcAgent, pcRetryMs);
      pcRetryMs = Math.min(pcRetryMs * 2, 60_000);
    }
    refreshMenu();
  });
  refreshMenu();
}

/** Stops the PC agent at once; it closes its browser on the way out (a few seconds at most). */
function stopPcAgent() {
  const running = pc;
  pc = null;
  if (!running) return Promise.resolve();
  running.stopping = true;
  return new Promise((resolve) => {
    const killer = setTimeout(() => running.child.kill('SIGKILL'), 4000);
    running.child.once('exit', () => {
      clearTimeout(killer);
      resolve();
    });
    running.child.stdin.end();
    running.child.kill('SIGTERM');
  });
}

async function setPcAgent(enabled) {
  if (enabled && !config.pcAgent.enabled) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['เปิดใช้', 'ยกเลิก'],
      defaultId: 1,
      cancelId: 1,
      message: 'ให้ Mimi ใช้เครื่องนี้?',
      detail:
        `agent บนเซิร์ฟเวอร์จะสั่งงานบนเครื่องนี้ได้ในชื่อผู้ใช้ "${os.userInfo().username}": อ่าน/เขียนไฟล์ในโฟลเดอร์ที่อนุญาต ` +
        `รันคำสั่ง และเปิดเบราว์เซอร์ของ agent (คำสั่งที่เสี่ยงยังต้องให้คุณกดอนุญาตในแชต)\n\nโฟลเดอร์ที่อนุญาต:\n${config.pcAgent.folders.join('\n')}`,
    });
    if (response !== 0) return refreshMenu();
  }
  config.pcAgent.enabled = enabled;
  saveConfig(true);
  if (enabled) startPcAgent();
  else await stopPcAgent();
  refreshMenu();
}

async function setPcShell(enabled) {
  if (enabled) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['อนุญาต', 'ยกเลิก'],
      defaultId: 1,
      cancelId: 1,
      message: 'ให้ Mimi รันคำสั่งบนเครื่องนี้?',
      detail:
        `คำสั่ง (shell), ปิด/หยุดโปรแกรม, ปิดเครื่อง และ MCP server บนเครื่องนี้ ทำงานด้วยสิทธิ์เต็มของผู้ใช้ "${os.userInfo().username}" ` +
        'ไม่ได้จำกัดอยู่ในโฟลเดอร์ที่อนุญาต (อ่านไฟล์อื่นในโฮมได้) ทุกคำสั่งยังต้องให้คุณกดอนุญาตในแชต',
    });
    if (response !== 0) return refreshMenu();
  }
  config.pcAgent.shell = enabled;
  saveConfig(true);
  if (pc) {
    await stopPcAgent();
    startPcAgent();
  }
  refreshMenu();
}

async function chooseFolders() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'โฟลเดอร์ที่ Mimi ใช้ได้บนเครื่องนี้',
    defaultPath: config.pcAgent.folders[0] ?? home,
    properties: ['openDirectory', 'createDirectory', 'multiSelections'],
  });
  if (canceled || filePaths.length === 0) return;
  const problems = filePaths.map((dir) => [dir, lib.folderProblem(dir, home)]).filter(([, problem]) => problem);
  if (problems.length > 0) {
    await dialog.showMessageBox({ type: 'error', message: 'ใช้โฟลเดอร์นี้ไม่ได้', detail: problems.map(([dir, problem]) => `${dir}: ${problem}`).join('\n') });
    return;
  }
  config.pcAgent.folders = filePaths;
  saveConfig(true);
  if (pc) {
    await stopPcAgent();
    startPcAgent();
  }
  refreshMenu();
}

// ---------- auto-lock (off unless chosen in the tray) ----------

setInterval(() => {
  if (current && config.autoLockMinutes > 0 && powerMonitor.getSystemIdleTime() >= config.autoLockMinutes * 60) void signOut('locked');
}, 30_000).unref();

// ---------- the window ----------

let win = null;

function startBounds() {
  const saved = config.window.bounds;
  const overlaps = (area, box) => box.x < area.x + area.width && box.x + box.width > area.x && box.y < area.y + area.height && box.y + box.height > area.y;
  if (saved && screen.getAllDisplays().some((display) => overlaps(display.workArea, saved))) return saved;
  const area = screen.getPrimaryDisplay().workArea;
  const height = Math.min(DEFAULT_SIZE.height, area.height - 2 * MARGIN);
  return { ...DEFAULT_SIZE, height, x: area.x + area.width - DEFAULT_SIZE.width - MARGIN, y: area.y + area.height - height - MARGIN };
}

const isServerUrl = (url) => {
  try {
    return Boolean(config.server) && new URL(url).origin === config.server;
  } catch {
    return false;
  }
};
const isConnectPage = (url) => typeof url === 'string' && url.split(/[?#]/)[0] === pathToFileURL(CONNECT_PAGE).href;

function loadApp() {
  if (!win || win.isDestroyed()) return;
  if (!config.server) win.loadFile(CONNECT_PAGE);
  // The token rides in the fragment, which never reaches the server; the page keeps it in memory.
  else win.loadURL(current ? `${config.server}/#token=${encodeURIComponent(current.token)}` : `${config.server}/`);
}

function createWindow() {
  win = new BrowserWindow({
    ...startBounds(),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Mimi',
    icon: ICON,
    backgroundColor: '#0e1530',
    autoHideMenuBar: true,
    alwaysOnTop: config.window.onTop,
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged && process.env.MIMI_DEVTOOLS === '1',
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  if (config.window.maximized) win.maximize();
  loadApp();
  win.once('ready-to-show', () => win.show());

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('blur', () => {
    if (config.window.hideOnBlur && !win.webContents.isDevToolsOpened()) win.hide();
  });
  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    config.window.maximized = win.isMaximized();
    if (!config.window.maximized && !win.isFullScreen()) config.window.bounds = win.getBounds();
    saveConfig();
  };
  win.on('resize', remember);
  win.on('move', remember);

  const { webContents } = win;
  webContents.setVisualZoomLevelLimits(1, 1);
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isServerUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isServerUrl(url) || isConnectPage(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function showWindow(view) {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view && VIEWS.includes(view) && current) {
    win.webContents.executeJavaScript(`window.Mimi && window.Mimi.setView(${JSON.stringify(view)})`).catch(() => {});
  }
}

// ---------- the tray ----------

let tray = null;

function buildMenu() {
  const signedIn = Boolean(current);
  const lockLabel = (minutes) => (minutes === 0 ? 'ปิด' : `ไม่ได้ใช้ ${minutes} นาที`);
  return Menu.buildFromTemplate([
    { label: 'เปิด Mimi', click: () => showWindow('chat') },
    ...(signedIn ? [['agents', 'Agent'], ['hub', 'Hub'], ['settings', 'ตั้งค่า']].map(([view, label]) => ({ label, click: () => showWindow(view) })) : []),
    { type: 'separator' },
    {
      label: 'ให้ Mimi ใช้เครื่องนี้ (PC agent)',
      type: 'checkbox',
      checked: config.pcAgent.enabled,
      click: (item) => void setPcAgent(item.checked),
    },
    { label: `   สถานะ: ${config.pcAgent.enabled ? (signedIn ? pcStatus : 'รอเข้าสู่ระบบ') : 'ปิด'}`, enabled: false },
    { label: 'โฟลเดอร์ที่ Mimi ใช้ได้…', click: () => void chooseFolders() },
    {
      label: 'อนุญาตให้รันคำสั่งบนเครื่องนี้ (shell)',
      type: 'checkbox',
      checked: config.pcAgent.shell,
      enabled: config.pcAgent.enabled,
      click: (item) => void setPcShell(item.checked),
    },
    {
      label: 'ออกจากระบบอัตโนมัติ',
      submenu: lib.LOCK_CHOICES.map((minutes) => ({
        label: lockLabel(minutes),
        type: 'radio',
        checked: config.autoLockMinutes === minutes,
        click: () => {
          config.autoLockMinutes = minutes;
          saveConfig(true);
        },
      })),
    },
    { type: 'separator' },
    { label: 'ซ่อนเมื่อคลิกที่อื่น', type: 'checkbox', checked: config.window.hideOnBlur, click: (item) => ((config.window.hideOnBlur = item.checked), saveConfig()) },
    {
      label: 'อยู่บนสุดเสมอ',
      type: 'checkbox',
      checked: config.window.onTop,
      click: (item) => {
        config.window.onTop = item.checked;
        win?.setAlwaysOnTop(item.checked);
        saveConfig();
      },
    },
    { type: 'separator' },
    ...(config.server ? [{ label: 'เปลี่ยนเซิร์ฟเวอร์…', click: () => void signOut('server', 'connect') }] : []),
    ...(signedIn ? [{ label: 'ออกจากระบบ', click: () => void signOut('logout') }] : []),
    { label: 'ออกจาก Mimi', click: () => app.quit() },
  ]);
}

function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  tray.setToolTip(current ? `Mimi${current.username ? ` · ${current.username}` : ''}` : 'Mimi');
}

function createTray() {
  tray = new Tray(ICON ? ICON.resize({ width: process.platform === 'darwin' ? 18 : 32, height: process.platform === 'darwin' ? 18 : 32 }) : nativeImage.createEmpty());
  if (!ICON && process.platform === 'darwin') tray.setTitle('Mimi');
  refreshMenu();
  tray.on('click', () => {
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
}

// ---------- the pages' calls (preload.cjs) ----------

ipcMain.handle('mimi:signed-in', (event, value) => {
  if (!isServerUrl(event.senderFrame?.url) || typeof value?.token !== 'string' || !value.token || value.token.length > 400) return false;
  current = { token: value.token, username: String(value.username || '').slice(0, 64), remember: value.remember !== false };
  storeSession();
  refreshMenu();
  startPcAgent();
  return true;
});

ipcMain.handle('mimi:signed-out', (event, reason) => {
  if (!isServerUrl(event.senderFrame?.url)) return false;
  void signOut(reason === 'expired' ? 'expired' : 'logout');
  return true;
});

ipcMain.handle('mimi:server', (event) => (isConnectPage(event.senderFrame?.url) ? config.server : ''));

ipcMain.handle('mimi:set-server', async (event, raw) => {
  if (!isConnectPage(event.senderFrame?.url)) return { ok: false, error: 'ไม่อนุญาต' };
  let server;
  try {
    server = lib.normalizeServerUrl(raw);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    const health = await (await fetch(`${server}/health`, { signal: AbortSignal.timeout(8000) })).json();
    if (health?.ok !== true) throw new Error('not Mimi');
  } catch {
    return { ok: false, error: 'ติดต่อเซิร์ฟเวอร์นี้ไม่ได้ หรือไม่ใช่เซิร์ฟเวอร์ Mimi' };
  }
  config.server = server;
  saveConfig(true);
  loadApp();
  refreshMenu();
  return { ok: true };
});

// ---------- start and stop ----------

// Ended by the system or a terminal: the same way out as "Quit" in the tray.
// A quit asked for while the app is still starting can be lost; it ends anyway, after the
// sign-out of a "not my device" session has had its time.
const quitFromSignal = () => {
  app.quit();
  setTimeout(() => app.exit(0), 12_000).unref();
};
process.on('SIGTERM', quitFromSignal);
process.on('SIGINT', quitFromSignal);
app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {}); // lives in the tray
app.on('before-quit', (event) => {
  if (quitting) return;
  // "Not my device": nothing of the session outlives the app.
  if (current && !current.remember) {
    event.preventDefault();
    void signOut('quit', 'quit');
    return;
  }
  quitting = true;
  void stopPcAgent();
});

app.whenReady().then(() => {
  const web = session.fromPartition(PARTITION);
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write']);
  web.setPermissionRequestHandler((contents, permission, callback) => callback(allowed.has(permission) && isServerUrl(contents.getURL())));
  web.setPermissionCheckHandler((contents, permission) => allowed.has(permission) && isServerUrl(contents?.getURL() ?? ''));
  powerMonitor.on('lock-screen', () => {
    if (current && config.autoLockMinutes > 0) void signOut('locked');
  });
  current = loadSession();
  if (!current) fs.rmSync(where.cache, { recursive: true, force: true }); // signed out: no temporary files either
  createTray();
  createWindow();
  startPcAgent();
});
