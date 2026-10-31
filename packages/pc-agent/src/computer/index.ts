import { MacComputerAdapter } from './macos.ts';
import type { ComputerAdapter, ComputerNode, ComputerSnapshot } from './types.ts';
import { WindowsComputerAdapter } from './windows.ts';

export type { ComputerAdapter, ComputerAppInfo, ComputerBounds, ComputerNode, ComputerSnapshot, ComputerWindow } from './types.ts';
export { nodeRef } from './types.ts';

let shared: ComputerAdapter | null = null;

/** The platform adapter; a test may replace it with a recorded one. */
export function computerAdapter(): ComputerAdapter {
  if (shared) return shared;
  if (process.platform === 'win32') shared = new WindowsComputerAdapter();
  else if (process.platform === 'darwin') shared = new MacComputerAdapter();
  else throw new Error('Native computer control is available on macOS and Windows only.');
  return shared;
}

/** Replaces the adapter (tests use a recorded tree); null restores the platform adapter. */
export function setComputerAdapter(adapter: ComputerAdapter | null): void {
  shared = adapter;
}

/**
 * Apps the computer tools may touch. MIMI_ALLOWED_APPS is a semicolon list;
 * `*` allows everything. Empty means no app is allowed (safe default).
 */
export function allowedComputerApps(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MIMI_ALLOWED_APPS ?? '')
    .split(';')
    .map((name) => name.trim())
    .filter(Boolean);
}

function matches(app: string, allowed: string): boolean {
  return app.toLowerCase() === allowed.toLowerCase() || app.toLowerCase().includes(allowed.toLowerCase());
}

export function assertComputerApp(app: string, allowed = allowedComputerApps()): void {
  if (allowed.includes('*')) return;
  if (!app.trim()) throw new Error('An app name is required.');
  if (!allowed.some((name) => matches(app, name))) {
    throw new Error(`App "${app}" is not in the computer allowlist (MIMI_ALLOWED_APPS): ${allowed.join('; ') || 'none configured'}.`);
  }
}

export function assertActiveApp(snapshot: ComputerSnapshot, app?: string, allowed = allowedComputerApps()): void {
  assertComputerApp(app ?? snapshot.activeApp, allowed);
  if (app && !matches(snapshot.activeApp, app) && !matches(app, snapshot.activeApp)) {
    throw new Error(`"${app}" is not the active app (${snapshot.activeApp || 'unknown'}). Activate it with computer_app first.`);
  }
}

export function flattenComputerNodes(nodes: ComputerNode[], out: ComputerNode[] = []): ComputerNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.children) flattenComputerNodes(node.children, out);
  }
  return out;
}

export function findComputerNode(nodes: ComputerNode[], ref: string): ComputerNode | undefined {
  return flattenComputerNodes(nodes).find((node) => node.ref === ref);
}

export function computerSnapshotView(snapshot: ComputerSnapshot): Record<string, unknown> {
  return {
    platform: snapshot.platform,
    activeApp: snapshot.activeApp,
    windows: snapshot.windows,
    capturedAt: snapshot.capturedAt,
    nodes: flattenComputerNodes(snapshot.nodes).map((node) => ({
      ref: node.ref,
      role: node.role,
      name: node.name,
      ...(node.value ? { value: node.value } : {}),
      ...(node.bounds ? { bounds: node.bounds } : {}),
      ...(node.focused ? { focused: true } : {}),
      ...(node.secure ? { secure: true } : {}),
      ...(node.disabled ? { disabled: true } : {}),
    })),
  };
}


