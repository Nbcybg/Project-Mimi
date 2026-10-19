import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STARTUP_TIMEOUT_MS = 20_000;

/** Where Edge and Chrome live by default; the first one that exists is used. */
function candidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) => [
      path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  const names = ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => path.join(dir, name)));
}

/** The browser to drive: MIMI_BROWSER_PATH if set, otherwise the first Edge or Chrome found. */
export function findBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): string | undefined {
  if (env.MIMI_BROWSER_PATH) return exists(env.MIMI_BROWSER_PATH) ? env.MIMI_BROWSER_PATH : undefined;
  return candidates(platform, env).find((file) => exists(file));
}

/** The browser's own data (logins, cookies) stays outside the user folder, so backups never carry it. */
export function browserProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MIMI_BROWSER_PROFILE ? path.resolve(env.MIMI_BROWSER_PROFILE) : path.join(os.homedir(), '.mimi', 'browser-profile');
}

export function browserArguments(profileDir: string, headless: boolean): string[] {
  return [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
}

/** Reads the DevTools address the browser writes into its profile folder when it starts. */
export function readDevToolsAddress(profileDir: string): string | undefined {
  try {
    const [port, endpoint] = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
    if (port && /^\d+$/.test(port) && endpoint) return `ws://127.0.0.1:${port}${endpoint}`;
  } catch {
    // not there (yet)
  }
  return undefined;
}

/**
 * Starts the browser with its own profile and a DevTools port, then waits for the
 * address it publishes. The window is visible, so the user can watch and log in.
 */
export async function startBrowser(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const executable = findBrowserExecutable(env);
  if (!executable) {
    throw new Error('No Edge or Chrome was found. Install one, or set MIMI_BROWSER_PATH to the browser program.');
  }
  const profileDir = browserProfileDir(env);
  fs.mkdirSync(profileDir, { recursive: true });
  // A leftover file from an earlier run would point at a dead port.
  fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(executable, browserArguments(profileDir, env.MIMI_BROWSER_HEADLESS === '1'), {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const address = readDevToolsAddress(profileDir);
    if (address) return address;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'The browser did not open its control port. If a window using the assistant\'s browser profile is already open without it, close that window and try again.',
  );
}
