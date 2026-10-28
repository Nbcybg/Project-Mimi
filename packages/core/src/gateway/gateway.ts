import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import { AuthLimiter, clientAddress } from '../server/auth-limiter.ts';
import { APP_VERSION, serveWebFile } from '../server/web-files.ts';
import type { AccountStore, SessionTarget } from './accounts.ts';

/**
 * The accounts gateway: the only public entry when several people use Mimi. It serves the
 * web client, signs people in, and passes each signed-in connection on to that person's
 * own core (a separate service, reached over the private network with a token only the
 * gateway knows). It never reads or stores anyone's chats, files or settings.
 *
 * Routes:
 *   GET  /, scripts, /vendor/*, /icon.png   the web client (no sign-in)
 *   GET  /health                            { ok, version, accounts: true }
 *   POST /auth/login                        { username, password } -> { token, expiresAt, username, webhookBase }
 *   GET  /auth/session                      Bearer token -> { username, expiresAt, webhookBase }
 *   POST /auth/logout                       Bearer token -> 204; open sockets of it are closed
 *   *    /api/*                             Bearer token -> the person's core
 *   *    /h/<id>/api/(workflow|webhook)/<k> webhooks of one person's core (no sign-in, like a core)
 *   WS   /ws                                first frame { type: 'hello', token } -> the person's core
 */

export interface GatewayOptions {
  accounts: AccountStore;
  host: string;
  port: number;
  /** See CoreConfig.clientIpHeader. */
  clientIpHeader?: string;
  /** How often open sockets are checked against revoked or expired sessions. */
  sweepMs?: number;
  log?: (line: string) => void;
}

export interface Gateway {
  port: number;
  close(): Promise<void>;
}

const MAX_FRAME = 4 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/** Password checks at once, and how many may wait for one. */
const MAX_CHECKS = 4;
const MAX_WAITING = 32;
const BUSY = Symbol('busy');
/** Frames a device may send before its core has answered; more is not a real client. */
const MAX_QUEUED = 200;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
/** Headers that only mean something on the public side; the core must not trust them. */
const PUBLIC_ONLY = /^(authorization|cookie|x-real-ip|x-forwarded-.*|forwarded|x-railway-.*)$/i;

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readJson(request: http.IncomingMessage, limit = 4096): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

const bearer = (request: http.IncomingMessage) => /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];

function parse(data: RawData): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(String(data));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Codes a browser may be sent; the rest (1005, 1006, 1015) only describe what happened. */
function forwardable(code: number): number {
  // The core turning down the gateway's token is a setup mistake, not a bad device session:
  // the device keeps its session and tries again later.
  if (code === 4003) return 4502;
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1011;
}

function wsUrl(coreUrl: string): string {
  const url = new URL('/ws', coreUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { accounts } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  // Wrong passwords or session tokens per caller, and wrong passwords per account (so a
  // password cannot be guessed from many addresses; set higher so one caller cannot lock
  // the owner out as easily).
  const limiter = new AuthLimiter();
  const perAccount = new AuthLimiter({ maxFailures: 20 });
  const addressOf = (request: http.IncomingMessage) => clientAddress(request, options.clientIpHeader);
  // A password check is deliberately slow (scrypt): only a few run at once and a short line
  // waits, so a flood of sign-ins cannot take the whole CPU from the people already in.
  let checking = 0;
  const line: Array<() => void> = [];
  const checkSlot = async <T>(check: () => Promise<T>): Promise<T | typeof BUSY> => {
    if (checking < MAX_CHECKS) checking++;
    else if (line.length >= MAX_WAITING) return BUSY;
    else await new Promise<void>((resolve) => line.push(resolve));
    try {
      return await check();
    } finally {
      // The slot passes straight to the next in line, or is freed.
      const next = line.shift();
      if (next) next();
      else checking--;
    }
  };
  /** Open device sockets and the session each one belongs to. */
  const live = new Map<WebSocket, string>();

  const authorize = (request: http.IncomingMessage): SessionTarget | null => {
    const address = addressOf(request);
    if (limiter.blocked(address)) return null;
    const target = accounts.session(bearer(request));
    if (target) limiter.succeed(address);
    else limiter.fail(address);
    return target;
  };

  const endSockets = (sessionId: string | null) => {
    for (const [socket, id] of live) {
      if (sessionId ? id === sessionId : !accounts.sessionLive(id)) socket.close(4003, 'signed out');
    }
  };

  /** Streams a request to a core and its answer back; `coreToken` replaces the device's credential. */
  const proxy = (request: http.IncomingMessage, response: http.ServerResponse, coreUrl: string, pathAndQuery: string, coreToken?: string) => {
    const target = new URL(pathAndQuery, coreUrl);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name) && !PUBLIC_ONLY.test(name)) headers[name] = value;
    }
    if (coreToken) headers.authorization = `Bearer ${coreToken}`;
    const client = target.protocol === 'https:' ? https : http;
    const upstream = client.request(target, { method: request.method, headers, timeout: 15 * 60_000 }, (answer) => {
      const back: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) back[name] = value;
      response.writeHead(answer.statusCode ?? 502, back);
      answer.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!response.headersSent) sendJson(response, 502, { error: 'Your Mimi core cannot be reached right now.' });
      else response.destroy();
    });
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    if (method === 'GET' && serveWebFile(url.pathname, response)) return;
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, version: APP_VERSION, accounts: true });
      return;
    }

    if (url.pathname === '/auth/login' && method === 'POST') {
      const address = addressOf(request);
      // Only the app's own sign-in sends JSON; a form on another site cannot without CORS.
      if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
        sendJson(response, 415, { error: 'Send JSON.' });
        return;
      }
      const body = await readJson(request);
      const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : '';
      if (limiter.blocked(address) || (username && perAccount.blocked(username))) {
        sendJson(response, 429, { error: 'Too many wrong attempts. Try again later.' });
        return;
      }
      const opened = body && username ? await checkSlot(() => accounts.login(username, String(body.password ?? ''))) : null;
      if (opened === BUSY) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'Busy. Try again in a moment.' }));
        return;
      }
      if (!opened) {
        limiter.fail(address);
        if (username) perAccount.fail(username);
        log(`gateway: sign-in failed from ${address}`);
        sendJson(response, 401, { error: 'Wrong username or password.' });
        return;
      }
      limiter.succeed(address);
      perAccount.succeed(opened.target.username);
      log(`gateway: ${opened.target.username} signed in from ${address}`);
      const { username: name, expiresAt, webhookBase } = opened.target;
      sendJson(response, 200, { token: opened.token, username: name, expiresAt, webhookBase });
      return;
    }
    if (url.pathname === '/auth/session' && method === 'GET') {
      const target = authorize(request);
      if (!target) sendJson(response, 401, { error: 'Signed out.' });
      else sendJson(response, 200, { username: target.username, expiresAt: target.expiresAt, webhookBase: target.webhookBase });
      return;
    }
    if (url.pathname === '/auth/logout' && method === 'POST') {
      const target = authorize(request);
      if (target) {
        accounts.revoke(bearer(request)!);
        endSockets(target.sessionId);
        log(`gateway: ${target.username} signed out`);
      }
      response.writeHead(204, { 'cache-control': 'no-store' }).end();
      return;
    }

    const hook = /^\/h\/([\w-]{1,64})(\/api\/(?:workflow|webhook)\/[^/]+)$/.exec(url.pathname);
    if (hook) {
      const route = accounts.route(hook[1]!);
      if (!route) sendJson(response, 404, { error: 'No such webhook.' });
      else proxy(request, response, route.coreUrl, `${hook[2]}${url.search}`);
      return;
    }
    // A core's own webhook paths are only reachable through /h/<id>, which says whose they are.
    if (url.pathname.startsWith('/api/') && !/^\/api\/(workflow|webhook)\//.test(url.pathname)) {
      const target = authorize(request);
      if (!target) sendJson(response, 401, { error: 'Missing or wrong token.' });
      else proxy(request, response, target.coreUrl, `${url.pathname}${url.search}`, target.coreToken);
      return;
    }
    response.writeHead(404).end();
  };

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log(`gateway: ${(error as Error).message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'Something went wrong.' });
      else response.destroy();
    });
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_FRAME,
    // As on a core: browsers may only connect from pages this gateway served.
    verifyClient: ({ origin, req }: { origin?: string; req: http.IncomingMessage }) => {
      if (!origin) return true;
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    },
  });

  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (socket, request) => {
    const address = addressOf(request);
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    let upstream: WebSocket | null = null;
    const queued: Array<[RawData, boolean]> = [];
    const helloTimer = setTimeout(() => socket.close(4001, 'hello timeout'), HELLO_TIMEOUT_MS);
    const closeDevice = (code: number, reason: string) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(forwardable(code), reason.slice(0, 120));
    };

    socket.on('message', (data, isBinary) => {
      if (upstream) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        else if (queued.length < MAX_QUEUED) queued.push([data, isBinary]);
        else socket.close(1008, 'too many frames before the core answered');
        return;
      }
      if (limiter.blocked(address)) {
        socket.close(4029, 'too many wrong tokens; try again later');
        return;
      }
      const hello = parse(data);
      const target = hello?.type === 'hello' ? accounts.session(hello.token) : null;
      if (!hello || !target) {
        limiter.fail(address);
        socket.close(4003, 'invalid token');
        return;
      }
      limiter.succeed(address);
      clearTimeout(helloTimer);
      live.set(socket, target.sessionId);
      const core = new WebSocket(wsUrl(target.coreUrl), { maxPayload: MAX_FRAME, handshakeTimeout: 10_000 });
      upstream = core;
      core.on('open', () => {
        // The device's session token stays here; the core sees only its own token.
        core.send(JSON.stringify({ ...hello, token: target.coreToken }));
        for (const [frame, binary] of queued.splice(0)) core.send(frame, { binary });
      });
      core.on('message', (frame, binary) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame, { binary });
      });
      core.on('close', (code, reason) => {
        if (code === 4003) log(`gateway: the core of ${target.username} refused the gateway's token (check its MIMI_TOKEN)`);
        closeDevice(code, reason.toString());
      });
      core.on('error', () => closeDevice(1013, 'your Mimi core cannot be reached right now'));
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      live.delete(socket);
      if (upstream && upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
    });
    socket.on('error', () => socket.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_MS);
  // Sign-outs done elsewhere (the admin command, an expired session) end open sockets too.
  const sweep = setInterval(() => {
    endSockets(null);
    accounts.prune();
  }, options.sweepMs ?? 30_000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
