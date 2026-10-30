'use strict';
// The built-in browser of the desktop app: a real Chromium window with a profile of its own,
// so a site stays signed in between launches. The PC agent drives it over the DevTools
// protocol (packages/pc-agent/src/browser), exactly as it drives Edge or Chrome; the menu
// here is for using it by hand. It is started with --mimi-browser.

const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROFILE = process.env.MIMI_BROWSER_PROFILE || path.join(os.homedir(), '.mimi', 'browser-profile');
const HEADLESS = process.env.MIMI_BROWSER_HEADLESS === '1';
const START_URL = process.env.MIMI_BROWSER_START_URL || 'about:blank';
const PROMPT_PAGE = path.join(__dirname, 'browser-prompt.html');
const PROMPT_PRELOAD = path.join(__dirname, 'browser-prompt-preload.cjs');
const ICON_FILE = process.env.MIMI_ICON || path.join(__dirname, 'icon.png');
const ICON = fs.existsSync(ICON_FILE) ? ICON_FILE : undefined;
const windows = new Set();
const prompts = new Set();

/** http(s), plus the blank start page. A browser window here is not a general-purpose viewer. */
function allowedUrl(raw) {
  if (raw === 'about:blank') return true;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** What a person typed in the address bar: an address, or words for a web search. */
function normalizeAddress(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^(https?:|about:)/i.test(text)) return text;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

const active = () => BrowserWindow.getFocusedWindow() || [...windows].find((win) => !win.isDestroyed()) || null;

/** A normal Chrome user agent: sites that refuse embedded browsers otherwise block signing in. */
function chromeUserAgent() {
  const chrome = process.versions.chrome || '131.0.0.0';
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

const currentUrl = () => {
  const win = active();
  try {
    return win ? win.webContents.getURL() : '';
  } catch {
    return '';
  }
};

function updateTitle(win) {
  if (!win || win.isDestroyed()) return;
  const title = win.webContents.getTitle();
  win.setTitle(title && title !== 'about:blank' ? `${title} — Mimi Browser` : 'Mimi Browser');
}

function createBrowserWindow(url = START_URL, options = {}) {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    minHeight: 280,
    title: 'Mimi Browser',
    icon: ICON,
    show: false,
    backgroundColor: '#141618',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: process.env.MIMI_DEVTOOLS === '1',
      backgroundThrottling: false,
    },
  });
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  if (options.maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!HEADLESS) win.show();
  });

  const { webContents } = win;
  webContents.setUserAgent(chromeUserAgent());
  webContents.setWindowOpenHandler(({ url: target }) => {
    if (!allowedUrl(target)) return { action: 'deny' };
    // A link asking for a new window gets a real window: the PC agent sees every page as a tab.
    createBrowserWindow(target);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, target) => {
    if (!allowedUrl(target) && target !== 'about:blank') event.preventDefault();
  });
  webContents.on('will-redirect', (event, target) => {
    if (!allowedUrl(target)) event.preventDefault();
  });
  webContents.on('page-title-updated', () => updateTitle(win));
  webContents.on('did-navigate', () => updateTitle(win));
  webContents.on('did-navigate-in-page', () => updateTitle(win));
  webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.linkURL && allowedUrl(params.linkURL)) {
      items.push({ label: 'เปิดลิงก์ในหน้าต่างใหม่', click: () => createBrowserWindow(params.linkURL) });
      items.push({ label: 'คัดลอกที่อยู่ลิงก์', click: () => require('electron').clipboard.writeText(params.linkURL) });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    items.push({ label: 'ย้อนกลับ', enabled: webContents.navigationHistory.canGoBack(), click: () => webContents.navigationHistory.goBack() });
    items.push({ label: 'ถัดไป', enabled: webContents.navigationHistory.canGoForward(), click: () => webContents.navigationHistory.goForward() });
    items.push({ label: 'โหลดใหม่', click: () => webContents.reload() });
    items.push({ label: 'เปิดที่อยู่…', click: () => openAddressPrompt(win) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.loadURL(url).catch(() => {});
  return win;
}

async function clearBrowserData() {
  const win = active();
  const choice = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    buttons: ['ล้างข้อมูล', 'ยกเลิก'],
    defaultId: 1,
    cancelId: 1,
    message: 'ล้างคุกกี้และข้อมูลเว็บของ Mimi Browser?',
    detail: 'ทุกเว็บจะถูกออกจากระบบ และหน้าที่เปิดอยู่จะโหลดใหม่ ข้อมูลในแอป Mimi เองไม่ถูกแตะต้อง',
  });
  if (choice.response !== 0) return;
  await session.defaultSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'shadercache', 'websql', 'filesystem'],
  });
  await session.defaultSession.clearCache();
  for (const item of windows) if (!item.isDestroyed()) item.webContents.reload();
}

function openAddressPrompt(parent) {
  const win = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: Boolean(parent),
    width: 620,
    height: 196,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'เปิดที่อยู่',
    icon: ICON,
    show: false,
    backgroundColor: '#141618',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PROMPT_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  prompts.add(win);
  win.on('closed', () => prompts.delete(win));
  win.removeMenu();
  win.loadFile(PROMPT_PAGE, { query: { url: currentUrl() } });
  win.once('ready-to-show', () => win.show());
}

ipcMain.on('mimi-browser:address', (event, raw) => {
  const prompt = [...prompts].find((win) => !win.isDestroyed() && win.webContents === event.sender);
  if (!prompt) return;
  const parent = prompt.getParentWindow();
  prompt.close();
  const target = normalizeAddress(raw);
  if (!target || !allowedUrl(target)) {
    dialog.showErrorBox('ที่อยู่ไม่ถูกต้อง', 'Mimi Browser เปิดได้เฉพาะเว็บ http:// และ https://');
    return;
  }
  const win = parent && !parent.isDestroyed() ? parent : active();
  if (win) win.loadURL(target).catch(() => {});
});

ipcMain.on('mimi-browser:address-cancel', (event) => {
  const prompt = [...prompts].find((win) => !win.isDestroyed() && win.webContents === event.sender);
  if (prompt) prompt.close();
});

function browserMenu() {
  const mac = process.platform === 'darwin';
  const activeWindow = () => active();
  return [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'เบราว์เซอร์',
      submenu: [
        {
          label: 'ย้อนกลับ',
          accelerator: 'CmdOrCtrl+[',
          click: () => {
            const win = activeWindow();
            if (win && win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
          },
        },
        {
          label: 'ถัดไป',
          accelerator: 'CmdOrCtrl+]',
          click: () => {
            const win = activeWindow();
            if (win && win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
          },
        },
        { label: 'โหลดใหม่', accelerator: 'CmdOrCtrl+R', click: () => activeWindow()?.webContents.reload() },
        { type: 'separator' },
        { label: 'เปิดที่อยู่…', accelerator: 'CmdOrCtrl+L', click: () => openAddressPrompt(activeWindow()) },
        { label: 'หน้าเริ่มต้น', accelerator: 'CmdOrCtrl+Shift+H', click: () => activeWindow()?.loadURL(START_URL).catch(() => {}) },
        { type: 'separator' },
        { label: 'เปิดหน้าในเบราว์เซอร์ปกติ', click: () => { const url = currentUrl(); if (allowedUrl(url) && url !== 'about:blank') shell.openExternal(url); } },
        { label: 'ล้างคุกกี้และข้อมูลเว็บ…', click: () => void clearBrowserData() },
        { type: 'separator' },
        { role: 'close', label: 'ปิดหน้าต่าง' },
        ...(mac ? [] : [{ role: 'quit', label: 'ปิด Mimi Browser' }]),
      ],
    },
    { role: 'editMenu' },
  ];
}

/** Starts this same program in browser mode with its own profile and DevTools port. */
function launchBuiltInBrowser(profileDir, options = {}) {
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1180,820',
  ];
  if (app.isPackaged) args.push('--mimi-browser');
  else args.push(options.appScript || path.join(__dirname, 'remote.cjs'), '--mimi-browser');
  const env = { ...process.env, MIMI_BROWSER_PROFILE: profileDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

/** Runs the browser window (the program was started with --mimi-browser). */
function runBrowserShell() {
  app.setName('Mimi Browser');
  fs.mkdirSync(PROFILE, { recursive: true });
  app.setPath('userData', PROFILE);
  app.setPath('sessionData', PROFILE);
  app.setAppUserModelId('app.mimi.browser');
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const win = active();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', (event) => event.preventDefault());
    Menu.setApplicationMenu(Menu.buildFromTemplate(browserMenu()));
    createBrowserWindow(START_URL);
  });
}

module.exports = { launchBuiltInBrowser, runBrowserShell };
