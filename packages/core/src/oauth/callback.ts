import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Where an OAuth provider sends the browser back with the code. On the user's own computer
 * that is a temporary listener on this machine (loopback); a core on a server has no way to
 * be reached at 127.0.0.1 from the user's browser, so it takes the code on its own public
 * address instead (`/oauth/callback`, see {@link HostedCallbacks}).
 */
export interface CodeReceiver {
  /** The redirect_uri to send to the provider, both at sign-in and when exchanging the code. */
  redirectUri: string;
  /** Resolves with the authorization code; rejects when sign-in fails or times out. */
  code: Promise<string>;
  /** Stops waiting (the flow ended or failed elsewhere). */
  close(): void;
}

export interface ReceiverOptions {
  /** Shown in the browser tab after sign-in, e.g. "Google". */
  label: string;
  /** Loopback only: the callback path ("/" for Google and Microsoft, "/callback" for connectors). */
  path?: string;
  /** Loopback only: the host written into redirect_uri (Microsoft registers "localhost"). */
  host?: 'localhost' | '127.0.0.1';
  timeoutMs?: number;
}

export type ReceiverFactory = (state: string, options: ReceiverOptions) => Promise<CodeReceiver>;

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

/** What the browser shows on the callback page. */
function answer(response: http.ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(text);
}

/** Reads one callback; returns the code, or the reason sign-in did not complete. */
function readCallback(params: URLSearchParams): { code: string } | { error: string } {
  const code = params.get('code');
  if (code) return { code };
  const reason = params.get('error_description') ?? params.get('error') ?? 'no code';
  return { error: reason.split('\n')[0]! };
}

/** The desktop flow: a temporary listener on 127.0.0.1 that takes one callback. */
export const loopbackReceiver: ReceiverFactory = async (state, options) => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const path = options.path ?? '/';
  const redirectUri = `http://${options.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}${path === '/' ? '' : path}`;
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  const code = new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => {
      close();
      reject(new Error(`${options.label} sign-in timed out`));
    }, options.timeoutMs ?? FLOW_TIMEOUT_MS);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      if (path !== '/' && url.pathname !== path) return answer(response, 404, 'Not found.');
      if (url.searchParams.get('state') !== state) return answer(response, 400, 'State mismatch. Start again.');
      const result = readCallback(url.searchParams);
      close();
      if ('error' in result) {
        answer(response, 400, `Sign-in was not completed: ${result.error}`);
        return reject(new Error(`${options.label} sign-in was not completed: ${result.error}`));
      }
      answer(response, 200, `Mimi is connected to ${options.label}. You can close this tab.`);
      resolve(result.code);
    });
  });
  code.catch(() => {}); // the flow decides whether to await it
  return { redirectUri, code, close };
};

interface Waiting {
  label: string;
  resolve(code: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Callbacks on the core's own public address: `<base>/oauth/callback`. Each sign-in waits
 * under its `state`, which is random and known only to the provider and this process, so
 * the route needs no token and acts only on a sign-in that is in progress.
 */
export class HostedCallbacks {
  static readonly PATH = '/oauth/callback';
  readonly redirectUri: string;
  private readonly waiting = new Map<string, Waiting>();

  constructor(baseUrl: string) {
    this.redirectUri = `${baseUrl.replace(/\/+$/, '')}${HostedCallbacks.PATH}`;
  }

  readonly receiver: ReceiverFactory = async (state, options) => {
    let waiting: Waiting | undefined;
    const close = () => {
      if (waiting && this.waiting.get(state) === waiting) this.waiting.delete(state);
      if (waiting) clearTimeout(waiting.timer);
    };
    const code = new Promise<string>((resolve, reject) => {
      waiting = {
        label: options.label,
        resolve,
        reject,
        timer: setTimeout(() => {
          close();
          reject(new Error(`${options.label} sign-in timed out`));
        }, options.timeoutMs ?? FLOW_TIMEOUT_MS),
      };
      waiting.timer.unref();
      this.waiting.set(state, waiting);
    });
    code.catch(() => {}); // the flow decides whether to await it
    return { redirectUri: this.redirectUri, code, close };
  };

  /** Answers `GET /oauth/callback`; false for any other request. */
  handle(method: string | undefined, url: URL, response: http.ServerResponse): boolean {
    if (method !== 'GET' || url.pathname !== HostedCallbacks.PATH) return false;
    const state = url.searchParams.get('state') ?? '';
    const waiting = this.waiting.get(state);
    if (!waiting) {
      answer(response, 400, 'This sign-in link has expired or was already used. Start again from Mimi.');
      return true;
    }
    this.waiting.delete(state);
    clearTimeout(waiting.timer);
    const result = readCallback(url.searchParams);
    if ('error' in result) {
      answer(response, 400, `Sign-in was not completed: ${result.error}`);
      waiting.reject(new Error(`${waiting.label} sign-in was not completed: ${result.error}`));
    } else {
      answer(response, 200, `Mimi is connected to ${waiting.label}. You can close this tab.`);
      waiting.resolve(result.code);
    }
    return true;
  }

  /** Sign-ins still waiting for their callback. */
  pending(): number {
    return this.waiting.size;
  }
}

/**
 * The public base address of this core, when it has one: MIMI_PUBLIC_URL, or the domain
 * Railway gives the service (RAILWAY_PUBLIC_DOMAIN). Undefined on a computer, where the
 * loopback flow is used.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.MIMI_PUBLIC_URL?.trim();
  if (explicit) {
    const url = new URL(explicit);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('MIMI_PUBLIC_URL must be https:// (OAuth providers do not redirect to plain http on the internet)');
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }
  const railway = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  return railway ? `https://${railway}` : undefined;
}
