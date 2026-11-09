// Stages what the installer carries for the PC agent (the agent is a Node program, run by Node 24):
//   src-tauri/agent-staging/node/node.exe      the Node that runs it (this computer's, same version)
//   src-tauri/agent-staging/pc-agent/, shared/ the TypeScript sources, outside node_modules (Node 24
//                                              will not strip types from files under node_modules)
//   src-tauri/agent-staging/node_modules/      the few plain-JS packages the agent imports
// The same layout and helpers as the Electron / native Windows builds (scripts/pack-pc-agent.mjs).
// Tauri's installer config (src-tauri/tauri.installer.conf.json) puts it in the app folder as agent/.
//   node scripts/stage-agent.mjs

import fs from 'node:fs';
import path from 'node:path';
import { copyPcAgentPackages, packPcAgent } from '../../../scripts/pack-pc-agent.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const STAGE = path.resolve(import.meta.dirname, '..', 'src-tauri', 'agent-staging');

if (process.platform !== 'win32') console.warn('[stage-agent] only the Windows installer is set up so far (node.exe below)');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
packPcAgent(ROOT, STAGE);
copyPcAgentPackages(ROOT, STAGE);
const nodeFile = path.join(STAGE, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
fs.copyFileSync(process.execPath, nodeFile);
const megabytes = (fs.statSync(nodeFile).size / 1048576).toFixed(0);
console.log(`[stage-agent] node ${process.version} (${process.arch}, ${megabytes} MB) + PC agent staged in ${path.relative(process.cwd(), STAGE) || STAGE}`);
