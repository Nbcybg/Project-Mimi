import fs from 'node:fs';
import path from 'node:path';
import { PcAgent } from './client.ts';
import { closeBrowserSession } from './tools/browser.ts';

// npm run pc-agent
//   MIMI_CORE_URL   WebSocket URL of the core (default ws://127.0.0.1:8787/ws)
//   MIMI_TOKEN      the same token the core uses (or a signed-in session, through the accounts gateway)
//   ALLOWED_DIRS    folders this PC lets the agents touch, separated by ";"
//   MIMI_TOKEN_STDIN=1  read the token from the first line of stdin instead (the desktop app
//                   starts it so: a token in the environment is visible to other programs)
//   MIMI_PC_NAME    how this PC shows up in Mimi (default: the computer's name)
//   MIMI_PC_SHELL=0 offer no tool that runs with the OS account's full rights (shell, power, MCP)
const url = process.env.MIMI_CORE_URL ?? `ws://127.0.0.1:${process.env.MIMI_PORT ?? 8787}/ws`;
const allowedDirs = (process.env.ALLOWED_DIRS ?? '')
  .split(';')
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => path.resolve(dir));

function readToken(): Promise<string | undefined> {
  if (process.env.MIMI_TOKEN_STDIN !== '1') return Promise.resolve(process.env.MIMI_TOKEN);
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
      if (text.includes('\n')) resolve(text.split('\n')[0]!.trim() || undefined);
    });
    process.stdin.on('end', () => resolve(text.trim() || undefined));
  });
}

const token = await readToken();
if (!token) {
  console.error('MIMI_TOKEN is not set. Use the same value as on the core.');
  process.exit(1);
}
if (allowedDirs.length === 0) {
  console.error('ALLOWED_DIRS is not set. List the folders the agents may use, separated by ";".');
  process.exit(1);
}
for (const dir of allowedDirs) fs.mkdirSync(dir, { recursive: true });

console.log(`PC agent - allowed folders: ${allowedDirs.join('; ')}${process.env.MIMI_PC_SHELL === '0' ? ' (no shell commands)' : ''}`);
// MIMI_PC_SHELL=0: no commands with the OS account's full rights, only files in ALLOWED_DIRS and the browser.
const shell = process.env.MIMI_PC_SHELL !== '0';
const agent = new PcAgent({ url, token, allowedDirs, shell, name: process.env.MIMI_PC_NAME || undefined, log: (line) => console.log(`[pc-agent] ${line}`) });
agent.start();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  agent.stop();
  // The agents' browser goes too (its profile may be deleted next); a few seconds at most.
  await Promise.race([closeBrowserSession(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// Started by the desktop app: when it goes (or closes the pipe), so does this.
if (process.env.MIMI_TOKEN_STDIN === '1') process.stdin.on('end', () => void stop());
