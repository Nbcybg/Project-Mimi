import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { serveWebFile } from '../server/web-files.ts';

// What Android (Chrome) needs to install the web app from the home screen, served the way a
// core and the accounts gateway both serve it.

async function serve(t: { after(fn: () => unknown): void }): Promise<string> {
  const server = http.createServer((request, response) => {
    if (!serveWebFile(new URL(request.url ?? '/', 'http://x').pathname, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Width, height and the first pixel's alpha of an 8-bit RGBA PNG with one IDAT chunk. */
function png(data: Buffer): { width: number; height: number; cornerAlpha: number } {
  assert.equal(data.subarray(1, 4).toString(), 'PNG');
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const at = data.indexOf('IDAT');
  const raw = zlib.inflateSync(data.subarray(at + 4, at + 4 + data.readUInt32BE(at - 4)));
  return { width, height, cornerAlpha: raw[4]! };
}

test('PWA: manifest with 192/512 and maskable icons that exist at those sizes', async (t) => {
  const base = await serve(t);
  const response = await fetch(`${base}/manifest.webmanifest`);
  assert.match(response.headers.get('content-type')!, /application\/manifest\+json/);
  const manifest = (await response.json()) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope, manifest.display], ['/', '/', '/', 'standalone']);
  for (const icon of manifest.icons) {
    const file = await fetch(`${base}${icon.src}`);
    assert.equal(file.headers.get('content-type'), 'image/png', icon.src);
    const image = png(Buffer.from(await file.arrayBuffer()));
    assert.equal(`${image.width}x${image.height}`, icon.sizes, icon.src);
    // Android cuts a maskable icon to its own shape: no transparent corners there.
    if (icon.purpose === 'maskable') assert.equal(image.cornerAlpha, 255, icon.src);
  }
  const sizes = manifest.icons.filter((icon) => icon.purpose === 'any').map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
});

test('PWA: the page links what exists; the offline page loads nothing from outside', async (t) => {
  const base = await serve(t);
  const page = await (await fetch(`${base}/`)).text();
  for (const [, href] of page.matchAll(/<link rel="(?:manifest|icon|apple-touch-icon)" href="([^"]+)"/g)) {
    assert.equal((await fetch(`${base}${href}`)).status, 200, href);
  }
  assert.equal(png(Buffer.from(await (await fetch(`${base}/apple-touch-icon.png`)).arrayBuffer())).width, 180);
  const offline = await fetch(`${base}/offline.html`);
  assert.equal(offline.status, 200);
  assert.doesNotMatch(await offline.text(), /(src|href)="(https?:)?\/\//, 'no outside resources');
  const worker = await (await fetch(`${base}/sw.js`)).text();
  assert.match(worker, /mode !== 'navigate'/, 'only page loads go through the worker');
  assert.match(worker, /'\/offline\.html'/);
});

test('PWA: the app page allows exactly its own import map; the offline page has its own policy', async (t) => {
  const base = await serve(t);
  const response = await fetch(`${base}/`);
  const page = await response.text();
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page)![1]!;
  const hash = crypto.createHash('sha256').update(map).digest('base64');
  const policy = response.headers.get('content-security-policy')!;
  assert.ok(policy.includes(`'sha256-${hash}'`), policy);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  assert.equal((await fetch(`${base}/app.js`)).headers.get('x-content-type-options'), 'nosniff');
  const offline = (await fetch(`${base}/offline.html`)).headers.get('content-security-policy')!;
  assert.match(offline, /default-src 'none'/);
  assert.match(offline, /frame-ancestors 'none'/);
});
