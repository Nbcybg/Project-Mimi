import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ComputerAdapter,
  ComputerAppInfo,
  ComputerNode,
  ComputerSnapshot,
} from './types.ts';
import { nodeRef } from './types.ts';
import { runProcess, sanitizedEnv } from '../process.ts';

const KEY_CODES: Record<string, number> = {
  Enter: 36,
  Tab: 48,
  Escape: 53,
  Backspace: 51,
  Delete: 117,
  Space: 49,
  ArrowUp: 126,
  ArrowDown: 125,
  ArrowLeft: 123,
  ArrowRight: 124,
  PageUp: 116,
  PageDown: 121,
  Home: 115,
  End: 119,
};

const JXA = String.raw`
function run(argv) {
  const req = JSON.parse((argv && argv[0]) || '{}');
  const se = Application('System Events');
  const processes = se.processes();
  const front = processes.find((p) => { try { return p.frontmost(); } catch (e) { return false; } });
  const activeApp = front ? front.name() : '';
  const windows = [];
  for (const p of processes) {
    let names = [];
    try { names = p.windows().map((w) => w.name()); } catch (e) { names = []; }
    for (const title of names) windows.push({ app: p.name(), title: title || '', active: p === front });
  }
  let proc = front;
  if (req.app) {
    const wanted = String(req.app).toLowerCase();
    proc = processes.find((p) => p.name().toLowerCase() === wanted) ||
      processes.find((p) => p.name().toLowerCase().includes(wanted)) || null;
    if (!proc) throw new Error('No process "' + req.app + '".');
  }
  if (!proc) throw new Error('No frontmost process.');

  function bounds(el) {
    try {
      const p = el.position();
      const s = el.size();
      if (!p || !s) return null;
      return { x: p[0], y: p[1], width: s[0], height: s[1] };
    } catch (e) { return null; }
  }
  function ref(path) { return path.length === 0 ? 'c' : 'c' + path.join('.'); }
  function node(el, p, depth) {
    if (!el) return null;
    let role = '';
    let name = '';
    let value = '';
    let secure = false;
    let focused = false;
    let enabled = true;
    try { role = el.role() || ''; } catch (e) {}
    secure = role === 'AXSecureTextField';
    try { name = el.name() || ''; } catch (e) {}
    if (!secure) { try { value = String(el.value() ?? ''); } catch (e) { value = ''; } }
    try { focused = Boolean(el.focused()); } catch (e) {}
    try { enabled = Boolean(el.enabled()); } catch (e) {}
    const n = { ref: ref(p), role, name, secure, focused, disabled: !enabled };
    if (value) n.value = value.slice(0, 300);
    const b = bounds(el);
    if (b) n.bounds = b;
    if (p.length < (req.depth || 4)) {
      let children = [];
      try { children = el.uiElements(); } catch (e) { children = []; }
      const built = [];
      for (let i = 0; i < children.length && i < 200; i++) {
        const child = node(children[i], p.concat([i]), depth + 1);
        if (child) built.push(child);
      }
      if (built.length) n.children = built;
    }
    return n;
  }

  function elementAt(root, r) {
    const text = String(r || '');
    if (!text.startsWith('c')) throw new Error('Bad ref ' + text);
    const rest = text.slice(1);
    let el = root;
    if (rest) {
      for (const part of rest.split('.')) {
        const children = el.uiElements();
        const at = Number(part);
        if (!Number.isInteger(at) || !children[at]) throw new Error('No element ' + text);
        el = children[at];
      }
    }
    return el;
  }

  if (req.action === 'observe') {
    const win = proc.windows[0];
    if (!win) throw new Error('The app has no window.');
    return JSON.stringify({ platform: 'darwin', activeApp, windows, nodes: [node(win, [], 0)], capturedAt: new Date().toISOString() });
  }
  if (req.action === 'click') {
    const win = proc.windows[0];
    if (!win) throw new Error('The app has no window.');
    const el = elementAt(win, req.ref);
    try {
      const action = el.actions.byName('AXPress');
      if (action) action.perform();
      else el.click();
    } catch (e) {
      el.click();
    }
    return JSON.stringify({ ref: req.ref, target: (() => { try { return el.name() || req.ref; } catch (e) { return req.ref; } })() });
  }
  if (req.action === 'type') {
    const win = proc.windows[0];
    if (!win) throw new Error('The app has no window.');
    const el = elementAt(win, req.ref);
    let role = '';
    try { role = el.role() || ''; } catch (e) {}
    if (role === 'AXSecureTextField') throw new Error('This is a secure field. The user must type the password or OTP themselves.');
    proc.frontmost = true;
    el.focus();
    try { el.value = String(req.text ?? ''); } catch (e) { se.keystroke(String(req.text ?? '')); }
    return JSON.stringify({ ref: req.ref, target: (() => { try { return el.name() || req.ref; } catch (e) { return req.ref; } })() });
  }
  if (req.action === 'key') {
    se.keyCode(Number(req.code));
    return JSON.stringify({ ok: true });
  }
  if (req.action === 'scroll') {
    se.keyCode(req.direction > 0 ? 116 : 121);
    return JSON.stringify({ ok: true });
  }
  if (req.action === 'apps') {
    const items = processes.map((p) => {
      let titles = [];
      try { titles = p.windows().map((w) => w.name()); } catch (e) { titles = []; }
      return { name: p.name(), active: Boolean(p.frontmost()), windows: titles };
    });
    return JSON.stringify(items);
  }
  if (req.action === 'activate') {
    proc.frontmost = true;
    return JSON.stringify({ ok: true });
  }
  if (req.action === 'menu') {
    const bar = proc.menuBars[0];
    let item = bar;
    for (const part of req.path || []) item = item.menuItems.byName(part);
    item.click();
    return JSON.stringify({ ok: true });
  }
  throw new Error('Unknown action ' + req.action);
}
`;

async function runApple(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const result = await runProcess('osascript', ['-l', 'JavaScript', '-e', JXA, '--', JSON.stringify({ action, ...input })], {
    cwd: process.cwd(),
    env: sanitizedEnv(),
    timeoutMs: 60_000,
    maxOutput: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(result.output.trim() || `osascript exited with ${result.exitCode}`);
  const text = result.output.trim();
  if (!text) throw new Error('The macOS accessibility helper returned nothing.');
  return JSON.parse(text);
}

/** macOS System Events (Accessibility + Automation permissions) and screencapture. */
export class MacComputerAdapter implements ComputerAdapter {
  private lastApp: string | undefined;

  async observe(options: { app?: string; depth?: number }): Promise<ComputerSnapshot> {
    this.lastApp = options.app;
    return (await runApple('observe', { ...(options.app ? { app: options.app } : {}), depth: options.depth ?? 4 })) as ComputerSnapshot;
  }

  async click(ref: string): Promise<{ ref: string; target: string }> {
    const data = (await runApple('click', { ref, ...(this.lastApp ? { app: this.lastApp } : {}) })) as Record<string, unknown>;
    return { ref, target: String(data.target ?? ref) };
  }

  async type(ref: string, text: string): Promise<{ ref: string; target: string }> {
    const data = (await runApple('type', { ref, text, ...(this.lastApp ? { app: this.lastApp } : {}) })) as Record<string, unknown>;
    return { ref, target: String(data.target ?? ref) };
  }

  async key(key: string): Promise<void> {
    const code = KEY_CODES[key];
    if (!code) throw new Error(`Unsupported key "${key}". Use ${Object.keys(KEY_CODES).join(', ')}.`);
    await runApple('key', { code });
  }

  async scroll(ref: string | undefined, direction: 'up' | 'down', amount: number): Promise<void> {
    void ref;
    void amount;
    await runApple('scroll', { direction: direction === 'up' ? -1 : 1 });
  }

  async apps(): Promise<ComputerAppInfo[]> {
    return (await runApple('apps')) as ComputerAppInfo[];
  }

  async activate(app: string): Promise<void> {
    await runApple('activate', { app });
    this.lastApp = app;
  }

  async menu(app: string, path: string[]): Promise<void> {
    await runApple('menu', { app, path });
    this.lastApp = app;
  }

  async capture(): Promise<Buffer> {
    const file = path.join(os.tmpdir(), `mimi-screen-${process.pid}-${Date.now()}.png`);
    try {
      const result = await runProcess('screencapture', ['-x', file], {
        cwd: os.tmpdir(),
        env: sanitizedEnv(),
        timeoutMs: 30_000,
        maxOutput: 1024 * 1024,
      });
      if (result.exitCode !== 0) throw new Error(result.output.trim() || 'screencapture failed');
      return await fs.readFile(file);
    } finally {
      await fs.rm(file, { force: true });
    }
  }
}

export const MAC_KEY_NAMES = Object.keys(KEY_CODES);
