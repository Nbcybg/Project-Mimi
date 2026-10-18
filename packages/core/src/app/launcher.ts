import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { startServer } from '../server/server.ts';
import { AppSettings } from './app-settings.ts';

// The desktop app: starts the core on this machine and shows the client in a window of
// its own. Everything the user needs to configure is done inside the window.

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

/** Opens the client window; resolves when the user closes it (or never, with a plain browser tab). */
function openWindow(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/#token=${settings.token}`;
  const browser = findAppBrowser();
  if (!browser) {
    log('no Edge/Chrome found; opening the default browser instead');
    openInDefaultBrowser(url);
    return new Promise(() => {});
  }
  // Its own profile folder makes the window a separate process that ends when it is closed.
  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${path.join(config.dataDir, 'app-window')}`,
      '--window-size=1100,820',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
    ],
    { stdio: 'ignore' },
  );
  return new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.on('error', (error) => {
      log(`could not open the app window: ${error.message}`);
      openInDefaultBrowser(url);
    });
  });
}

if (await isMimiRunning(config.port)) {
  // Second click on the icon: the core is already up, just show another window.
  log(`already running on port ${config.port}; opening a window`);
  await Promise.race([openWindow(config.port), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(0);
}

let server;
try {
  server = await startServer({ ...config, host: '127.0.0.1', token: settings.token, localPcTools: true });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  log(`port ${config.port} is taken by another program; using a free one`);
  server = await startServer({ ...config, host: '127.0.0.1', port: 0, token: settings.token, localPcTools: true });
}
log(`Mimi is running on http://127.0.0.1:${server.port}`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  log('closing');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await openWindow(server.port);
await shutdown();
