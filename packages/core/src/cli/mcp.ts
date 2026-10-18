// `npm run mcp` lists the MCP servers; `npm run mcp -- test <name>` connects to one and
// prints its tools (the list is kept for the app, too).
import path from 'node:path';
import { SecretStore } from '../app/secrets.ts';
import { loadConfig } from '../config.ts';
import { McpHub } from '../mcp/hub.ts';

const config = loadConfig();
const secrets = new SecretStore(config.secretsPath);
const hub = new McpHub({
  configPath: path.join(config.toolsDir, 'mcp', 'servers.json'),
  cachePath: path.join(config.dataDir, 'mcp-tools.json'),
  secret: (name) => secrets.get(name) ?? process.env[name],
});
const [command, name] = process.argv.slice(2);

if (command === 'test') {
  if (!name) {
    console.error('Usage: npm run mcp -- test <server>');
    process.exit(1);
  }
  const view = await hub.refresh(name);
  await hub.close();
  if (view.error) {
    console.error(`${name}: ${view.error}`);
    process.exit(1);
  }
  console.log(`${name}: ${view.tools.length} tools`);
  for (const tool of view.tools) console.log(`  ${tool.name}  [${tool.risk}]  ${tool.description.split('\n')[0]!.slice(0, 90)}`);
} else {
  const servers = hub.views();
  if (servers.length === 0) console.log(`No MCP servers yet. Add one on the Tools screen (or in ${path.join(config.toolsDir, 'mcp', 'servers.json')}).`);
  for (const server of servers) {
    const where = server.transport === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ');
    const state = !server.enabled ? 'off' : server.error ? `error: ${server.error}` : `${server.tools.length} tools`;
    console.log(`${server.name}  (${server.transport})  ${where}  — ${state}`);
  }
}
