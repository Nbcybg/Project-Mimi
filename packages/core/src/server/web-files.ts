import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIconPng } from '../app/icon.ts';

// The built-in web client, served by a core and by the accounts gateway alike.

const WEB_DIR = path.join(import.meta.dirname, 'web');
/** The app's release number, from the root package.json (shown in Settings and by /health). */
export const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../../package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
/** The built-in web client: path -> [file, content type]. */
const WEB_FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/offline.html': ['offline.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/feature-tools.js': ['feature-tools.js', 'text/javascript; charset=utf-8'],
  '/feature-agent-tools.js': ['feature-agent-tools.js', 'text/javascript; charset=utf-8'],
  '/feature-accounts.js': ['feature-accounts.js', 'text/javascript; charset=utf-8'],
  '/feature-providers.js': ['feature-providers.js', 'text/javascript; charset=utf-8'],
  '/feature-overseer.js': ['feature-overseer.js', 'text/javascript; charset=utf-8'],
  '/feature-triggers.js': ['feature-triggers.js', 'text/javascript; charset=utf-8'],
  '/feature-workflows.js': ['feature-workflows.js', 'text/javascript; charset=utf-8'],
  '/feature-secrets.js': ['feature-secrets.js', 'text/javascript; charset=utf-8'],
  '/feature-chat.js': ['feature-chat.js', 'text/javascript; charset=utf-8'],
  '/feature-voice.js': ['feature-voice.js', 'text/javascript; charset=utf-8'],
  '/feature-knowledge.js': ['feature-knowledge.js', 'text/javascript; charset=utf-8'],
  '/feature-wardrobe.js': ['feature-wardrobe.js', 'text/javascript; charset=utf-8'],
  '/feature-stage.js': ['feature-stage.js', 'text/javascript; charset=utf-8'],
  '/feature-backgrounds.js': ['feature-backgrounds.js', 'text/javascript; charset=utf-8'],
  '/feature-gallery.js': ['feature-gallery.js', 'text/javascript; charset=utf-8'],
  '/feature-canvas.js': ['feature-canvas.js', 'text/javascript; charset=utf-8'],
  '/feature-profile.js': ['feature-profile.js', 'text/javascript; charset=utf-8'],
  '/feature-notify.js': ['feature-notify.js', 'text/javascript; charset=utf-8'],
  '/feature-vrm.js': ['feature-vrm.js', 'text/javascript; charset=utf-8'],
};

/** The 3D libraries (three.js, three-vrm) served from node_modules, so the client works offline. */
function vendorFile(request: string): string | undefined {
  if (request === '/vendor/three.module.js') return fileURLToPath(import.meta.resolve('three'));
  // three.module.js re-exports from './three.core.js' next to it in the build folder.
  if (request === '/vendor/three.core.js') {
    return path.join(path.dirname(fileURLToPath(import.meta.resolve('three'))), 'three.core.js');
  }
  if (request === '/vendor/three-vrm.module.js') return fileURLToPath(import.meta.resolve('@pixiv/three-vrm'));
  if (request.startsWith('/vendor/addons/')) {
    const rest = request.slice('/vendor/addons/'.length);
    if (!/^[a-zA-Z0-9/_.-]+$/.test(rest) || rest.includes('..')) return undefined;
    try {
      return fileURLToPath(import.meta.resolve(`three/examples/jsm/${rest}`));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Headers for the client's own files. Pages may not be framed by another site (a framed app
 * could be clicked through by a page the person does not see), and the app page may run
 * only scripts from this server: if a message ever smuggled markup into the page, it could
 * not read the session token. The one inline script, the import map, is allowed by its hash.
 */
function securityHeaders(file: string, body: Buffer): Record<string, string> {
  const common = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  if (!file.endsWith('.html')) return common;
  const frames = { 'x-frame-options': 'DENY', 'strict-transport-security': 'max-age=15552000' };
  if (file === 'offline.html') {
    return { ...common, ...frames, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'" };
  }
  const inline = [...body.toString('utf8').matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${crypto.createHash('sha256').update(match[1]!).digest('base64')}'`,
  );
  const policy = [
    "default-src 'self'",
    `script-src 'self' ${inline.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "media-src 'self' blob: data: https:",
    // The 3D stage loads its models and textures from blob: and data: URLs.
    "connect-src 'self' blob: data:",
    "font-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return { ...common, ...frames, 'content-security-policy': policy };
}

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
 * Answers a GET for the built-in web client (pages, scripts, 3D libraries, icon), which
 * needs no token. Shared with the accounts gateway. Returns false for any other path.
 */
export function serveWebFile(pathname: string, response: http.ServerResponse): boolean {
  const page = WEB_FILES[pathname];
  if (page) {
    const body = fs.readFileSync(path.join(WEB_DIR, page[0]));
    response.writeHead(200, { 'content-type': page[1], 'cache-control': 'no-store', ...securityHeaders(page[0], body) });
    response.end(body);
  } else if (pathname.startsWith('/vendor/')) {
    const file = vendorFile(pathname);
    if (file) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' });
      response.end(fs.readFileSync(file));
    } else {
      response.writeHead(404).end();
    }
  } else if (ICONS[pathname]) {
    let icon = icons.get(pathname);
    if (!icon) icons.set(pathname, (icon = ICONS[pathname]!()));
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
    response.end(icon);
  } else {
    return false;
  }
  return true;
}
