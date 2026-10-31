import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defineTool, toolFileOutput } from '@mimi/shared';
import { z } from 'zod';
import {
  assertActiveApp,
  assertComputerApp,
  computerAdapter,
  computerSnapshotView,
  findComputerNode,
  flattenComputerNodes,
  type ComputerSnapshot,
} from '../computer/index.ts';
import { runProcess, sanitizedEnv } from '../process.ts';

const COMPUTER_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;

const NOTE =
  'Native UI control is a fallback for apps without an API. Use refs from the latest observation; never type passwords, OTPs or secrets, and never bypass a secure field. The app must be in MIMI_ALLOWED_APPS.';

async function observeFor(app?: string, depth = 4): Promise<ComputerSnapshot> {
  const snapshot = await computerAdapter().observe({ ...(app ? { app } : {}), depth });
  assertComputerApp(app ?? snapshot.activeApp);
  return snapshot;
}

function find(snapshot: ComputerSnapshot, ref: string) {
  const node = findComputerNode(snapshot.nodes, ref);
  if (!node) throw new Error(`No element ${ref} in the latest observation. Re-observe; refs change when the UI does.`);
  if (node.disabled) throw new Error(`${ref} is disabled.`);
  return node;
}

async function after(app?: string): Promise<Record<string, unknown>> {
  const snapshot = await observeFor(app);
  return computerSnapshotView(snapshot);
}

async function annotate(buffer: Buffer, box: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mimi-highlight-'));
  const source = path.join(dir, 'in.png');
  const target = path.join(dir, 'out.png');
  try {
    await fs.writeFile(source, buffer);
    const filter = `drawbox=x=${Math.max(0, box.x)}:y=${Math.max(0, box.y)}:w=${Math.max(2, box.width)}:h=${Math.max(2, box.height)}:color=red@0.75:t=4`;
    const result = await runProcess('ffmpeg', ['-v', 'error', '-i', source, '-vf', filter, '-y', target], {
      cwd: dir,
      env: sanitizedEnv(),
      timeoutMs: 30_000,
      maxOutput: 1024 * 1024,
    });
    return result.exitCode === 0 ? await fs.readFile(target) : buffer;
  } catch {
    return buffer;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const computerObserveTool = defineTool({
  name: 'computer_observe',
  description: `Read the accessibility tree of an app on the user's screen (role, name, value, bounds, focused, secure) and give each element a ref for computer_click/computer_type. ${NOTE}`,
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    app: z.string().optional().describe('App name; defaults to the active app'),
    depth: z.number().int().min(1).max(12).optional(),
  }),
  summarize: (input) => `Observe ${input.app ?? 'the active app'}`,
  async execute(input) {
    const snapshot = await observeFor(input.app, input.depth ?? 4);
    return JSON.stringify({ ok: true, ...computerSnapshotView(snapshot) }, null, 2);
  },
});

export const computerClickTool = defineTool({
  name: 'computer_click',
  description: `Click an element by its ref from the latest computer_observe. The app must already be active. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    ref: z.string().min(2),
    app: z.string().optional().describe('Expected active app'),
  }),
  summarize: (input) => `Click ${input.ref}${input.app ? ` in ${input.app}` : ''}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    assertActiveApp(snapshot, input.app);
    find(snapshot, input.ref);
    const result = await computerAdapter().click(input.ref);
    return JSON.stringify({ ok: true, target: result.target, snapshot: await after(input.app) }, null, 2);
  },
});

export const computerTypeTool = defineTool({
  name: 'computer_type',
  description: `Type into a non-secure field by ref. Secure/password fields are refused: the user types those. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    ref: z.string().min(2),
    text: z.string().min(1).max(4000),
    app: z.string().optional(),
  }),
  summarize: (input) => `Type into ${input.ref}${input.app ? ` in ${input.app}` : ''}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    assertActiveApp(snapshot, input.app);
    const node = find(snapshot, input.ref);
    if (node.secure) throw new Error('That is a secure field. The user must type the password or OTP themselves.');
    await computerAdapter().type(input.ref, input.text);
    return JSON.stringify({ ok: true, ref: input.ref, snapshot: await after(input.app) }, null, 2);
  },
});

export const computerKeyTool = defineTool({
  name: 'computer_key',
  description: `Press one key in the active app. Keys: ${COMPUTER_KEYS.join(', ')}. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({ key: z.enum(COMPUTER_KEYS), app: z.string().optional() }),
  summarize: (input) => `Press ${input.key}${input.app ? ` in ${input.app}` : ''}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    assertActiveApp(snapshot, input.app);
    await computerAdapter().key(input.key);
    return JSON.stringify({ ok: true, snapshot: await after(input.app) }, null, 2);
  },
});

export const computerScrollTool = defineTool({
  name: 'computer_scroll',
  description: `Scroll an element (or the active app) up or down. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    ref: z.string().optional(),
    direction: z.enum(['up', 'down']),
    amount: z.number().int().min(1).max(10).optional(),
    app: z.string().optional(),
  }),
  summarize: (input) => `Scroll ${input.direction}${input.ref ? ` ${input.ref}` : ''}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    assertActiveApp(snapshot, input.app);
    if (input.ref) find(snapshot, input.ref);
    await computerAdapter().scroll(input.ref, input.direction, input.amount ?? 3);
    return JSON.stringify({ ok: true, snapshot: await after(input.app) }, null, 2);
  },
});

export const computerAppTool = defineTool({
  name: 'computer_app',
  description: `List running apps or activate an app. Activation requires the app to be in MIMI_ALLOWED_APPS. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    action: z.enum(['list', 'activate']),
    app: z.string().optional(),
  }),
  summarize: (input) => `App ${input.action}${input.app ? ` ${input.app}` : ''}`,
  async execute(input) {
    if (input.action === 'list') {
      const apps = await computerAdapter().apps();
      return JSON.stringify({ ok: true, apps }, null, 2);
    }
    if (!input.app) throw new Error('Give the app to activate.');
    assertComputerApp(input.app);
    await computerAdapter().activate(input.app);
    return JSON.stringify({ ok: true, app: input.app, snapshot: await after(input.app) }, null, 2);
  },
});

export const computerMenuTool = defineTool({
  name: 'computer_menu',
  description: `Choose a menu item by its path, e.g. ["File","Save"]. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    app: z.string().min(1),
    path: z.array(z.string().min(1)).min(1).max(6),
  }),
  summarize: (input) => `Menu ${input.app}: ${input.path.join(' > ')}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    assertActiveApp(snapshot, input.app);
    await computerAdapter().menu(input.app, input.path);
    return JSON.stringify({ ok: true, snapshot: await after(input.app) }, null, 2);
  },
});

export const computerWaitTool = defineTool({
  name: 'computer_wait',
  description: `Wait until a ref or visible text appears in an app, then return the observation. ${NOTE}`,
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    app: z.string().optional(),
    ref: z.string().optional(),
    text: z.string().optional(),
    timeout_ms: z.number().int().min(250).max(120_000).optional(),
    poll_ms: z.number().int().min(100).max(5_000).optional(),
  }),
  summarize: (input) => `Wait for ${input.ref ?? input.text ?? 'the app'}`,
  async execute(input) {
    if (!input.ref && !input.text) throw new Error('Give a ref or text to wait for.');
    const timeout = input.timeout_ms ?? 20_000;
    const poll = input.poll_ms ?? 500;
    const deadline = Date.now() + timeout;
    while (true) {
      const snapshot = await observeFor(input.app);
      const nodes = flattenComputerNodes(snapshot.nodes);
      const found = (input.ref && nodes.some((node) => node.ref === input.ref)) ||
        (input.text && nodes.some((node) => node.name.includes(input.text!) || node.value?.includes(input.text!)));
      if (found) return JSON.stringify({ ok: true, ...computerSnapshotView(snapshot) }, null, 2);
      if (Date.now() >= deadline) throw new Error(`Waited ${Math.round(timeout / 1000)}s for ${input.ref ?? input.text}; it did not appear.`);
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  },
});

export const computerScreenshotTool = defineTool({
  name: 'computer_screenshot',
  description: `Take a picture of the screen (the user sees it in the chat). Optionally draw a red box around a ref. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    app: z.string().optional(),
    ref: z.string().optional().describe('Draw a red rectangle around this element'),
  }),
  summarize: (input) => `Screenshot${input.ref ? ` highlighting ${input.ref}` : ''}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    let buffer = await computerAdapter().capture();
    if (input.ref) {
      const node = find(snapshot, input.ref);
      if (node.bounds) buffer = await annotate(buffer, node.bounds);
    }
    return toolFileOutput({ name: `computer-${Date.now()}.png`, mime: 'image/png', data: buffer.toString('base64') });
  },
});

export const computerHighlightTool = defineTool({
  name: 'computer_highlight',
  description: `Capture the screen with a red box around an element, so the user can see what Mimi means. ${NOTE}`,
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({ ref: z.string().min(2), app: z.string().optional() }),
  summarize: (input) => `Highlight ${input.ref}`,
  async execute(input) {
    const snapshot = await observeFor(input.app);
    const node = find(snapshot, input.ref);
    const buffer = await computerAdapter().capture();
    const annotated = node.bounds ? await annotate(buffer, node.bounds) : buffer;
    return toolFileOutput({ name: `highlight-${Date.now()}.png`, mime: 'image/png', data: annotated.toString('base64') });
  },
});

export const computerTools = [
  computerObserveTool,
  computerClickTool,
  computerTypeTool,
  computerKeyTool,
  computerScrollTool,
  computerAppTool,
  computerMenuTool,
  computerWaitTool,
  computerScreenshotTool,
  computerHighlightTool,
];
