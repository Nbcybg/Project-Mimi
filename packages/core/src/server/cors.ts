import type http from 'node:http';

// The UI is bundled in each app, so its page comes from the app's own origin and every call to
// a core (or the gateway) is cross-origin. Only these origins may make such calls from a
// browser engine; the token still decides who may do what. Non-browser clients (the native
// apps, scripts, webhooks) send no Origin and are not affected.

/** Origins of the app shells: Electron (app://mimi), Tauri on desktop and on Android/Windows. */
export const APP_ORIGINS = ['app://mimi', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'] as const;

/** The built-in origins plus MIMI_ALLOWED_ORIGINS (comma separated, exact origins like https://ui.example.com). */
export function allowedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.MIMI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return [...new Set([...APP_ORIGINS, ...extra])];
}

export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  return Boolean(origin) && allowed.includes(origin!);
}

const ALLOW_HEADERS = 'authorization, content-type, range, x-mimi-secret';
const EXPOSE_HEADERS = 'x-mimi-api, content-range, accept-ranges, content-length, content-disposition';

/**
 * Adds the CORS headers for an allowed origin and answers its preflight. Returns true when the
 * request was a preflight and has been answered (nothing more to do).
 */
export function applyCors(request: http.IncomingMessage, response: http.ServerResponse, allowed: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  response.setHeader('vary', 'Origin');
  if (!originAllowed(origin, allowed)) {
    // A preflight from anywhere else is refused; a plain request goes on without CORS headers,
    // so a page there cannot read the answer.
    if (request.method === 'OPTIONS') {
      response.writeHead(403).end();
      return true;
    }
    return false;
  }
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-expose-headers', EXPOSE_HEADERS);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': ALLOW_HEADERS,
      'access-control-max-age': '600',
    });
    response.end();
    return true;
  }
  return false;
}
