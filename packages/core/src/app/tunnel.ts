import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TunnelView } from '@mimi/shared';

/**
 * A one-click public address for a core on a computer: Cloudflare's quick tunnel
 * (`cloudflared tunnel --url http://127.0.0.1:<port>`) gives a random
 * https://<words>.trycloudflare.com that forwards to this core, so webhooks and
 * calendar push can reach it without opening a port on the router. The address
 * changes every start; no Cloudflare account is needed. cloudflared is not
 * bundled: it is found on PATH, in the usual install folders, or at MIMI_CLOUDFLARED.
 */

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/** How long cloudflared may take to print its address before the start counts as failed. */
const START_TIMEOUT_MS = 45_000;
/** Lines of cloudflared output kept for the error message. */
const KEEP_LINES = 6;

export interface QuickTunnelOptions {
  /** Local port of this core. */
  port: () => number;
  onChange?: (view: TunnelView) => void;
  /** Tests replace the binary search and the process. */
  find?: () => string | null;
  spawnFn?: typeof spawn;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
}

/** Where cloudflared may be installed, besides PATH. */
function candidates(env: NodeJS.ProcessEnv): string[] {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const list: string[] = [];
  if (env.MIMI_CLOUDFLARED) list.push(env.MIMI_CLOUDFLARED);
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) if (dir) list.push(path.join(dir, exe));
  if (process.platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (base) list.push(path.join(base, 'cloudflared', exe));
    if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
  } else {
    list.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared');
  }
  return list;
}

export function findCloudflared(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const file of candidates(env)) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return null;
}

/** How to get cloudflared on this system, for the settings screen. */
export function installHint(): string {
  if (process.platform === 'win32') return 'winget install --id Cloudflare.cloudflared';
  if (process.platform === 'darwin') return 'brew install cloudflared';
  return 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
}

export class QuickTunnel {
  private readonly options: QuickTunnelOptions;
  private child: ChildProcess | null = null;
  private view: TunnelView = { state: 'off' };
  private timer: NodeJS.Timeout | null = null;

  constructor(options: QuickTunnelOptions) {
    this.options = options;
  }

  status(): TunnelView {
    return { ...this.view };
  }

  /** The public https address while the tunnel is up. */
  url(): string | null {
    return this.view.state === 'on' ? (this.view.url ?? null) : null;
  }

  private set(view: TunnelView): void {
    this.view = view;
    this.options.onChange?.(this.status());
  }

  start(): TunnelView {
    if (this.child) return this.status();
    const env = this.options.env ?? process.env;
    const binary = (this.options.find ?? (() => findCloudflared(env)))();
    if (!binary) {
      this.set({ state: 'missing', hint: installHint() });
      return this.status();
    }
    const lines: string[] = [];
    const child = (this.options.spawnFn ?? spawn)(
      binary,
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.options.port()}`],
      // No shell and no secrets: cloudflared gets only what it needs to run.
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { PATH: env.PATH ?? env.Path ?? '', HOME: env.HOME ?? '', USERPROFILE: env.USERPROFILE ?? '', SystemRoot: env.SystemRoot ?? '' } },
    );
    this.child = child;
    this.set({ state: 'starting' });
    const read = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        lines.push(line.trim());
        if (lines.length > KEEP_LINES) lines.shift();
        const found = URL_PATTERN.exec(line);
        if (found && this.child === child && this.view.state === 'starting') {
          this.clearTimer();
          this.set({ state: 'on', url: found[0], since: new Date().toISOString() });
        }
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimer();
      this.set({ state: 'error', error: error.message });
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.clearTimer();
      this.set(code === 0 || this.view.state === 'off' ? { state: 'off' } : { state: 'error', error: `cloudflared stopped (${code ?? 'signal'}): ${lines.slice(-2).join(' · ')}` });
    });
    this.timer = setTimeout(() => {
      if (this.child !== child || this.view.state !== 'starting') return;
      this.stopChild();
      this.set({ state: 'error', error: `no address from cloudflared after ${Math.round((this.options.startTimeoutMs ?? START_TIMEOUT_MS) / 1000)} s: ${lines.slice(-2).join(' · ')}` });
    }, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
    this.timer.unref?.();
    return this.status();
  }

  stop(): TunnelView {
    this.clearTimer();
    this.stopChild();
    this.set({ state: 'off' });
    return this.status();
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
