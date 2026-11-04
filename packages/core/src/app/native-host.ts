import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { APP_VERSION, type MimiServer, startServer } from '../server/server.ts';
import { AppSettings } from './app-settings.ts';
import { moveUserDataToDocuments } from './user-home.ts';

// The core on this machine for the native apps (apps/windows, later the Mac app): what launcher.ts does for
// the Electron app — the user's data folder, the token kept in the app settings, 127.0.0.1 only — without a
// window. The app that started it reads one line from stdout:
//   @@mimi-host@@{"port":8787,"token":"…","version":"…"}            the core is up
//   @@mimi-host@@{"port":8787,"token":"…","external":true}           a Mimi already runs here; use that one
//   @@mimi-host@@{"error":"…"}                                       it could not start
// and stops it by closing stdin (or SIGTERM). PC tools are not run inside the core: the app's own PC agent
// does them, with its consent questions.

const MARK = '@@mimi-host@@';
const say = (value: object) => process.stdout.write(`${MARK}${JSON.stringify(value)}\n`);

async function isMimiRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return ((await response.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

const startConfig = loadConfig();
const alreadyUp = await isMimiRunning(startConfig.port);
if (!alreadyUp) {
  try {
    moveUserDataToDocuments(startConfig.rootDir);
  } catch (error) {
    process.stderr.write(`could not move the user data to Documents: ${(error as Error).message}\n`);
  }
}
const settings = AppSettings.load(loadConfig().appSettingsPath);
settings.applyToEnv(process.env);
const config = loadConfig();

if (alreadyUp) {
  // Another Mimi of this account (the Electron app, a second start) owns the port and the same token.
  say({ port: config.port, token: settings.token, external: true });
  process.exit(0);
}

fs.mkdirSync(config.allowedDirs[0]!, { recursive: true });
fs.mkdirSync(config.dataDir, { recursive: true });
const logFile = path.join(config.dataDir, 'app.log');
const log = (line: string) => {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [native] ${line}\n`);
  } catch {
    // logging must never stop the core
  }
};

let server: MimiServer;
try {
  try {
    server = await startServer({ ...config, host: '127.0.0.1', token: settings.token, localPcTools: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    log(`port ${config.port} is taken by another program; using a free one`);
    server = await startServer({ ...config, host: '127.0.0.1', port: 0, token: settings.token, localPcTools: false });
  }
} catch (error) {
  log(`could not start: ${(error as Error).stack ?? (error as Error).message}`);
  say({ error: (error as Error).message });
  process.exit(1);
}
log(`Mimi ${APP_VERSION} is running on http://127.0.0.1:${server.port} (user data: ${config.userDir})`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  log('closing');
  await server.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('uncaughtException', (error) => {
  log(`fatal: ${error.stack ?? error.message}`);
  process.exit(1);
});
// The app went away (or asked us to stop): its end of stdin closes.
process.stdin.on('end', () => void shutdown());
process.stdin.on('error', () => void shutdown());
process.stdin.resume();

say({ port: server.port, token: settings.token, version: APP_VERSION });
