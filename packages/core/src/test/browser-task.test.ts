import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  BrowserSession,
  browserTools,
  type CdpClient,
  formatSnapshot,
  setBrowserSession,
} from '@mimi/pc-agent';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-browser-task-')));
after(() => {
  setBrowserSession(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeCdp(overrides: { snapshot?: Record<string, unknown>; handoff?: Record<string, unknown> } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const snapshot = {
    url: 'https://example.com/',
    title: 'Example',
    text: 'Ready now',
    truncated: false,
    items: [{ ref: 'e1', tag: 'input', type: 'file', name: 'Choose file' }],
    scroll: { y: 0, height: 1000, view: 700 },
    ...(overrides.handoff ? { handoff: overrides.handoff } : {}),
    ...overrides.snapshot,
  };
  const cdp: CdpClient = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 't1', type: 'page', title: 'Example', url: 'https://example.com/' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 's1' };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes('document.readyState')) return { result: { value: 'complete' } };
        if (expression.includes('scrollIntoView')) return { result: { value: { x: 10, y: 20, tag: 'input', type: 'file', name: 'Choose file' } } };
        if (expression.includes("document.querySelectorAll('[data-mimi-ref]')")) return { result: { value: JSON.stringify(snapshot) } };
        if (expression.includes('Boolean(document.querySelector')) return { result: { value: true } };
        if (expression.includes('location.href')) return { result: { value: { url: snapshot.url, title: snapshot.title } } };
        return { result: { value: undefined } };
      }
      return {};
    },
    close() {},
    onClose() {},
  };
  return { cdp, calls };
}

function fakeSession(options: { handoff?: Record<string, unknown> } = {}) {
  const fake = fakeCdp({ handoff: options.handoff });
  const session = new BrowserSession({
    connect: async () => fake.cdp,
    start: async () => 'x',
    existing: () => undefined,
    sleep: async () => {},
  });
  return { session, calls: fake.calls };
}

test('browser session uploads files through a file input and waits for text', async () => {
  const { session, calls } = fakeSession();
  const file = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(file, 'x');
  const uploaded = await session.upload('e1', [file]);
  assert.equal(uploaded.files, 1);
  const setFiles = calls.find((call) => call.method === 'DOM.setFileInputFiles');
  assert.deepEqual(setFiles?.params.files, [file]);
  assert.equal(calls.some((call) => call.method === 'DOM.enable'), true);

  const waited = await session.waitFor({ text: 'Ready now', timeoutMs: 1000, pollMs: 10 });
  assert.equal(waited.title, 'Example');
  const focused = await session.focus('e1');
  assert.match(focused.target, /input/);
});

test('snapshots flag a login, OTP or CAPTCHA handoff', () => {
  const snapshot = {
    url: 'https://example.com/login',
    title: 'Sign in',
    text: 'Use your password',
    truncated: false,
    items: [{ ref: 'e1', tag: 'input', type: 'password', name: 'Password' }],
    scroll: { y: 0, height: 700, view: 700 },
    handoff: { kind: 'login', detail: 'The page asks for a password. The user must sign in in the browser window.' },
  } as never;
  const text = formatSnapshot(snapshot);
  assert.match(text, /Handoff: .*password/);
  assert.match(text, /Do not try to bypass/);
});

test('browser_upload tool refuses to upload while the page asks for the user', async () => {
  const { session } = fakeSession();
  setBrowserSession(session);
  const file = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(file, 'x');
  const upload: any = browserTools.find((tool) => tool.name === 'browser_upload')!;
  const input = upload.inputSchema.parse({ ref: 'e1', paths: [file] });
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [tmp] };
  const answer = await upload.execute(input, context);
  assert.match(answer, /Uploaded 1 file/);
});

test('browser_upload returns a handoff and uploads nothing when a password field is present', async () => {
  const { session, calls } = fakeSession({ handoff: { kind: 'login', detail: 'The page asks for a password.' } });
  setBrowserSession(session);
  const file = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(file, 'x');
  const upload: any = browserTools.find((tool) => tool.name === 'browser_upload')!;
  const input = upload.inputSchema.parse({ ref: 'e1', paths: [file] });
  const answer = await upload.execute(input, { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [tmp] });
  assert.match(answer, /Handoff:/);
  assert.equal(calls.some((call) => call.method === 'DOM.setFileInputFiles'), false);
});
