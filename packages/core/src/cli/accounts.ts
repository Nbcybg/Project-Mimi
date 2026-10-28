import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.ts';
import { AccountError, AccountStore, MIN_PASSWORD } from '../gateway/accounts.ts';

// Admin commands for the accounts gateway. Run them where the gateway runs (on Railway:
// `railway ssh` into the gateway service), with the same MIMI_GATEWAY_SECRET.
// Passwords are typed (hidden) or piped on stdin; never pass them as arguments, which
// end up in shell history and process lists.

const USAGE = `Usage: node packages/core/src/cli/accounts.ts <command>
  add <username> --core <url>    create an account; prints the token its core must use
  list                           accounts, their cores and open sessions
  passwd <username>              set a new password (signs out every device)
  disable <username>             block sign-in and sign out every device
  enable <username>              allow sign-in again
  logout <username>              sign out every device
  set-core <username> <url>      the account's core moved
  rotate-core-token <username>   new core token (restart that core with it)
  backup <file>                  consistent copy of the accounts database (keep it with, not next to, the secret)`;

const lines: string[] = [];
let stdinDone = false;
const stdinReader = process.stdin.isTTY
  ? null
  : readline.createInterface({ input: process.stdin }).on('line', (line) => lines.push(line)).on('close', () => (stdinDone = true));

async function readSecret(prompt: string): Promise<string> {
  if (stdinReader) {
    while (lines.length === 0 && !stdinDone) await new Promise((resolve) => setTimeout(resolve, 10));
    return lines.shift() ?? '';
  }
  // Typed in a terminal: nothing is echoed.
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const input = readline.createInterface({ input: process.stdin, terminal: true });
    const output = input as unknown as { _writeToOutput?: (text: string) => void };
    output._writeToOutput = () => {};
    input.question('', (answer) => {
      input.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function newPassword(): Promise<string> {
  const first = await readSecret(`New password (at least ${MIN_PASSWORD} characters): `);
  const second = await readSecret('Again: ');
  if (first !== second) throw new AccountError('The two passwords differ.');
  return first;
}

function coreVariables(coreToken: string): string {
  return [
    '',
    'Variables for this person\'s core service (shown once; the gateway keeps an encrypted copy):',
    `  MIMI_TOKEN=${coreToken}`,
    '  MIMI_HOST=::',
    '  MIMI_LOCAL_PC_TOOLS=0',
    '  MIMI_BACKUP_DIR=/app/user/backups',
    'Give that service no public domain: only the gateway should reach it.',
  ].join('\n');
}

const [command, name, ...rest] = process.argv.slice(2);
const secret = process.env.MIMI_GATEWAY_SECRET ?? '';
const config = loadConfig();
const file = process.env.MIMI_ACCOUNTS_DB ? path.resolve(process.env.MIMI_ACCOUNTS_DB) : path.join(config.dataDir, 'accounts.db');

let accounts: AccountStore | undefined;
try {
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
  } else {
    accounts = new AccountStore(file, secret);
    if (command === 'backup') {
      if (!name) throw new AccountError('backup needs a file name, e.g. /app/user/backups/accounts-2026-10-27.db');
      await accounts.backupTo(name);
      console.log(`Saved ${name}. Core tokens in it are encrypted with MIMI_GATEWAY_SECRET.`);
    } else if (command === 'list') {
      const all = accounts.list();
      if (all.length === 0) console.log('No accounts.');
      for (const account of all) {
        const state = account.disabled ? 'disabled' : `${account.sessions} session(s)`;
        console.log(`${account.username}\t${account.coreUrl}\t${state}\twebhooks: ${account.webhookBase}`);
      }
    } else if (!name) {
      console.error(USAGE);
      process.exitCode = 1;
    } else if (command === 'add') {
      const at = rest.indexOf('--core');
      const coreUrl = at >= 0 ? rest[at + 1] : undefined;
      if (!coreUrl) throw new AccountError('add needs --core <url>, e.g. --core http://mimi-alice.railway.internal:8080');
      const made = await accounts.create(name, await newPassword(), coreUrl);
      console.log(`Created "${name.trim().toLowerCase()}". Webhook URLs of this account start with <gateway>${made.webhookBase}/api/...`);
      console.log(coreVariables(made.coreToken));
    } else if (command === 'passwd') {
      await accounts.setPassword(name, await newPassword());
      console.log('Password changed; every device was signed out.');
    } else if (command === 'disable' || command === 'enable') {
      accounts.setDisabled(name, command === 'disable');
      console.log(command === 'disable' ? 'Disabled; every device was signed out.' : 'Enabled.');
    } else if (command === 'logout') {
      console.log(`Signed out ${accounts.revokeAll(name)} session(s). Open connections close within half a minute.`);
    } else if (command === 'set-core') {
      if (!rest[0]) throw new AccountError('set-core needs the new URL.');
      accounts.setCoreUrl(name, rest[0]);
      console.log('Core URL changed.');
    } else if (command === 'rotate-core-token') {
      console.log(coreVariables(accounts.rotateCoreToken(name)));
    } else {
      console.error(USAGE);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error instanceof AccountError ? error.message : `Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  accounts?.close();
  stdinReader?.close();
}
