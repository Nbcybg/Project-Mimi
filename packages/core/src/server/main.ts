import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { AppSettings } from '../app/app-settings.ts';
import { loadConfig } from '../config.ts';
import { startServer } from './server.ts';

// Keys and folders saved from the app's settings screen count here too.
AppSettings.load(loadConfig().appSettingsPath).applyToEnv(process.env);
const config = loadConfig();
fs.mkdirSync(config.allowedDirs[0]!, { recursive: true });

// Every connection must present the token. Without one in .env, a random token is
// made for this run only, so an unconfigured server is never open to other programs.
const token = config.token ?? randomBytes(24).toString('base64url');
const server = await startServer({ ...config, token });

const address = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${server.port}`;
console.log(`Mimi core listening on ${address}  (WebSocket: /ws)`);
if (config.token) {
  console.log(`Open ${address}/ and enter your MIMI_TOKEN.`);
} else {
  // The token rides in the URL fragment, which browsers never send to a server.
  console.log(`No MIMI_TOKEN in .env - using a one-time token for this run.\nOpen: ${address}/#token=${token}`);
}
console.log(
  config.localPcTools
    ? `File/shell tools run on this machine in: ${config.allowedDirs.join('; ')} (until a PC agent connects)`
    : 'File/shell tools need a connected PC agent (MIMI_LOCAL_PC_TOOLS=0).',
);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('\nShutting down...');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
