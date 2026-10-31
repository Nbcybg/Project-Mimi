import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  type ComputerAdapter,
  type ComputerAppInfo,
  type ComputerSnapshot,
  pcTools,
  setComputerAdapter,
} from '@mimi/pc-agent';
import { parseToolFile } from '@mimi/shared';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const snapshot: ComputerSnapshot = {
  platform: 'win32',
  activeApp: 'Mail',
  windows: [{ app: 'Mail', title: 'Inbox', active: true }],
  capturedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  nodes: [
    {
      ref: 'c',
      role: 'Window',
      name: 'Mail',
      children: [
        { ref: 'c0', role: 'Button', name: 'New Message', bounds: { x: 10, y: 20, width: 80, height: 30 } },
        { ref: 'c1', role: 'Edit', name: 'To', value: 'alice@example.com' },
        { ref: 'c2', role: 'Edit', name: 'Password', secure: true },
        { ref: 'c3', role: 'Text', name: 'Welcome to Mail' },
      ],
    },
  ],
};

const calls: string[] = [];
const fake: ComputerAdapter = {
  async observe() {
    return snapshot;
  },
  async click(ref) {
    calls.push(`click:${ref}`);
    return { ref, target: 'New Message' };
  },
  async type(ref, text) {
    calls.push(`type:${ref}:${text}`);
    return { ref, target: 'To' };
  },
  async key(key) {
    calls.push(`key:${key}`);
  },
  async scroll(ref, direction, amount) {
    calls.push(`scroll:${ref ?? '-'}:${direction}:${amount}`);
  },
  async apps(): Promise<ComputerAppInfo[]> {
    return [
      { name: 'Mail', active: true, windows: ['Inbox'] },
      { name: 'Terminal', active: false, windows: ['shell'] },
    ];
  },
  async activate(app) {
    calls.push(`activate:${app}`);
  },
  async menu(app, path) {
    calls.push(`menu:${app}:${path.join('>')}`);
  },
  async capture() {
    return PNG;
  },
};

const previousApps = process.env.MIMI_ALLOWED_APPS;
process.env.MIMI_ALLOWED_APPS = 'Mail';
setComputerAdapter(fake);
after(() => {
  setComputerAdapter(null);
  if (previousApps === undefined) delete process.env.MIMI_ALLOWED_APPS;
  else process.env.MIMI_ALLOWED_APPS = previousApps;
});

const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };
const tool = (name: string) => pcTools.find((candidate) => candidate.name === name)!;
const run = (name: string, input: unknown) => {
  const definition = tool(name);
  return definition.execute(definition.inputSchema.parse(input), context);
};
const parse = (text: string) => JSON.parse(text) as Record<string, any>;

test('computer_observe returns the recorded tree, refs and secure fields', async () => {
  const observed = parse(await run('computer_observe', { app: 'Mail' }));
  assert.equal(observed.activeApp, 'Mail');
  assert.equal(observed.nodes.find((node: any) => node.ref === 'c2').secure, true);
  assert.equal('value' in observed.nodes.find((node: any) => node.ref === 'c2'), false);
  assert.equal(observed.nodes.find((node: any) => node.ref === 'c1').value, 'alice@example.com');
});

test('computer_click and computer_type work on non-secure refs', async () => {
  const clicked = parse(await run('computer_click', { ref: 'c0' }));
  assert.equal(clicked.ok, true);
  assert.equal(calls.includes('click:c0'), true);
  const typed = parse(await run('computer_type', { ref: 'c1', text: 'hello' }));
  assert.equal(typed.ok, true);
  assert.equal(calls.includes('type:c1:hello'), true);
});

test('computer_type refuses a secure field before touching the keyboard', async () => {
  calls.length = 0;
  await assert.rejects(run('computer_type', { ref: 'c2', text: 'secret' }), /secure field/);
  assert.equal(calls.some((call) => call.startsWith('type:')), false);
});

test('the app allowlist blocks an app that is not configured', async () => {
  await assert.rejects(run('computer_observe', { app: 'Terminal' }), /not in the computer allowlist/);
  await assert.rejects(run('computer_click', { ref: 'c0', app: 'Terminal' }), /not in the computer allowlist/);
  const listed = parse(await run('computer_app', { action: 'list' }));
  assert.equal(listed.apps.some((app: any) => app.name === 'Terminal'), true);
});

test('computer_wait finds visible text, and screenshot/highlight return chat files', async () => {
  const waited = parse(await run('computer_wait', { text: 'Welcome', timeout_ms: 1000, poll_ms: 100 }));
  assert.equal(waited.activeApp, 'Mail');
  const shot = await run('computer_screenshot', {});
  const file = parseToolFile(shot);
  assert.equal(file?.mime, 'image/png');
  assert.ok((file?.data.length ?? 0) > 0);
  const highlighted = await run('computer_highlight', { ref: 'c0' });
  assert.equal(parseToolFile(highlighted)?.mime, 'image/png');
});

test('computer_app activates an allowed app and computer_menu records the path', async () => {
  const activated = parse(await run('computer_app', { action: 'activate', app: 'Mail' }));
  assert.equal(activated.ok, true);
  assert.equal(calls.includes('activate:Mail'), true);
  const menu = parse(await run('computer_menu', { app: 'Mail', path: ['File', 'New Message'] }));
  assert.equal(menu.ok, true);
  assert.equal(calls.includes('menu:Mail:File>New Message'), true);
});
