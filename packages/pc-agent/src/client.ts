import os from 'node:os';
import type { PcMessage, PcRequest, ToolDefinition } from '@mimi/shared';
import { pcInternalTools, pcTools } from './index.ts';

export interface PcAgentOptions {
  /** WebSocket URL of the core, e.g. wss://my-core.example/ws */
  url: string;
  token: string;
  /** Folders this machine lets the agents touch. Enforced here, whatever the core asks for. */
  allowedDirs: string[];
  name?: string;
  tools?: ToolDefinition<any>[];
  /**
   * Offer the tools that act with the full rights of the OS account (run_shell, stop_process,
   * power, MCP servers on this machine). The folder allowlist cannot fence those in. Default true.
   */
  shell?: boolean;
  /** Reconnect with backoff after the connection drops. Default true. */
  reconnect?: boolean;
  log?: (line: string) => void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Runs on the user's PC and dials out to the core, so no port has to be opened on
 * the machine. The core sends tool calls down the socket; this process validates
 * them, enforces the folder allowlist and answers with the result.
 */
export class PcAgent {
  private readonly options: PcAgentOptions;
  private readonly tools: Map<string, ToolDefinition<any>>;
  private socket: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private retry: NodeJS.Timeout | undefined;

  constructor(options: PcAgentOptions) {
    this.options = options;
    // Plus the tools only the core's own services use (MCP servers on this machine).
    const shell = options.shell !== false;
    const offered = [...(options.tools ?? pcTools), ...(shell ? pcInternalTools : [])].filter((tool) => shell || tool.risk !== 'shell');
    this.tools = new Map(offered.map((tool) => [tool.name, tool]));
  }

  /** The tools this PC offers the core. */
  offered(): string[] {
    return [...this.tools.keys()];
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
  }

  private send(message: PcMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoffMs = 1000;
      this.log(`connected to ${this.options.url}`);
      this.send({
        type: 'hello',
        role: 'pc',
        token: this.options.token,
        name: this.options.name ?? os.hostname(),
        allowedDirs: this.options.allowedDirs,
        tools: [...this.tools.keys()],
      });
    });

    socket.addEventListener('message', (event) => {
      let request: PcRequest;
      try {
        request = JSON.parse(String(event.data)) as PcRequest;
      } catch {
        return;
      }
      if (request?.type === 'tool-exec') void this.execute(request);
    });

    socket.addEventListener('close', (event) => {
      if (this.socket === socket) this.socket = null;
      if (event.code === 4003) {
        this.log('the core rejected the token; check MIMI_TOKEN');
        return;
      }
      if (this.stopped || this.options.reconnect === false) return;
      this.log(`disconnected; retrying in ${Math.round(this.backoffMs / 1000)}s`);
      this.retry = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });

    // A failed connection also emits "close", which schedules the retry.
    socket.addEventListener('error', () => {});
  }

  private async execute(request: PcRequest): Promise<void> {
    const respond = (ok: boolean, output: string) =>
      this.send({ type: 'tool-result', id: request.id, ok, output });

    const tool = this.tools.get(request.tool);
    if (!tool) return respond(false, `This PC agent has no tool "${request.tool}".`);
    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) return respond(false, `Invalid input for ${request.tool}.`);

    this.log(`${request.agent}: ${tool.summarize(parsed.data)}`);
    try {
      const output = await tool.execute(parsed.data, {
        traceId: request.traceId,
        thread: request.thread,
        agent: request.agent,
        allowedDirs: this.options.allowedDirs,
      });
      respond(true, output);
    } catch (error) {
      respond(false, (error as Error).message);
    }
  }
}
