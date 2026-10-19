import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.ts';
import { APP_VERSION, type MimiServer, startServer } from '../server/server.ts';
import { AppSettings } from './app-settings.ts';
import { renderIconPng } from './icon.ts';
import { localAppDir, moveUserDataToDocuments } from './user-home.ts';

// The desktop app: starts the core on this machine and shows the client in a window of
// its own. Everything the user needs to configure is done inside the window.
//
// On Windows it lives in the notification area (tray): a click on the icon pops up a
// phone-sized chat window in the corner above the taskbar; Settings, Agents and the Hub
// open in a normal desktop-sized window. MIMI_TRAY=0 keeps the old one-window app that
// quits when its window is closed.

/** A Chromium browser that can show a page as a chrome-less app window. */
function findAppBrowser(): string | null {
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(
    (root): root is string => Boolean(root),
  );
  const candidates =
    process.platform === 'win32'
      ? roots.flatMap((root) => [
          path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
          path.join(root, 'Google/Chrome/Application/chrome.exe'),
        ])
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function openInDefaultBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).unref();
}

async function isMimiRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return ((await response.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

// A copy from before the data moved to Documents goes there now, while nothing runs.
const startConfig = loadConfig();
if (!(await isMimiRunning(startConfig.port))) {
  try {
    const moved = moveUserDataToDocuments(startConfig.rootDir);
    if (moved) process.stdout.write(`moved the user data to ${moved}\n`);
  } catch (error) {
    process.stdout.write(`could not move the user data to Documents: ${(error as Error).message}\n`);
  }
}

const bootConfig = loadConfig();
const settings = AppSettings.load(bootConfig.appSettingsPath);
settings.applyToEnv(process.env);
const config = loadConfig(); // again, now with the folders chosen in the app
fs.mkdirSync(config.allowedDirs[0]!, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });
const useTray = process.platform === 'win32' && process.env.MIMI_TRAY !== '0';

// Started from the desktop shortcut there is no console, so keep a log file.
const logFile = path.join(config.dataDir, 'app.log');
const log = (line: string) => {
  const entry = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(entry);
  try {
    fs.appendFileSync(logFile, entry);
  } catch {
    // logging must never stop the app
  }
};
process.on('uncaughtException', (error) => {
  log(`fatal: ${error.stack ?? error.message}`);
  process.exit(1);
});
log(`user data: ${config.userDir}`);

// ---------- windows ----------

type WindowKind = 'phone' | 'desktop';
/** The chat flyout, in device-independent pixels (the tray helper scales it per screen). */
const PHONE = { width: 410, height: 820, margin: 12 };
const DESKTOP = { width: 1200, height: 840 };
const windows: Partial<Record<WindowKind, ChildProcess>> = {};

function pageUrl(port: number, kind: WindowKind | 'single', view?: string): string {
  const query = new URLSearchParams();
  if (kind === 'phone') query.set('ui', 'compact');
  if (view) query.set('view', view);
  const search = query.size ? `?${query}` : '';
  return `http://127.0.0.1:${port}/${search}#token=${settings.token}`;
}

/**
 * Opens a client window. Each kind has its own browser profile (kept in the machine-local
 * folder, not in Documents), so it is a process of its own that the tray can find.
 * Resolves when the window's process ends (or never, with a plain browser tab).
 */
function openWindow(port: number, kind: WindowKind | 'single', view?: string): Promise<void> {
  const url = pageUrl(port, kind, view);
  const browser = findAppBrowser();
  if (!browser) {
    log('no Edge/Chrome found; opening the default browser instead');
    openInDefaultBrowser(url);
    return new Promise(() => {});
  }
  const size = kind === 'phone' ? `${PHONE.width},${PHONE.height}` : kind === 'desktop' ? `${DESKTOP.width},${DESKTOP.height}` : '1100,820';
  const profile = kind === 'desktop' ? 'app-window-desktop' : 'app-window';
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${path.join(localAppDir(config.dataDir), profile)}`,
      `--window-size=${size}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      // An app window, not a browser: no sign-in / sync prompts, no "restore pages" bubble.
      '--disable-sync',
      '--disable-features=msImplicitSignin,msEdgeSyncConsent,msShowRestoreBubble,Translate',
      '--hide-crash-restore-bubble',
    ],
    { stdio: 'ignore' },
  );
  if (kind !== 'single') windows[kind] = child;
  return new Promise((resolve) => {
    child.on('exit', () => {
      if (kind !== 'single' && windows[kind] === child) delete windows[kind];
      resolve();
    });
    child.on('error', (error) => {
      log(`could not open the app window: ${error.message}`);
      openInDefaultBrowser(url);
    });
  });
}

// ---------- tray ----------

interface Tray {
  send(line: string): void;
  /** Sends a command and waits for the helper's answer that starts with `word`. */
  ask(line: string, word: string, timeoutMs?: number): Promise<string>;
  stop(): void;
}

function startTray(onCommand: (command: string) => void): Promise<Tray | null> {
  const script = path.join(import.meta.dirname, 'tray.ps1');
  const iconFile = path.join(config.dataDir, 'mimi-tray.png');
  fs.writeFileSync(iconFile, renderIconPng());
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', script, '-IconPng', iconFile],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        MIMI_TRAY_TIP: 'Mimi',
        MIMI_TRAY_OPEN: 'เปิดแชต',
        MIMI_TRAY_DESKTOP: 'Agent / Hub / ตั้งค่า (หน้าต่างใหญ่)',
        MIMI_TRAY_QUIT: 'ออกจาก Mimi',
      },
    },
  );
  const waiting: Array<{ word: string; done: (answer: string) => void }> = [];
  return new Promise((resolve) => {
    let ready = false;
    const tray: Tray = {
      send: (line) => {
        if (child.stdin.writable) child.stdin.write(`${line}\n`);
      },
      ask: (line, word, timeoutMs = 20_000) =>
        new Promise((done) => {
          const entry = { word, done };
          waiting.push(entry);
          tray.send(line);
          setTimeout(() => {
            const index = waiting.indexOf(entry);
            if (index >= 0) {
              waiting.splice(index, 1);
              done('none');
            }
          }, timeoutMs);
        }),
      stop: () => child.stdin.end(),
    };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const [word, ...rest] = line.trim().split(' ');
      if (word === 'ready') {
        ready = true;
        resolve(tray);
        return;
      }
      const index = waiting.findIndex((entry) => entry.word === word);
      if (index >= 0) {
        waiting.splice(index, 1)[0]!.done(rest.join(' '));
      } else if (word) {
        onCommand(word);
      }
    });
    child.stderr.on('data', (data) => log(`tray: ${String(data).trim()}`));
    child.on('error', (error) => {
      log(`tray could not start: ${error.message}`);
      if (!ready) resolve(null);
    });
    child.on('exit', (code) => {
      log(`tray helper ended (${code})`);
      if (!ready) resolve(null);
    });
    setTimeout(() => !ready && resolve(null), 15000);
  });
}

// ---------- start ----------

if (await isMimiRunning(config.port)) {
  // Second click on the icon: the core is already up. Ask it to show its window.
  log(`already running on port ${config.port}; asking it to show a window`);
  const asked = await fetch(`http://127.0.0.1:${config.port}/app/show`, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!asked || asked.status !== 204) {
    await Promise.race([openWindow(config.port, 'single'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  process.exit(0);
}

let server: MimiServer;
try {
  server = await startServer({ ...config, host: '127.0.0.1', token: settings.token, localPcTools: true });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  log(`port ${config.port} is taken by another program; using a free one`);
  server = await startServer({ ...config, host: '127.0.0.1', port: 0, token: settings.token, localPcTools: true });
}
log(`Mimi ${APP_VERSION} is running on http://127.0.0.1:${server.port}`);

let closing = false;
let tray: Tray | null = null;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  log('closing');
  tray?.stop();
  for (const child of Object.values(windows)) child?.kill();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** The chat flyout: shows the one there is, or opens a window and has the tray make it one. */
const showChat = async () => {
  if (!tray) return;
  if (windows.phone && (await tray.ask('showflyout', 'flyout', 3000)) === 'ok') return;
  windows.phone?.kill();
  void openWindow(server.port, 'phone');
  const child = windows.phone;
  if (!child?.pid) return;
  const made = await tray.ask(`flyout ${child.pid} ${PHONE.width} ${PHONE.height} ${PHONE.margin}`, 'flyout');
  if (made !== 'ok') log('the chat window did not appear in time');
};

/** The big window for Agent / Hub / Settings: raised when open, else opened. */
const showDesktop = async () => {
  const open = windows.desktop;
  if (open?.pid && tray && (await tray.ask(`focus ${open.pid}`, 'focus', 3000)) === 'ok') return;
  open?.kill();
  void openWindow(server.port, 'desktop', 'settings');
};

if (useTray) {
  tray = await startTray((command) => {
    if (command === 'open') void showChat();
    else if (command === 'desktop') void showDesktop();
    else if (command === 'quit') void shutdown();
  });
}

if (!tray) {
  // No tray (other systems, MIMI_TRAY=0, or the helper failed): one window, and closing it quits.
  server.onAppAction = () => void openWindow(server.port, 'single');
  await openWindow(server.port, 'single');
  await shutdown();
} else {
  server.onAppAction = (action) => void (action === 'desktop' ? showDesktop() : showChat());
  // Agent messages and reminders reach the user through the tray while no window is on screen.
  const previous = server.core.listeners.notification;
  server.core.listeners.notification = (notification) => {
    previous?.(notification);
    if (notification.kind === 'info' || server.someoneLooking()) return;
    const flat = (text: string, max: number) => text.replace(/[\t\r]/g, ' ').replace(/\n/g, '\\n').slice(0, max);
    tray?.send(`balloon\t${flat(notification.title, 60)}\t${flat(notification.body, 220)}`);
  };
  log('tray icon ready; click it to open the chat');
  void showChat();
}
