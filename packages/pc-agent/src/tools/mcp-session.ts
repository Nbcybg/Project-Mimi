import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { HttpLink, McpClient, type McpLink, StdioLink } from '../mcp/client.ts';
import { resolveAllowedPath } from './path-guard.ts';

/** Environment a stdio server starts with: enough to find programs, none of the assistant's keys. */
const BASE_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'ProgramFiles', 'ProgramData'];

const specSchema = z.object({
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpRunSpec = z.infer<typeof specSchema>;

const sessions = new Map<string, Promise<McpClient>>();

function makeLink(spec: McpRunSpec, allowedDirs: string[]): McpLink {
  if (spec.transport === 'http') {
    let url: URL;
    try {
      url = new URL(spec.url ?? '');
    } catch {
      throw new Error('The MCP server needs an http:// or https:// address.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The MCP server needs an http:// or https:// address.');
    return new HttpLink(url.toString(), spec.headers ?? {});
  }
  if (!spec.command?.trim()) throw new Error('The MCP server needs a command.');
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, spec.env ?? {});
  // The folder it runs in must be one the user allowed on this machine.
  const cwd = resolveAllowedPath(spec.cwd?.trim() || '.', allowedDirs);
  return new StdioLink(spec.command, spec.args ?? [], { cwd, env });
}

function connection(spec: McpRunSpec, allowedDirs: string[]): Promise<McpClient> {
  const key = JSON.stringify(spec);
  const existing = sessions.get(key);
  if (existing) return existing;
  const connecting = McpClient.connect(makeLink(spec, allowedDirs)).then((client) => {
    client.onClose = () => {
      if (sessions.get(key) === connecting) sessions.delete(key);
    };
    return client;
  });
  connecting.catch(() => {
    if (sessions.get(key) === connecting) sessions.delete(key);
  });
  sessions.set(key, connecting);
  return connecting;
}

/** Ends every MCP server this machine is running for the core. */
export async function closeMcpSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(async (connecting) => (await connecting.catch(() => null))?.close().catch(() => {})));
}

/**
 * How the core uses an MCP server that runs on the user's machine: it sends the server's
 * definition with every call, and this keeps one connection per definition. Not offered
 * to agents (it is not in `pcTools`); the core's MCP hub calls it.
 */
export const mcpSessionTool = defineTool({
  name: 'mcp_session',
  description: 'Internal: runs an MCP server on this machine for the core (list its tools, call one, or close it).',
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    action: z.enum(['list', 'call', 'close']),
    spec: specSchema,
    tool: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  summarize: (input) => `MCP ${input.action}${input.tool ? ` ${input.tool}` : ''} (${input.spec.transport === 'http' ? input.spec.url : input.spec.command})`,
  async execute(input, context) {
    if (input.action === 'close') {
      const key = JSON.stringify(input.spec);
      const connecting = sessions.get(key);
      sessions.delete(key);
      await (await connecting?.catch(() => null))?.close().catch(() => {});
      return 'closed';
    }
    const client = await connection(input.spec, context.allowedDirs);
    if (input.action === 'list') return JSON.stringify(await client.listTools());
    if (!input.tool) throw new Error('Give the tool to call.');
    return JSON.stringify(await client.callTool(input.tool, input.arguments ?? {}, context.signal));
  },
});

/** Tools the PC agent answers to but does not offer to agents. */
export const pcInternalTools = [mcpSessionTool];
