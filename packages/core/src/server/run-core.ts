// Starts one core: the agents, chats and data of one person (see main.ts).
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

const shown = ['0.0.0.0', '::'].includes(config.host) ? 'localhost' : config.host.includes(':') ? `[${config.host}]` : config.host;
const address = `http://${shown}:${server.port}`;
console.log(`Mimi core listening on ${address}  (WebSocket: /ws)`);
if (config.token) {
  console.log(`Open ${address}/ and enter your MIMI_TOKEN.`);
} else {
  // The token rides in the URL fragment, which browsers never send to a server.
  console.log(`No MIMI_TOKEN in .env - using a one-time token for this run.\nOpen: ${address}/#token=${token}`);
}
// Reachable from other machines: a short token is the only thing between the internet and the agent.
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
if (!loopback && config.token && config.token.length < 32) {
  console.warn('WARNING: MIMI_TOKEN is shorter than 32 characters while the core accepts outside connections. Use a long random token.');
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
