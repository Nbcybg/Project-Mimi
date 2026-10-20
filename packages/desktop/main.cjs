'use strict';
// The native window of Mimi: one resizable chat window, a tray icon, notifications.
// Started by packages/core/src/app/launcher.ts, which runs the core; this process only shows it.
//
//   env  MIMI_CORE_URL   where the core listens, e.g. http://127.0.0.1:8787
//        MIMI_TOKEN      the core's token
//        MIMI_STATE_DIR  where the window remembers its size and place
//        MIMI_ICON       a PNG for the tray icon and the window
//   in   (node IPC)  { type: 'show', view? } | { type: 'balloon', title, body } | { type: 'quit' }
//   out  (node IPC)  { type: 'ready' } | { type: 'quit' }
//
// Closing the window hides it (the chat, scroll position and recording state stay as they are);
// only "Quit" in the tray menu ends the app.

const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, nativeTheme, screen, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const CORE = process.env.MIMI_CORE_URL;
const TOKEN = process.env.MIMI_TOKEN || '';
const STATE_FILE = path.join(process.env.MIMI_STATE_DIR || app.getPath('userData'), 'window-state.json');
const ICON = process.env.MIMI_ICON && fs.existsSync(process.env.MIMI_ICON) ? nativeImage.createFromPath(process.env.MIMI_ICON) : undefined;
const DEFAULT_SIZE = { width: 410, height: 820 }; // mobile mode: what the app is designed for
const MIN_SIZE = { width: 340, height: 560 };
const MARGIN = 12;
const VIEWS = ['chat', 'agents', 'hub', 'settings'];
const LABELS = { open: 'เปิดแชต', agents: 'Agent', hub: 'Hub', settings: 'ตั้งค่า', hide: 'ซ่อนเมื่อคลิกที่อื่น', top: 'อยู่บนสุดเสมอ', quit: 'ออกจาก Mimi' };

if (!CORE) {
  console.error('MIMI_CORE_URL is missing: this program is started by the Mimi launcher.');
  process.exit(1);
}
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('app.mimi');
nativeTheme.themeSource = 'dark';
Menu.setApplicationMenu(null);

// ---------- what is remembered ----------
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
let state = { bounds: null, maximized: false, hideOnBlur: false, onTop: false, ...readState() };
let saveTimer = null;
const saveState = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch {
      // not being able to remember a size is no reason to stop
    }
  }, 300);
};

/** The remembered place if it is still on a screen; else the corner above the tray. */
function startBounds() {
  const saved = state.bounds;
  if (saved && screen.getAllDisplays().some((display) => overlaps(display.workArea, saved))) return saved;
  const area = screen.getPrimaryDisplay().workArea;
  const height = Math.min(DEFAULT_SIZE.height, area.height - 2 * MARGIN);
  return { ...DEFAULT_SIZE, height, x: area.x + area.width - DEFAULT_SIZE.width - MARGIN, y: area.y + area.height - height - MARGIN };
}
const overlaps = (area, box) => box.x < area.x + area.width && box.x + box.width > area.x && box.y < area.y + area.height && box.y + box.height > area.y;

// ---------- the window ----------
let win = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    ...startBounds(),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Mimi',
    icon: ICON,
    backgroundColor: '#0e1530',
    autoHideMenuBar: true,
    alwaysOnTop: state.onTop,
    show: false,
    webPreferences: { spellcheck: false, devTools: process.env.MIMI_DEVTOOLS === '1', backgroundThrottling: false },
  });
  win.removeMenu();
  if (state.maximized) win.maximize();
  win.loadURL(`${CORE}/#token=${TOKEN}`);
  win.once('ready-to-show', () => win.show());

  // Closing hides: nothing of the chat is lost, the tray icon brings it back.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('blur', () => {
    if (state.hideOnBlur && !win.webContents.isDevToolsOpened()) win.hide();
  });
  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    state.maximized = win.isMaximized();
    if (!state.maximized && !win.isFullScreen()) state.bounds = win.getBounds();
    saveState();
  };
  win.on('resize', remember);
  win.on('move', remember);

  const { webContents } = win;
  webContents.setVisualZoomLevelLimits(1, 1); // no pinch zoom: it is an app, not a page
  webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(CORE)) shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(CORE)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // Only text gets a context menu (copy, paste); the rest of the app is not a web page.
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
  if (view && VIEWS.includes(view)) {
    win.webContents.executeJavaScript(`window.Mimi && window.Mimi.setView(${JSON.stringify(view)})`).catch(() => {});
  }
}

// ---------- the tray ----------
let tray = null;

function buildMenu() {
  const template = [
    { label: LABELS.open, click: () => showWindow('chat') },
    ...['agents', 'hub', 'settings'].map((view) => ({ label: LABELS[view], click: () => showWindow(view) })),
    { type: 'separator' },
    { label: LABELS.hide, type: 'checkbox', checked: state.hideOnBlur, click: (item) => ((state.hideOnBlur = item.checked), saveState()) },
    {
      label: LABELS.top,
      type: 'checkbox',
      checked: state.onTop,
      click: (item) => {
        state.onTop = item.checked;
        win?.setAlwaysOnTop(state.onTop);
        saveState();
      },
    },
    { type: 'separator' },
    { label: LABELS.quit, click: () => quit() },
  ];
  return Menu.buildFromTemplate(template);
}

function createTray() {
  tray = new Tray(ICON ? ICON.resize({ width: 32, height: 32 }) : nativeImage.createEmpty());
  tray.setToolTip('Mimi');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
}

function quit() {
  quitting = true;
  if (process.connected) process.send({ type: 'quit' });
  app.quit();
}

// ---------- the launcher's commands ----------
function listen() {
  process.on('message', (message) => {
    if (message.type === 'show') showWindow(message.view);
    else if (message.type === 'quit') quit();
    else if (message.type === 'balloon' && Notification.isSupported()) {
      const notice = new Notification({ title: message.title || 'Mimi', body: message.body || '', icon: ICON });
      notice.on('click', () => showWindow());
      notice.show();
    }
  });
  process.on('disconnect', () => quit()); // the launcher is gone
}

app.on('second-instance', () => showWindow());
// Closing the last window must not end the app: it lives in the tray.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  // The microphone and the camera are for the chat; nothing else is asked for.
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowed.has(permission) && contents.getURL().startsWith(CORE)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => allowed.has(permission) && (contents?.getURL() ?? CORE).startsWith(CORE));
  createTray();
  createWindow();
  listen();
  if (process.connected) process.send({ type: 'ready' });
});
