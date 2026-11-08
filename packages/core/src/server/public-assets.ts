import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { renderIconPng } from '../app/icon.ts';

// What a core answers without a token besides the API: the release number, the backdrop art
// and the icon that native apps load. The server never serves a page or a script: the UI is
// bundled in each app (packages/ui) and talks to the core only through the API and /ws.

/** The app's release number, from the root package.json (shown in Settings and by /health). */
export const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../../package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** The built-in backdrop art, served with a long cache (the native apps ask for it by name). */
const BACKGROUND_DIR = path.join(import.meta.dirname, 'assets', 'backgrounds');

/** App icons, drawn once on first request: the tab/desktop icon and what Android and iOS put on the home screen. */
const ICONS: Record<string, () => Buffer> = {
  '/icon.png': () => renderIconPng(),
  '/icon-192.png': () => renderIconPng(192),
  '/icon-512.png': () => renderIconPng(512),
  '/icon-maskable-512.png': () => renderIconPng(512, { maskable: true }),
  // iOS fills transparent corners with black and rounds the tile itself: the full square.
  '/apple-touch-icon.png': () => renderIconPng(180, { maskable: true }),
};
const icons = new Map<string, Buffer>();

/**
 * Answers a range request for one file (chat media); players need this to seek
 * without reloading, and AVPlayer will not play a video from a server without it.
 */
export function serveFileRange(
  file: string,
  name: string,
  mime: string,
  response: http.ServerResponse,
  range?: string,
  options: { headers?: Record<string, string>; disposition?: 'inline' | 'attachment' } = {},
): void {
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    response.writeHead(404).end();
    return;
  }
  const headers: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${options.disposition ?? 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    ...options.headers,
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec((range ?? '').trim());
  let start = 0;
  let end = size - 1;
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      // "bytes=-500": the last 500 bytes.
      start = Math.max(0, size - Number(match[2]));
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
  } else {
    response.writeHead(200, { ...headers, 'content-length': size });
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

/**
 * Answers a GET for the few public assets (backdrops, icon) that need no token. Shared with
 * the accounts gateway. Returns false for any other path. Pages and scripts are never served:
 * `/` says so and nothing else.
 */
export function servePublicAssets(pathname: string, response: http.ServerResponse): boolean {
  if (pathname === '/') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('This is a Mimi server: it answers the API only. Open a Mimi app and connect it to this address.');
    return true;
  }
  if (pathname.startsWith('/backgrounds/')) {
    const name = pathname.slice('/backgrounds/'.length);
    if (!/^[a-z0-9-]+\.webp$/.test(name)) {
      response.writeHead(404).end();
      return true;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(path.join(BACKGROUND_DIR, name));
    } catch {
      response.writeHead(404).end();
      return true;
    }
    response.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': body.length,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
    return true;
  }
  if (ICONS[pathname]) {
    let icon = icons.get(pathname);
    if (!icon) icons.set(pathname, (icon = ICONS[pathname]!()));
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
    response.end(icon);
    return true;
  }
  return false;
}
