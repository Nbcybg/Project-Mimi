import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

/**
 * A small Model Context Protocol client (JSON-RPC 2.0), written against the spec
 * instead of pulling in the SDK: the stdio transport (one JSON message per line) and
 * Streamable HTTP (POST, the answer as JSON or as an SSE stream).
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Moves messages to and from one server. Answers arrive through `onMessage`. */
export interface McpLink {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage: (message: JsonRpcMessage) => void;
  onClose: (error?: Error) => void;
  /** Told after `initialize`, for transports that send it along (HTTP). */
  protocolVersion?: string;
  close(): Promise<void>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

export interface McpCallResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

const quoteWin = (arg: string) => (arg === '' || /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

/** A server started as a local command; messages are lines on stdin / stdout. */
export class StdioLink implements McpLink {
  onMessage: (message: JsonRpcMessage) => void = () => {};
  onClose: (error?: Error) => void = () => {};
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private stderr = '';
  private ended = false;

  constructor(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) {
    // Windows: through cmd.exe, so `npx` / `uvx` (.cmd shims) start like in a terminal.
    this.child =
      process.platform === 'win32'
        ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[command, ...args].map(quoteWin).join(' ')}"`], {
            cwd: options.cwd,
            env: options.env,
            windowsVerbatimArguments: true,
            windowsHide: true,
          })
        : spawn(command, args, { cwd: options.cwd, env: options.env });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf('\n');
        if (!line.startsWith('{')) continue; // some servers print logs to stdout
        try {
          this.onMessage(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // not a message
        }
      }
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    this.child.on('error', (error) => this.end(error));
    this.child.on('exit', (code) => this.end(new Error(`MCP server exited (${code ?? 'killed'})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-500)}` : ''}`)));
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.ended || !this.child.stdin.writable) throw new Error(`MCP server is not running${this.stderr.trim() ? `: ${this.stderr.trim().slice(-500)}` : ''}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.child.stdin.end();
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid) {
      // The command runs under cmd.exe: end the whole tree.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      this.child.kill();
    }
  }

  private end(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.onClose(error);
  }
}

/** Splits an SSE body into the `data` of each event. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
      const event = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

/** Reads both `event:` names and `data:` payloads from an SSE body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let split = buffer.indexOf('\n\n');
    while (split >= 0) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) yield { event, data: data.join('\n') };
    }
  }
}

/**
 * The original MCP SSE transport: a GET stream carries server messages, and the server
 * announces a POST endpoint in its first `endpoint` event. Kept for servers that have
 * not moved to Streamable HTTP.
 */
export class SseLink implements McpLink {
  onMessage: (message: JsonRpcMessage) => void = () => {};
  onClose: (error?: Error) => void = () => {};
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly controller = new AbortController();
  private current?: AbortController;
  private endpoint?: string;
  private readonly ready: Promise<string>;
  private started = false;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  /** The first attempt is immediate; a failed start is retried twice with a short backoff. */
  private async start(): Promise<string> {
    const delays = [500, 1500];
    let lastError: Error | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.open();
      } catch (error) {
        lastError = error as Error;
        if (this.started || attempt >= delays.length) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delays[attempt]!);
          timer.unref?.();
        });
      }
    }
    throw lastError ?? new Error('MCP SSE connection failed');
  }

  private async open(): Promise<string> {
    const controller = new AbortController();
    this.current = controller;
    if (this.started) controller.abort();
    const closed = () => this.started || controller.signal.aborted;
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'GET',
        headers: { ...this.headers, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MCP SSE endpoint answered HTTP ${response.status}`);
      if (!response.body) throw new Error('MCP SSE endpoint sent no stream');
    } catch (error) {
      if (this.current === controller) this.current = undefined;
      throw error;
    }
    const base = response.url || this.url;
    const body = response.body;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timer = setTimeout(() => {
        fail(new Error('MCP SSE server did not send an endpoint within 30 s'));
        controller.abort();
      }, 30_000);
      const consume = async () => {
        try {
          for await (const event of sseEvents(body)) {
            if (event.event === 'endpoint') {
              if (settled) continue;
              const target = new URL(event.data, base);
              this.endpoint = target.toString();
              settled = true;
              clearTimeout(timer);
              resolve(this.endpoint);
              continue;
            }
            if (event.event !== 'message') continue;
            try {
              this.onMessage(JSON.parse(event.data) as JsonRpcMessage);
            } catch {
              // a comment or a malformed message
            }
          }
          clearTimeout(timer);
          if (this.endpoint) {
            // The server stream is the session: a new one needs a fresh connect (the hub does that).
            if (!this.started) this.onClose(new Error('MCP SSE stream ended'));
          } else {
            fail(new Error('MCP SSE stream ended before it sent an endpoint'));
          }
        } catch (error) {
          clearTimeout(timer);
          const reason = error as Error;
          if (!settled) fail(reason);
          if (!closed() && this.endpoint) this.onClose(reason);
        } finally {
          if (this.current === controller) this.current = undefined;
        }
      };
      void consume();
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.started) throw new Error('MCP SSE connection is closed');
    const endpoint = await this.ready;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: this.controller.signal,
    });
    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new Error(`MCP SSE server answered HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    // A few servers answer on the POST itself instead of the stream.
    const text = await response.text();
    if (!text.trim()) return;
    try {
      const body = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
      for (const entry of Array.isArray(body) ? body : [body]) this.onMessage(entry);
    } catch {
      // the answer is expected on the stream
    }
  }

  async close(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.controller.abort();
    this.current?.abort();
    this.endpoint = undefined;
  }
}

/** A server at a URL (Streamable HTTP): each message is a POST; answers come back on it. */
export class HttpLink implements McpLink {
  onMessage: (message: JsonRpcMessage) => void = () => {};
  onClose: (error?: Error) => void = () => {};
  protocolVersion?: string;
  private session?: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }

  private requestHeaders(): Record<string, string> {
    return {
      ...this.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.session ? { 'mcp-session-id': this.session } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(300_000),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.session = session;
    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new Error(`MCP server answered HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && response.body) {
      for await (const data of sseData(response.body)) {
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(data) as JsonRpcMessage;
        } catch {
          continue;
        }
        this.onMessage(parsed);
        // The stream may stay open for more; our answer is all we wait for.
        if (message.id !== undefined && parsed.id === message.id && parsed.method === undefined) break;
      }
      return;
    }
    const text = await response.text();
    if (!text.trim()) return;
    const body = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    for (const entry of Array.isArray(body) ? body : [body]) this.onMessage(entry);
  }

  async close(): Promise<void> {
    if (!this.session) return;
    // Lets the server drop the session; not waited for.
    fetch(this.url, { method: 'DELETE', headers: this.requestHeaders(), signal: AbortSignal.timeout(5000) }).catch(() => {});
    this.session = undefined;
  }
}

interface Waiting {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private readonly link: McpLink;
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 1;
  private closedWith?: Error;
  serverInfo?: { name?: string; version?: string };
  /** Called once when the connection is gone (server exited, closed). */
  onClose?: (error: Error) => void;

  constructor(link: McpLink) {
    this.link = link;
    link.onMessage = (message) => this.receive(message);
    link.onClose = (error) => this.fail(error ?? new Error('MCP connection closed'));
  }

  /** Opens the session: `initialize`, then `notifications/initialized`. */
  static async connect(link: McpLink, timeoutMs = 30_000): Promise<McpClient> {
    const client = new McpClient(link);
    try {
      const result = (await client.request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'mimi', version: '0.1.0' } },
        { timeoutMs },
      )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
      client.serverInfo = result.serverInfo;
      link.protocolVersion = result.protocolVersion ?? MCP_PROTOCOL_VERSION;
      await client.notify('notifications/initialized');
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  request(method: string, params?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    if (options.signal?.aborted) return Promise.reject(new Error('aborted'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.settle(id)?.reject(new Error('aborted'));
        void this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' }).catch(() => {});
      };
      const timeoutMs = options.timeoutMs ?? 120_000;
      this.waiting.set(id, {
        resolve: (result) => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
        reject: (error) => {
          options.signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer: setTimeout(() => this.settle(id)?.reject(new Error(`MCP "${method}" took longer than ${Math.round(timeoutMs / 1000)} s`)), timeoutMs),
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.link.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch((error: Error) => this.settle(id)?.reject(error));
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.link.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Every tool, following `nextCursor`. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: 60_000 })) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    return (await this.request('tools/call', { name, arguments: args ?? {} }, { signal, timeoutMs: 300_000 })) as McpCallResult;
  }

  async close(): Promise<void> {
    this.fail(new Error('MCP connection closed'));
    await this.link.close();
  }

  private settle(id: number): Waiting | undefined {
    const entry = this.waiting.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.waiting.delete(id);
    return entry;
  }

  private receive(message: JsonRpcMessage): void {
    if (message.method !== undefined) {
      // A request from the server: answer ping, decline the rest (no sampling / roots here).
      if (message.id === undefined) return;
      const reply: JsonRpcMessage =
        message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Mimi does not support "${message.method}"` } };
      this.link.send(reply).catch(() => {});
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.settle(message.id);
    if (!entry) return;
    if (message.error) entry.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result ?? {});
  }

  private fail(error: Error): void {
    if (this.closedWith) return;
    this.closedWith = error;
    for (const id of [...this.waiting.keys()]) this.settle(id)?.reject(error);
    this.onClose?.(error);
  }
}

/** What the model gets back from a tool call; a tool error becomes a thrown error. */
export function callResultText(result: McpCallResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === 'text') parts.push(item.text ?? '');
    else if (item.type === 'image' || item.type === 'audio') {
      parts.push(`[${item.type} ${item.mimeType ?? ''}, ${Math.round(((item.data?.length ?? 0) * 3) / 4)} bytes]`);
    } else if (item.type === 'resource') parts.push(item.resource?.text ?? `[resource ${item.resource?.uri ?? ''}]`);
    else if (item.type === 'resource_link') parts.push(`[link] ${item.name ?? ''} ${item.uri ?? ''}`.trim());
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join('\n').trim();
  if (result.isError) throw new Error(text || 'The MCP tool reported an error.');
  return text || '(no output)';
}
