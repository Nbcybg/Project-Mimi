import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  BrowserSession,
  browserArguments,
  browserTools,
  type CdpClient,
  checkUrl,
  connectCdp,
  findBrowserExecutable,
  formatSnapshot,
  isLocalHost,
  readDevToolsAddress,
  setBrowserSession,
  startBrowser,
} from '@mimi/pc-agent';
import { parseToolFile, type ToolDefinition } from '@mimi/shared';
import { makeTestCore } from './core-helpers.ts';

// realpath: on macOS os.tmpdir() is /var/..., a symlink to /private/var/..., and the
// path guard and screenshots work with the canonical path.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-browser-')));
after(() => {
  setBrowserSession(null);
  try {
    // A browser that was just closed may still hold files for a moment (Windows).
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // left in the temp folder; harmless
  }
});

type Handler = (params: any, sessionId?: string) => unknown;

/** A scripted stand-in for the browser: `handlers` answer commands by name; every call is recorded. */
function fakeCdp(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: any; sessionId?: string }> = [];
  const closers: Array<() => void> = [];
  const cdp: CdpClient = {
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      const handler = handlers[method];
      return handler ? ((await handler(params, sessionId)) ?? {}) : {};
    },
    close() {
      for (const closer of closers) closer();
    },
    onClose(listener) {
      closers.push(listener);
    },
  };
  return { cdp, calls };
}

const noSleep = async () => {};
const snapshotOf = (overrides: Record<string, unknown> = {}) => ({
  url: 'http://example.com/',
  title: 'Example',
  text: 'Hello',
  truncated: false,
  items: [
    { ref: 'e1', tag: 'a', name: 'More', href: 'http://example.com/more' },
    { ref: 'e2', tag: 'input', type: 'text', name: 'Search', value: 'abc' },
    { ref: 'e3', tag: 'input', type: 'password', name: 'Secret' },
  ],
  scroll: { y: 0, height: 1500, view: 700 },
  ...overrides,
});

/** A page world: targets, the address shown, and the elements `find` can locate. */
function fakeWorld(options: { opensTabOnClick?: boolean; endsAt?: string } = {}) {
  const targets = [{ targetId: 't1', type: 'page', title: 'Home', url: 'about:blank' }];
  const world = { url: 'about:blank', title: 'Home', elements: { e1: { x: 10, y: 20, tag: 'a', type: '', name: 'More' }, e2: { x: 30, y: 40, tag: 'input', type: 'text', name: 'Search' }, e3: { x: 50, y: 60, tag: 'input', type: 'password', name: '' } } as Record<string, unknown> };
  const handlers: Record<string, Handler> = {
    'Target.getTargets': () => ({ targetInfos: targets }),
    'Target.createTarget': () => {
      targets.push({ targetId: `t${targets.length + 1}`, type: 'page', title: '', url: 'about:blank' });
      return { targetId: `t${targets.length}` };
    },
    'Target.attachToTarget': (params) => ({ sessionId: `s-${params.targetId}` }),
    'Page.navigate': (params) => {
      world.url = options.endsAt ?? params.url;
      return {};
    },
    'Input.dispatchMouseEvent': (params) => {
      if (options.opensTabOnClick && params.type === 'mouseReleased') targets.push({ targetId: 't9', type: 'page', title: 'Popup', url: 'http://example.com/popup' });
      return {};
    },
    'Runtime.evaluate': (params) => {
      const expression = String(params.expression);
      if (expression === 'document.readyState') return { result: { value: 'complete' } };
      if (expression.includes('MAX_ITEMS')) return { result: { value: JSON.stringify(snapshotOf({ url: world.url })) } };
      if (expression.includes('location.href, title')) return { result: { value: { url: world.url, title: world.title } } };
      const ref = /data-mimi-ref="(e\d+)"/.exec(expression)?.[1];
      if (ref && expression.includes('scrollIntoView')) return { result: { value: world.elements[ref] ?? null } };
      return { result: { value: true } };
    },
  };
  return { targets, world, handlers };
}

test('addresses: only http(s) on the internet, unless local ones are allowed on purpose', () => {
  assert.equal(checkUrl('https://example.com/a?b=1').hostname, 'example.com');
  assert.throws(() => checkUrl('file:///C:/Windows/win.ini'), /Only http/);
  assert.throws(() => checkUrl('javascript:alert(1)'), /Only http/);
  assert.throws(() => checkUrl('not a url'), /not a valid address/);
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.1.2.3', '172.16.0.5', '172.31.9.9', '192.168.1.1', '169.254.1.1', '100.64.0.1', 'printer.local', 'nas.lan', '[::1]', 'fd12::1', 'fe80::1']) {
    assert.equal(isLocalHost(host), true, host);
    assert.throws(() => checkUrl(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`), /local network/, host);
  }
  assert.throws(() => checkUrl('http://2130706433/'), /local network/, 'a number is an address too');
  assert.equal(isLocalHost('172.32.0.1'), false);
  assert.equal(isLocalHost('example.com'), false);
  assert.equal(isLocalHost('fcbarcelona.com'), false, 'a name is not an IPv6 prefix');
  assert.equal(checkUrl('http://127.0.0.1:3000/', true).port, '3000');
});

test('launching: which browser, its flags, and where the profile address is read', () => {
  const win = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const edge = path.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(findBrowserExecutable(win, 'win32', (file) => file === edge), edge);
  const chrome = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findBrowserExecutable(win, 'win32', (file) => file === chrome), chrome, 'Chrome when there is no Edge');
  assert.equal(findBrowserExecutable(win, 'win32', () => false), undefined);
  assert.equal(findBrowserExecutable({ MIMI_BROWSER_PATH: 'X:\\mine.exe' }, 'win32', (file) => file === 'X:\\mine.exe'), 'X:\\mine.exe');
  assert.equal(findBrowserExecutable({ MIMI_BROWSER_PATH: 'X:\\gone.exe' }, 'win32', () => false), undefined, 'a wrong override is not replaced silently');
  assert.ok(findBrowserExecutable({ PATH: '/usr/bin' }, 'linux', (file) => file === path.join('/usr/bin', 'chromium')));
  assert.ok(findBrowserExecutable({}, 'darwin', (file) => file.includes('Google Chrome')));

  const flags = browserArguments('/p', false);
  for (const flag of ['--remote-debugging-port=0', '--user-data-dir=/p', '--disable-sync', '--no-first-run']) assert.ok(flags.includes(flag), flag);
  assert.equal(flags.includes('--headless=new'), false);
  assert.ok(browserArguments('/p', true).includes('--headless=new'));
  // The desktop app's own Electron in browser mode: the app script (or the executable
  // itself, once packaged) is passed after the switches, never a blank Chrome tab.
  const desktop = browserArguments('/p', false, { MIMI_BROWSER_APP: path.resolve('/app/main.cjs') });
  assert.equal(desktop.at(-2), path.resolve('/app/main.cjs'));
  assert.equal(desktop.at(-1), '--mimi-browser');
  assert.equal(desktop.includes('about:blank'), false);
  assert.deepEqual(browserArguments('/p', false, { MIMI_BROWSER_SELF: '1' }).slice(-1), ['--mimi-browser']);

  const profile = path.join(tmp, 'profile');
  assert.equal(readDevToolsAddress(profile), undefined);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '9222\n/devtools/browser/abc-123\n');
  assert.equal(readDevToolsAddress(profile), 'ws://127.0.0.1:9222/devtools/browser/abc-123');
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), 'garbage');
  assert.equal(readDevToolsAddress(profile), undefined);
});

test('session: a stale address falls back to a fresh start, downloads are denied, a tab is made when none exists', async () => {
  const { handlers, targets } = fakeWorld();
  targets.length = 0;
  const { cdp, calls } = fakeCdp(handlers);
  const connected: string[] = [];
  let started = 0;
  const session = new BrowserSession({
    connect: async (url) => {
      connected.push(url);
      if (url === 'ws://stale') throw new Error('refused');
      return cdp;
    },
    start: async () => {
      started++;
      return 'ws://fresh';
    },
    existing: () => 'ws://stale',
    sleep: noSleep,
  });
  const { url } = await session.run(() => session.open('https://example.com/'));
  assert.deepEqual([connected, started, url], [['ws://stale', 'ws://fresh'], 1, 'https://example.com/']);
  assert.deepEqual(calls.find((call) => call.method === 'Browser.setDownloadBehavior')!.params, { behavior: 'deny' });
  assert.ok(calls.some((call) => call.method === 'Target.createTarget'));
  const nav = calls.find((call) => call.method === 'Page.navigate')!;
  assert.deepEqual([nav.params.url, nav.sessionId], ['https://example.com/', 's-t1']);
  await assert.rejects(session.open('http://192.168.0.1/'), /local network/);
  await assert.rejects(session.open('file:///etc/passwd'), /Only http/);
});

test('session: a page that ends up on a forbidden address is blanked', async () => {
  const { handlers, calls } = (() => {
    const world = fakeWorld({ endsAt: 'http://192.168.0.1/admin' });
    return { handlers: world.handlers, calls: fakeCdp(world.handlers).calls };
  })();
  const fake = fakeCdp(handlers);
  const session = new BrowserSession({ connect: async () => fake.cdp, start: async () => 'x', existing: () => 'x', sleep: noSleep });
  await assert.rejects(session.open('https://redirects.example/'), /tab was blanked/);
  const navigations = fake.calls.filter((call) => call.method === 'Page.navigate').map((call) => call.params.url);
  assert.deepEqual(navigations, ['https://redirects.example/', 'about:blank']);
  assert.equal(calls.length, 0);
});

test('session: click moves the mouse to the element, follows a new tab, and refuses unknown refs', async () => {
  const world = fakeWorld({ opensTabOnClick: true });
  const fake = fakeCdp(world.handlers);
  const session = new BrowserSession({ connect: async () => fake.cdp, start: async () => 'x', existing: () => 'x', sleep: noSleep });
  await session.open('http://example.com/');
  const result = await session.click('e1');
  assert.deepEqual([result.newTab, result.target], [true, 'a "More"']);
  const mouse = fake.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse.map((call) => [call.params.type, call.params.x, call.params.y]), [['mouseMoved', 10, 20], ['mousePressed', 10, 20], ['mouseReleased', 10, 20]]);
  assert.ok(fake.calls.some((call) => call.method === 'Target.attachToTarget' && call.params.targetId === 't9'), 'the new tab became current');
  assert.equal(fake.calls.at(-1)!.sessionId, 's-t9');
  await assert.rejects(session.click('e77'), /No element e77/);
  await assert.rejects(session.click('"><script>'), /not an element ref/);
});

test('session: typing replaces text, presses Enter on request, and never fills a password', async () => {
  const world = fakeWorld();
  const fake = fakeCdp(world.handlers);
  const session = new BrowserSession({ connect: async () => fake.cdp, start: async () => 'x', existing: () => 'x', sleep: noSleep });
  await session.open('http://example.com/');
  await session.type('e2', 'ฝนตก', { submit: true });
  assert.deepEqual(fake.calls.find((call) => call.method === 'Input.insertText')!.params, { text: 'ฝนตก' });
  const keys = fake.calls.filter((call) => call.method === 'Input.dispatchKeyEvent').map((call) => [call.params.type, call.params.key]);
  assert.deepEqual(keys, [['keyDown', 'Enter'], ['keyUp', 'Enter']]);
  await assert.rejects(session.type('e3', 'hunter2'), /password field/);
  assert.equal(fake.calls.filter((call) => call.method === 'Input.insertText').length, 1, 'nothing was typed into the password field');
  await assert.rejects(session.press('Hyper'), /Unknown key/);
});

test('session: a tab closed under it is replaced by another, and calls run one at a time', async () => {
  const world = fakeWorld();
  let failOnce = true;
  const handlers = {
    ...world.handlers,
    'Page.reload': () => {
      if (failOnce) {
        failOnce = false;
        throw new Error('No session with given id');
      }
      return {};
    },
  };
  const fake = fakeCdp(handlers);
  const session = new BrowserSession({ connect: async () => fake.cdp, start: async () => 'x', existing: () => 'x', sleep: noSleep });
  await session.open('http://example.com/');
  await session.history('reload');
  assert.equal(fake.calls.filter((call) => call.method === 'Page.reload').length, 2, 'retried once');

  const order: string[] = [];
  await Promise.all([
    session.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('first');
    }),
    session.run(async () => void order.push('second')),
  ]);
  assert.deepEqual(order, ['first', 'second']);
});

test('tools: what the model sees, and the rules around them', async () => {
  const text = formatSnapshot(snapshotOf() as never);
  assert.match(text, /^Page: Example\nURL: http:\/\/example\.com\/\nScroll: 0 of 800 px/);
  assert.match(text, /\[e1\] a "More" -> http:\/\/example\.com\/more/);
  assert.match(text, /\[e2\] input\(text\) "Search" value="abc"/);
  assert.match(text, /\[e3\] input\(password\) "Secret"\n/);
  assert.doesNotMatch(text, /e3.*value=/);

  const world = fakeWorld();
  const fake = fakeCdp({ ...world.handlers, 'Page.captureScreenshot': () => ({ data: Buffer.from('PNGDATA').toString('base64') }) });
  setBrowserSession(new BrowserSession({ connect: async () => fake.cdp, start: async () => 'x', existing: () => 'x', sleep: noSleep }));
  const folder = path.join(tmp, 'work');
  fs.mkdirSync(folder, { recursive: true });
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [folder] };
  const tool = (name: string) => browserTools.find((candidate) => candidate.name === name)! as ToolDefinition<any>;
  const run = (name: string, input: unknown) => tool(name).execute(tool(name).inputSchema.parse(input), context);

  const opened = await run('browser_open', { url: 'https://example.com/' });
  assert.match(opened, /^Opened: Home - https:\/\/example\.com\/\n\nPage: Example/);
  assert.match(await run('browser_snapshot', {}), /Elements you can use/);
  assert.match(await run('browser_click', { ref: 'e1' }), /^Clicked a "More"\./);
  assert.match(await run('browser_scroll', { direction: 'down' }), /^Scrolled to/);
  assert.match(await run('browser_tabs', {}), /\* 1\. /);
  // The picture travels to the core in the answer; nothing is written on the PC.
  const shot = parseToolFile(await run('browser_screenshot', {}));
  assert.equal(shot?.mime, 'image/png');
  assert.equal(Buffer.from(shot!.data, 'base64').toString(), 'PNGDATA');
  assert.equal(fs.existsSync(path.join(folder, 'browser-screenshots')), false);
  assert.equal(await run('browser_close', {}), 'The browser is closed.');
  assert.ok(fake.calls.some((call) => call.method === 'Browser.close'));

  // Reading the web is untrusted, so an agent with browser tools may not also have a shell tool.
  const risks = Object.fromEntries(browserTools.map((entry) => [entry.name, entry.risk]));
  assert.equal(risks.browser_open, 'network');
  assert.equal(risks.browser_click, 'write');
  assert.equal(risks.browser_type, 'write');
  assert.equal(risks.browser_snapshot, 'read');
  assert.equal(tool('browser_snapshot').untrustedInput, true);
  const target = await makeTestCore({});
  assert.throws(() => target.core.tools.select(['browser_open', 'run_shell']), /cannot have both/);
  assert.throws(() => target.core.tools.select(['browser_snapshot', 'power']), /cannot have both/);
  assert.equal(target.core.tools.select(['browser_open', 'browser_click', 'send_file']).length, 3);
  await target.cleanup();
});

test('a real browser, when one is installed: open, type, click, switch tabs, screenshot', async (t) => {
  const executable = findBrowserExecutable();
  if (!executable) return t.skip('no Edge or Chrome on this machine');
  const profile = path.join(tmp, 'real-profile');
  const env = { ...process.env, MIMI_BROWSER_PROFILE: profile, MIMI_BROWSER_HEADLESS: '1' };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/second') return response.end('<title>Second</title><h1>Second page</h1>');
    if (request.url?.startsWith('/search')) return response.end(`<title>Results</title>Results for ${new URL(request.url, 'http://x').searchParams.get('q')}`);
    response.end('<title>Home</title><a href="/second" target="_blank">New tab</a><form action="/search"><input name="q" placeholder="Search"></form>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const session = new BrowserSession({
    connect: connectCdp,
    start: () => startBrowser(env),
    existing: () => readDevToolsAddress(profile),
    allowLocal: true,
  });
  try {
    const home = await session.run(() => session.open(`${base}/`));
    assert.equal(home.title, 'Home');
    const snapshot = await session.run(() => session.snapshot());
    const link = snapshot.items.find((item) => item.name === 'New tab')!;
    const field = snapshot.items.find((item) => item.tag === 'input')!;
    const searched = await session.run(() => session.type(field.ref, 'ฝนตก', { submit: true }));
    assert.equal(searched.title, 'Results');
    assert.match((await session.run(() => session.snapshot())).text, /Results for ฝนตก/);
    await session.run(() => session.history('back'));
    await session.run(() => session.snapshot());
    const clicked = await session.run(() => session.click(link.ref));
    assert.deepEqual([clicked.newTab, clicked.title], [true, 'Second']);
    assert.equal((await session.run(() => session.tabs())).length, 2);
    await session.run(() => session.switchTab(1));
    assert.equal((await session.run(() => session.snapshot())).title, 'Home');
    const png = await session.run(() => session.screenshot());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  } finally {
    await session.run(() => session.close());
    server.close();
  }
});
