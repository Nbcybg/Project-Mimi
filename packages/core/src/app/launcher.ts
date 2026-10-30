import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { APP_VERSION, type MimiServer, startServer } from '../server/server.ts';
import { AppSettings } from './app-settings.ts';
import { renderIconPng } from './icon.ts';
import { localAppDir, moveUserDataToDocuments } from './user-home.ts';

// The desktop app: starts the core on this machine and shows it in a native window (Electron,
// packages/desktop) that lives in the tray: closing the window hides it, the tray icon brings
// it back. Without Electron installed the client opens in the default browser instead.

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

// ---------- the built-in browser ----------
// The desktop app carries its own browser: the Electron it already uses, in browser mode
// (packages/desktop/browser-shell.cjs). The PC tools then launch it instead of looking for
// Chrome or Edge, and its profile keeps the sites the person signed in to.
function configureBuiltInBrowser(): void {
  if (process.env.MIMI_BROWSER_PATH || process.env.MIMI_BROWSER_APP) return;
  try {
    const electron = createRequire(import.meta.url)('electron') as string;
    if (!fs.existsSync(electron)) return;
    process.env.MIMI_BROWSER_PATH = electron;
    process.env.MIMI_BROWSER_APP = path.join(config.rootDir, 'packages/desktop/main.cjs');
  } catch {
    // no Electron: the browser tools fall back to an installed Chrome or Edge
  }
}
configureBuiltInBrowser();

async function openBuiltInBrowser(): Promise<void> {
  try {
    const { browserSession } = await import('@mimi/pc-agent');
    // tabs() connects (and starts the browser when needed); activating one brings its window up.
    await browserSession().run(async () => {
      const tabs = await browserSession().tabs();
      if (tabs.length > 0) await browserSession().switchTab(1);
    });
  } catch (error) {
    log(`the built-in browser could not open: ${(error as Error).message}`);
  }
}

// ---------- the native window ----------

interface NativeShell {
  show(view?: string): void;
  balloon(title: string, body: string): void;
  stop(): void;
}

/** Starts the Electron shell; null when Electron is not installed or did not come up. */
function startShell(port: number, onQuit: () => void): Promise<NativeShell | null> {
  let electron: string;
  try {
    electron = createRequire(import.meta.url)('electron') as string;
  } catch {
    return Promise.resolve(null);
  }
  const stateDir = localAppDir(config.dataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  // The icon is the app's, not the user's: it stays out of the user folder.
  const icon = path.join(stateDir, 'mimi-icon.png');
  fs.writeFileSync(icon, renderIconPng());
  const env: NodeJS.ProcessEnv = { ...process.env, MIMI_CORE_URL: `http://127.0.0.1:${port}`, MIMI_TOKEN: settings.token, MIMI_STATE_DIR: stateDir, MIMI_ICON: icon };
  delete env.ELECTRON_RUN_AS_NODE; // set by tools that are themselves Electron apps; it would make the shell a plain Node
  // Commands travel over node's IPC channel: a GUI program has no usable stdin on Windows.
  const child = spawn(electron, [path.join(config.rootDir, 'packages/desktop/main.cjs')], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  return new Promise((resolve) => {
    let ready = false;
    const send = (message: object) => child.connected && child.send(message);
    child.on('message', (message: { type?: string }) => {
      if (message.type === 'ready') {
        ready = true;
        resolve({
          show: (view) => send({ type: 'show', view }),
          balloon: (title, body) => send({ type: 'balloon', title, body }),
          stop: () => send({ type: 'quit' }),
        });
      } else if (message.type === 'quit') {
        onQuit();
      }
    });
    child.on('error', (error) => {
      log(`the window could not start: ${error.message}`);
      if (!ready) resolve(null);
    });
    child.on('exit', (code) => {
      log(`the window ended (${code})`);
      if (ready) onQuit();
      else resolve(null);
    });
    setTimeout(() => !ready && resolve(null), 20_000);
  });
}

// ---------- start ----------

if (await isMimiRunning(config.port)) {
  // Second start: the core is already up. Ask it to show its window.
  log(`already running on port ${config.port}; asking it to show the window`);
  const asked = await fetch(`http://127.0.0.1:${config.port}/app/show`, {
    method: 'POST',
    headers: { authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!asked || asked.status !== 204) openInDefaultBrowser(`http://127.0.0.1:${config.port}/#token=${settings.token}`);
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
let shell: NativeShell | null = null;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  log('closing');
  shell?.stop();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

shell = await startShell(server.port, () => void shutdown());
if (!shell) {
  log('no native window (Electron is missing): opening the default browser');
  openInDefaultBrowser(`http://127.0.0.1:${server.port}/#token=${settings.token}`);
  server.onAppAction = (action) => (action === 'browser' ? void openBuiltInBrowser() : openInDefaultBrowser(`http://127.0.0.1:${server.port}/#token=${settings.token}`));
} else {
  // "show" raises the window; "desktop" (Settings from a link) opens it on that screen.
  server.onAppAction = (action) => (action === 'browser' ? void openBuiltInBrowser() : shell?.show(action === 'desktop' ? 'settings' : undefined));
  // Agent messages and reminders reach the user as Windows notifications while no window is on screen.
  const previous = server.core.listeners.notification;
  server.core.listeners.notification = (notification) => {
    previous?.(notification);
    if (notification.kind === 'info' || server.someoneLooking()) return;
    shell?.balloon(notification.title.slice(0, 60), notification.body.slice(0, 220));
  };
  log('the window is up; the tray icon opens it');
}
