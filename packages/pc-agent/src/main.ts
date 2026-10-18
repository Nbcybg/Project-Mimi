import fs from 'node:fs';
import path from 'node:path';
import { PcAgent } from './client.ts';

// npm run pc-agent
//   MIMI_CORE_URL   WebSocket URL of the core (default ws://127.0.0.1:8787/ws)
//   MIMI_TOKEN      the same token the core uses
//   ALLOWED_DIRS    folders this PC lets the agents touch, separated by ";"
const url = process.env.MIMI_CORE_URL ?? `ws://127.0.0.1:${process.env.MIMI_PORT ?? 8787}/ws`;
const token = process.env.MIMI_TOKEN;
const allowedDirs = (process.env.ALLOWED_DIRS ?? '')
  .split(';')
  .map((dir) => dir.trim())
  .filter(Boolean)
  .map((dir) => path.resolve(dir));

if (!token) {
  console.error('MIMI_TOKEN is not set. Use the same value as on the core.');
  process.exit(1);
}
if (allowedDirs.length === 0) {
  console.error('ALLOWED_DIRS is not set. List the folders the agents may use, separated by ";".');
  process.exit(1);
}
for (const dir of allowedDirs) fs.mkdirSync(dir, { recursive: true });

console.log(`PC agent - allowed folders: ${allowedDirs.join('; ')}`);
const agent = new PcAgent({ url, token, allowedDirs, log: (line) => console.log(`[pc-agent] ${line}`) });
agent.start();

const stop = () => {
  agent.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
