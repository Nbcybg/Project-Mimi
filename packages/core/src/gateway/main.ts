import path from 'node:path';
import { loadConfig } from '../config.ts';
import { AccountStore } from './accounts.ts';
import { startGateway } from './gateway.ts';

// The accounts gateway (MIMI_MODE=gateway). Its own data is only the accounts database in
// the user folder's data/ (a volume of the gateway service); every person's data lives in
// their own core.
const config = loadConfig();
const secret = process.env.MIMI_GATEWAY_SECRET ?? '';
if (secret.length < 32) {
  console.error('MIMI_GATEWAY_SECRET is missing or shorter than 32 characters. Set a long random value (it encrypts the core tokens).');
  process.exit(1);
}
const file = process.env.MIMI_ACCOUNTS_DB ? path.resolve(process.env.MIMI_ACCOUNTS_DB) : path.join(config.dataDir, 'accounts.db');
const idleDays = Number(process.env.MIMI_SESSION_IDLE_DAYS) > 0 ? Number(process.env.MIMI_SESSION_IDLE_DAYS) : 30;
const accounts = new AccountStore(file, secret, { idleDays });
const gateway = await startGateway({ accounts, host: config.host, port: config.port, clientIpHeader: config.clientIpHeader });

console.log(`Mimi accounts gateway listening on port ${gateway.port}  (accounts: ${file})`);
const count = accounts.list().length;
console.log(
  count === 0
    ? 'No accounts yet. Create one with: node packages/core/src/cli/accounts.ts add <username> --core <url of that person\'s core>'
    : `${count} account(s).`,
);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  console.log('\nShutting down...');
  await gateway.close();
  accounts.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
