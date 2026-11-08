'use strict';
// The Mimi UI (packages/ui) is part of the app: both Electron shells show it from app://mimi.
// A server (the local core, or the one the person signed in to) is never asked for a page or a
// script, only for the API and /ws; so it carries no UI traffic and works the same on a slow link.
//
//   registerScheme()          before the app is ready
//   serve(session, getCore)   after it is ready, once per session that shows the UI
//   url({ core, token })      what a window loads; core and token ride in the fragment, which
//                             never leaves the machine
//   isUiUrl(url)              whether a page is the app's own UI (the only page that may use
//                             the shell's IPC calls and the microphone)

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');

const SCHEME = 'app';
const HOST = 'mimi';
const ORIGIN = `${SCHEME}://${HOST}`;
// Packaged: <app>/ui beside the shell files. From the sources: packages/ui beside packages/desktop.
const UI_DIR = [path.join(__dirname, 'ui'), path.join(__dirname, '..', 'ui')].map((dir) => path.resolve(dir)).find((dir) => fs.existsSync(path.join(dir, 'index.html')));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

function registerScheme() {
  // secure: the microphone and notifications need a secure page; fetch: the page calls the core.
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

/**
 * The page may run only its own scripts (the import map and the boot-time theme are allowed by
 * their hashes), may not be framed, and may talk to its own core only: if a message ever
 * smuggled markup into the page it could not read the session token or send it anywhere else.
 */
function policy(body, core) {
  const inline = [...body.toString('utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${crypto.createHash('sha256').update(match[1]).digest('base64')}'`,
  );
  let origin = '';
  let socket = '';
  try {
    const parsed = new URL(core);
    origin = parsed.origin;
    socket = `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}`;
  } catch {
    // no core yet (the connect page does not use this protocol)
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${inline.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "media-src 'self' blob: data: https:",
    // The 3D stage loads its models and textures from blob: and data: URLs; Settings asks GitHub
    // (read only, no credentials) whether a newer release exists (feature-update.js).
    `connect-src 'self' ${origin} ${socket} blob: data: https://api.github.com`.replace(/\s+/g, ' '),
    "font-src 'self' data:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function serve(ses, getCore) {
  if (!UI_DIR) throw new Error('packages/ui is missing: the app has no UI to show (run node scripts/sync-ui.mjs after npm install)');
  ses.protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const notFound = () => new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (url.host !== HOST) return notFound();
    let relative;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (relative === '/' || relative === '') relative = '/index.html';
    const file = path.resolve(UI_DIR, `.${relative}`);
    if (!file.startsWith(UI_DIR + path.sep)) return notFound();
    let body;
    try {
      if (!fs.statSync(file).isFile()) return notFound();
      body = fs.readFileSync(file);
    } catch {
      return notFound();
    }
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (type.startsWith('text/html')) {
      headers['content-security-policy'] = policy(body, getCore());
      headers['cache-control'] = 'no-store';
    } else {
      headers['cache-control'] = 'max-age=3600';
    }
    return new Response(body, { status: 200, headers });
  });
}

function url({ core, token } = {}) {
  const parts = [];
  if (core) parts.push(`core=${encodeURIComponent(core)}`);
  if (token) parts.push(`token=${encodeURIComponent(token)}`);
  return `${ORIGIN}/${parts.length ? `#${parts.join('&')}` : ''}`;
}

const isUiUrl = (value) => typeof value === 'string' && (value === ORIGIN || value.startsWith(`${ORIGIN}/`));

module.exports = { ORIGIN, registerScheme, serve, url, isUiUrl };
