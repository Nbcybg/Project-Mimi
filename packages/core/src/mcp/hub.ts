import fs from 'node:fs';
import path from 'node:path';
import { type McpServerSpec, type McpServerView, type McpToolView, RISK_LEVELS, type RiskLevel } from '@mimi/shared';
import { z } from 'zod';
import { renderTemplate, truncateOutput } from '../tools/custom-tools.ts';
import { PC_OFFLINE, type PcRunner } from '../tools/executor.ts';
import type { ToolContext, ToolDefinition } from '../tools/registry.ts';
import { callResultText, HttpLink, McpClient, type McpCallResult, type McpLink, type McpTool, StdioLink } from './client.ts';

export const MCP_SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

const serverSchema = z.strictObject({
  name: z.string().regex(MCP_SERVER_NAME, 'lowercase letters, digits and "-" (no "_"), up to 24'),
  title: z.string().optional(),
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  untrusted: z.boolean().optional(),
  runsOn: z.enum(['core', 'pc']).optional(),
});

interface CachedServer {
  tools: McpTool[];
  checkedAt?: string;
  error?: string;
}

/** Environment a stdio server starts with: enough to find programs, none of Mimi's keys. */
const BASE_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'ProgramFiles', 'ProgramData'];

export interface McpHubOptions {
  /** `tools/mcp/servers.json`: the servers (synced with the user folder). */
  configPath: string;
  /** Machine-local cache of each server's tool list. */
  cachePath: string;
  /** Values for {{secret.NAME}} in env and headers. */
  secret(name: string): string | undefined;
  /** Where servers marked `runsOn: "pc"` run; without it they run here. */
  pc?: PcRunner;
  /** Tests swap the transport. */
  link?(spec: McpServerSpec, render: (text: string) => string): McpLink;
}

/** What the hub needs from a connection: a real MCP client, or a stand-in that works through the PC agent. */
export interface McpSession {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal, context?: ToolContext): Promise<McpCallResult>;
  close(): Promise<void>;
  onClose?: (error: Error) => void;
}

/** An MCP server that runs on the user's PC: every call is a message to the PC agent, which keeps the server alive. */
class PcMcpSession implements McpSession {
  private readonly runner: PcRunner;
  private readonly spec: Record<string, unknown>;

  constructor(runner: PcRunner, spec: Record<string, unknown>) {
    this.runner = runner;
    this.spec = spec;
  }

  private run(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
    const fallback: ToolContext = { traceId: 'mcp', thread: 'mcp', agent: 'mcp', allowedDirs: [] };
    return this.runner.execute('mcp_session', { ...input, spec: this.spec }, context ?? fallback);
  }

  async listTools(): Promise<McpTool[]> {
    return JSON.parse(await this.run({ action: 'list' })) as McpTool[];
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal, context?: ToolContext): Promise<McpCallResult> {
    const base: ToolContext = context ?? { traceId: 'mcp', thread: 'mcp', agent: 'mcp', allowedDirs: [] };
    return JSON.parse(await this.run({ action: 'call', tool: name, arguments: args ?? {} }, { ...base, signal: signal ?? base.signal })) as McpCallResult;
  }

  async close(): Promise<void> {
    await this.run({ action: 'close' }).catch(() => {});
  }
}

/** Tool names of MCP servers: `mcp_<server>_<tool>`, in the characters models accept. */
export function mcpToolName(server: string, tool: string): string {
  const clean = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `mcp_${server}_${clean || 'tool'}`.slice(0, 64);
}

/** The model sees the server's JSON schema; anything zod cannot read becomes "any object". */
function inputSchemaOf(schema: Record<string, unknown> | undefined): z.ZodType<Record<string, unknown>> {
  const loose = z.record(z.string(), z.unknown());
  if (!schema || schema.type !== 'object') return loose;
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodType<Record<string, unknown>>;
  } catch {
    return loose;
  }
}

/**
 * The MCP servers the user added and the tools they offer. Connections open on the
 * first call and stay up; the tool list is read when a server is saved or refreshed
 * and kept on disk, so agents can list MCP tools before any connection is made.
 */
export class McpHub {
  private readonly options: McpHubOptions;
  private readonly live = new Map<string, Promise<McpSession>>();

  constructor(options: McpHubOptions) {
    this.options = options;
  }

  servers(): McpServerSpec[] {
    if (!fs.existsSync(this.options.configPath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.options.configPath, 'utf8')) as { servers?: unknown[] };
    const out: McpServerSpec[] = [];
    for (const entry of raw.servers ?? []) {
      const parsed = serverSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
      else console.error(`mcp: skipped a server in ${this.options.configPath}: ${parsed.error.issues[0]?.message}`);
    }
    return out;
  }

  server(name: string): McpServerSpec | undefined {
    return this.servers().find((spec) => spec.name === name);
  }

  views(): McpServerView[] {
    const cache = this.cache();
    return this.servers().map((spec) => {
      const cached = cache[spec.name];
      return {
        ...spec,
        tools: (cached?.tools ?? []).map((tool) => this.toolView(spec, tool)),
        ...(cached?.checkedAt ? { checkedAt: cached.checkedAt } : {}),
        ...(cached?.error ? { error: cached.error } : {}),
      };
    });
  }

  save(input: McpServerSpec, renameFrom?: string): McpServerSpec {
    const spec = serverSchema.parse(input);
    if (spec.transport === 'stdio' && !spec.command?.trim()) throw new Error('Fill in the command that starts the MCP server.');
    if (spec.transport === 'http') {
      try {
        const url = new URL(spec.url ?? '');
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('http');
      } catch {
        throw new Error('Fill in the MCP server URL (http:// or https://).');
      }
    }
    const servers = this.servers();
    const from = renameFrom ?? spec.name;
    if (spec.name !== from && servers.some((entry) => entry.name === spec.name)) throw new Error(`There is already an MCP server "${spec.name}".`);
    const next = servers.filter((entry) => entry.name !== from && entry.name !== spec.name);
    next.push(spec);
    next.sort((a, b) => a.name.localeCompare(b.name));
    this.write(next);
    void this.disconnect(from);
    if (from !== spec.name) {
      void this.disconnect(spec.name);
      this.setCache(from, undefined);
    }
    return spec;
  }

  remove(name: string): boolean {
    const servers = this.servers();
    const next = servers.filter((entry) => entry.name !== name);
    if (next.length === servers.length) return false;
    this.write(next);
    void this.disconnect(name);
    this.setCache(name, undefined);
    return true;
  }

  /** Connects (again) and reads the tool list; the error, if any, is kept for the screen. */
  async refresh(name: string): Promise<McpServerView> {
    const spec = this.server(name);
    if (!spec) throw new Error(`Unknown MCP server "${name}".`);
    await this.disconnect(name);
    try {
      const client = await this.client(name);
      const tools = await client.listTools();
      this.setCache(name, { tools, checkedAt: new Date().toISOString() });
    } catch (error) {
      const previous = this.cache()[name];
      this.setCache(name, { tools: previous?.tools ?? [], checkedAt: new Date().toISOString(), error: (error as Error).message.slice(0, 500) });
      await this.disconnect(name);
    }
    return this.views().find((view) => view.name === name)!;
  }

  /** Tool names agents may list (enabled servers only). */
  names(): string[] {
    return this.entries().map((entry) => entry.name);
  }

  /** `mcp_<server>` in an agent file stands for every tool of that server. */
  expand(name: string): string[] | undefined {
    const match = /^mcp_([a-z0-9-]+)$/.exec(name);
    if (!match) return undefined;
    const spec = this.server(match[1]!);
    if (!spec?.enabled) return undefined;
    return this.entries().filter((entry) => entry.server.name === spec.name).map((entry) => entry.name);
  }

  get(name: string): ToolDefinition | undefined {
    const entry = this.entries().find((candidate) => candidate.name === name);
    return entry ? this.definition(entry.server, entry.tool, entry.name) : undefined;
  }

  toolViews(): Array<McpToolView & { server: McpServerSpec }> {
    return this.entries().map((entry) => ({ ...this.toolView(entry.server, entry.tool), server: entry.server }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.live.keys()].map((name) => this.disconnect(name)));
  }

  private entries(): Array<{ name: string; server: McpServerSpec; tool: McpTool }> {
    const cache = this.cache();
    const out: Array<{ name: string; server: McpServerSpec; tool: McpTool }> = [];
    const seen = new Set<string>();
    for (const server of this.servers()) {
      if (!server.enabled) continue;
      for (const tool of cache[server.name]?.tools ?? []) {
        const name = mcpToolName(server.name, tool.name);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, server, tool });
      }
    }
    return out;
  }

  private riskOf(server: McpServerSpec, tool: McpTool): RiskLevel {
    if (tool.annotations?.readOnlyHint === true) return 'read';
    if (tool.annotations?.destructiveHint === true) return 'delete';
    return server.risk ?? 'write';
  }

  private toolView(server: McpServerSpec, tool: McpTool): McpToolView {
    return { name: mcpToolName(server.name, tool.name), tool: tool.name, description: tool.description ?? '', risk: this.riskOf(server, tool) };
  }

  private definition(server: McpServerSpec, tool: McpTool, name: string): ToolDefinition {
    return {
      name,
      description: `${(tool.description ?? tool.annotations?.title ?? tool.name).slice(0, 900)} [MCP: ${server.title || server.name}]`,
      risk: this.riskOf(server, tool),
      target: 'core',
      untrustedInput: server.untrusted !== false,
      inputSchema: inputSchemaOf(tool.inputSchema) as z.ZodType<unknown>,
      summarize: (input) => `${server.name} › ${tool.name} ${truncateOutput(JSON.stringify(input ?? {}), 120)}`,
      execute: async (input, context) => {
        const client = await this.client(server.name);
        return truncateOutput(callResultText(await client.callTool(tool.name, input, context.signal, context)));
      },
    };
  }

  private client(name: string): Promise<McpSession> {
    const existing = this.live.get(name);
    if (existing) return existing;
    const spec = this.server(name);
    if (!spec) return Promise.reject(new Error(`Unknown MCP server "${name}".`));
    if (!spec.enabled) return Promise.reject(new Error(`MCP server "${name}" is turned off.`));
    const render = (text: string) => renderTemplate(text, { input: {}, settings: {}, secret: this.options.secret });
    if (spec.runsOn === 'pc' && this.options.pc) {
      const mode = this.options.pc.mode();
      if (mode === 'offline') return Promise.reject(new Error(PC_OFFLINE));
      if (mode === 'remote') {
        // The PC agent runs it; secrets are filled in here and travel over the agent's own socket.
        const session = new PcMcpSession(this.options.pc, this.remoteSpec(spec, render));
        const ready = Promise.resolve<McpSession>(session);
        this.live.set(name, ready);
        return ready;
      }
    }
    const connecting = McpClient.connect((this.options.link ?? this.makeLink)(spec, render)).then((client) => {
      client.onClose = () => {
        if (this.live.get(name) === connecting) this.live.delete(name);
      };
      return client;
    });
    connecting.catch(() => {
      if (this.live.get(name) === connecting) this.live.delete(name);
    });
    this.live.set(name, connecting);
    return connecting;
  }

  private remoteSpec(spec: McpServerSpec, render: (text: string) => string): Record<string, unknown> {
    if (spec.transport === 'http') {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(spec.headers ?? {})) headers[key] = render(value);
      return { transport: 'http', url: render(spec.url ?? ''), headers };
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = render(value);
    return { transport: 'stdio', command: render(spec.command ?? ''), args: (spec.args ?? []).map(render), ...(spec.cwd ? { cwd: render(spec.cwd) } : {}), env };
  }

  private readonly makeLink = (spec: McpServerSpec, render: (text: string) => string): McpLink => {
    if (spec.transport === 'http') {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(spec.headers ?? {})) headers[key] = render(value);
      return new HttpLink(render(spec.url ?? ''), headers);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of BASE_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = render(value);
    return new StdioLink(render(spec.command ?? ''), (spec.args ?? []).map(render), { cwd: spec.cwd || undefined, env });
  };

  private async disconnect(name: string): Promise<void> {
    const connecting = this.live.get(name);
    if (!connecting) return;
    this.live.delete(name);
    try {
      await (await connecting).close();
    } catch {
      // it never connected
    }
  }

  private cache(): Record<string, CachedServer> {
    try {
      return JSON.parse(fs.readFileSync(this.options.cachePath, 'utf8')) as Record<string, CachedServer>;
    } catch {
      return {};
    }
  }

  private setCache(name: string, value: CachedServer | undefined): void {
    const cache = this.cache();
    if (value) cache[name] = value;
    else delete cache[name];
    fs.mkdirSync(path.dirname(this.options.cachePath), { recursive: true });
    fs.writeFileSync(this.options.cachePath, `${JSON.stringify(cache, null, 2)}\n`);
  }

  private write(servers: McpServerSpec[]): void {
    fs.mkdirSync(path.dirname(this.options.configPath), { recursive: true });
    const tmp = `${this.options.configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ servers }, null, 2)}\n`);
    fs.renameSync(tmp, this.options.configPath);
  }
}
