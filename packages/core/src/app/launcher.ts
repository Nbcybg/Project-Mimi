import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.ts';
import { APP_VERSION, type MimiServer, startServer } from '../server/server.ts';
import { AppSettings } from './app-settings.ts';
import { renderIconPng } from './icon.ts';

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

const bootConfig = loadConfig();
const settings = AppSettings.load(bootConfig.appSettingsPath);
settings.applyToEnv(process.env);
const config = loadConfig(); // again, now with the folders chosen in the app
fs.mkdirSync(config.allowedDirs[0]!, { recursive: true });
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

// ---------- windows ----------

type WindowKind = 'phone' | 'desktop';
const PHONE = { width: 410, height: 820, margin: 12 };
const DESKTOP = { width: 1200, height: 840 };
/** Work area of the main screen, reported by the tray helper. */
let workArea: { x: number; y: number; width: number; height: number } | null = null;
const windows: Partial<Record<WindowKind, ChildProcess>> = {};

function pageUrl(port: number, kind: WindowKind | 'single', view?: string): string {
  const query = new URLSearchParams();
  if (kind === 'phone') query.set('ui', 'compact');
  if (view) query.set('view', view);
  const search = query.size ? `?${query}` : '';
  return `http://127.0.0.1:${port}/${search}#token=${settings.token}`;
}

/**
 * Opens a client window. Each kind has its own browser profile, so it is a process of its
 * own (the tray can find and raise its window) and its size and place are kept apart.
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
  const geometry: string[] = [];
  if (kind === 'phone') {
    const area = workArea ?? { x: 0, y: 0, width: 1920, height: 1040 };
    const height = Math.min(PHONE.height, area.height - PHONE.margin * 2);
    const x = area.x + area.width - PHONE.width - PHONE.margin;
    const y = area.y + area.height - height - PHONE.margin;
    geometry.push(`--window-size=${PHONE.width},${height}`, `--window-position=${x},${y}`);
  } else {
    geometry.push(`--window-size=${kind === 'desktop' ? `${DESKTOP.width},${DESKTOP.height}` : '1100,820'}`);
  }
  const profile = kind === 'desktop' ? 'app-window-desktop' : 'app-window';
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${path.join(config.dataDir, profile)}`,
      ...geometry,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
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
  /** Raises (or with `toggle`, minimises again) the window of a process; false when it has none. */
  window(pid: number, mode: 'toggle' | 'focus'): Promise<boolean>;
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
        MIMI_TRAY_OPEN: 'เปิด Mimi',
        MIMI_TRAY_DESKTOP: 'ตั้งค่า / Agent / Hub (หน้าต่างใหญ่)',
        MIMI_TRAY_QUIT: 'ออกจาก Mimi',
      },
    },
  );
  const waiting = new Map<number, (shown: boolean) => void>();
  return new Promise((resolve) => {
    let ready = false;
    const tray: Tray = {
      send: (line) => {
        if (child.stdin.writable) child.stdin.write(`${line}\n`);
      },
      window: (pid, mode) =>
        new Promise((done) => {
          waiting.set(pid, done);
          tray.send(`${mode} ${pid}`);
          setTimeout(() => waiting.get(pid) === done && (waiting.delete(pid), done(false)), 3000);
        }),
      stop: () => child.stdin.end(),
    };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const [word, ...rest] = line.trim().split(' ');
      if (word === 'ready') {
        const [x, y, width, height] = rest.map(Number);
        if ([x, y, width, height].every((value) => Number.isFinite(value))) workArea = { x: x!, y: y!, width: width!, height: height! };
        ready = true;
        resolve(tray);
      } else if (word === 'window') {
        const pid = Number(rest[0]);
        const done = waiting.get(pid);
        waiting.delete(pid);
        done?.(rest[1] !== '0');
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

/** Shows the window of this kind: raises (or toggles) the open one, or opens a new one. */
const show = async (kind: WindowKind, toggle: boolean) => {
  const open = windows[kind];
  if (open?.pid && tray && (await tray.window(open.pid, toggle ? 'toggle' : 'focus'))) return;
  if (open) open.kill();
  void openWindow(server.port, kind, kind === 'desktop' ? 'settings' : undefined);
};

if (useTray) {
  tray = await startTray((command) => {
    if (command === 'open') void show('phone', true);
    else if (command === 'desktop') void show('desktop', false);
    else if (command === 'quit') void shutdown();
  });
}

if (!tray) {
  // No tray (other systems, MIMI_TRAY=0, or the helper failed): one window, and closing it quits.
  server.onAppAction = () => void openWindow(server.port, 'single');
  await openWindow(server.port, 'single');
  await shutdown();
} else {
  server.onAppAction = (action) => void show(action === 'desktop' ? 'desktop' : 'phone', false);
  // Agent messages and reminders reach the user through the tray while no window is on screen.
  const previous = server.core.listeners.notification;
  server.core.listeners.notification = (notification) => {
    previous?.(notification);
    if (notification.kind === 'info' || server.someoneLooking()) return;
    const flat = (text: string, max: number) => text.replace(/[\t\r]/g, ' ').replace(/\n/g, '\\n').slice(0, max);
    tray?.send(`balloon\t${flat(notification.title, 60)}\t${flat(notification.body, 220)}`);
  };
  log('tray icon ready; click it to open the chat');
  void show('phone', false);
}
