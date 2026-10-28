import type { CdpClient } from './cdp.ts';

const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_MS = 700;
const REF = /^e\d+$/;

/** True for addresses on this computer or the local network. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(name)) return true;
  if (name.includes(':')) return name === '::1' || name === '::' || /^(fe[89ab]|f[cd])/.test(name) || name.startsWith('::ffff:');
  const parts = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!parts) return false;
  const [a, b] = [Number(parts[1]), Number(parts[2])];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** The addresses the browser may open: http(s) on the internet, unless local ones are allowed on purpose. */
export function checkUrl(raw: string, allowLocal = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) addresses can be opened.');
  if (!allowLocal && isLocalHost(url.hostname)) {
    throw new Error(`"${url.hostname}" is on this computer or the local network; the assistant's browser does not open those.`);
  }
  return url;
}

export interface BrowserDeps {
  connect(url: string): Promise<CdpClient>;
  /** Starts the browser and returns its DevTools address. */
  start(): Promise<string>;
  /** The address of a browser that is already running with the assistant's profile. */
  existing(): string | undefined;
  allowLocal?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface PageItem {
  ref: string;
  tag: string;
  type?: string;
  role?: string;
  name: string;
  value?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  items: PageItem[];
  scroll: { y: number; height: number; view: number };
}

export interface TabInfo {
  index: number;
  title: string;
  url: string;
  active: boolean;
}

/** Finds the page's interactive elements, tags them with refs and reads the visible text. */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_ITEMS = 120, MAX_TEXT = 6000;
  document.querySelectorAll('[data-mimi-ref]').forEach((el) => el.removeAttribute('data-mimi-ref'));
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const selector = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=option],[onclick],[contenteditable=""],[contenteditable=true]';
  const items = [];
  for (const el of document.querySelectorAll(selector)) {
    if (items.length >= MAX_ITEMS) break;
    if (!shown(el) || (el.tagName === 'INPUT' && el.type === 'hidden')) continue;
    const ref = 'e' + (items.length + 1);
    el.setAttribute('data-mimi-ref', ref);
    const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
    const name = (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    items.push({
      ref, tag: el.tagName.toLowerCase(), type: el.type || undefined, role: el.getAttribute('role') || undefined, name,
      value: field && el.type !== 'password' && el.type !== 'checkbox' && el.type !== 'radio' ? String(el.value || '').slice(0, 80) : undefined,
      href: el.href ? String(el.href).slice(0, 140) : undefined,
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
      disabled: el.disabled || undefined,
    });
  }
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return JSON.stringify({
    url: location.href, title: document.title, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, items,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight },
  });
})()`;

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};
export const KEY_NAMES = Object.keys(KEYS);

interface Current {
  targetId: string;
  sessionId: string;
}

/**
 * One browser the assistant drives: its own profile, one tab at a time ("current").
 * Calls are queued, so two agents never click at the same time.
 */
export class BrowserSession {
  private readonly deps: BrowserDeps;
  private cdp: CdpClient | null = null;
  private current: Current | null = null;
  private readonly sessions = new Map<string, string>();
  private order: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: BrowserDeps) {
    this.deps = deps;
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(ms);
  }

  /** Runs `job` after every earlier call has finished. */
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  private async client(): Promise<CdpClient> {
    if (this.cdp) return this.cdp;
    let cdp: CdpClient | null = null;
    const address = this.deps.existing();
    if (address) {
      try {
        cdp = await this.deps.connect(address);
      } catch {
        cdp = null; // a leftover file: start a fresh browser
      }
    }
    if (!cdp) cdp = await this.deps.connect(await this.deps.start());
    this.cdp = cdp;
    cdp.onClose(() => {
      if (this.cdp === cdp) this.reset();
    });
    // Nothing downloads by itself: a download is a decision for the user.
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    return cdp;
  }

  private reset(): void {
    this.cdp = null;
    this.current = null;
    this.sessions.clear();
    this.order = [];
  }

  private async pages(): Promise<Array<{ targetId: string; title: string; url: string }>> {
    const cdp = await this.client();
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string; type: string; title: string; url: string }> };
    // The browser's own pages (sync prompts, devtools, extensions) are not tabs of the assistant.
    const pages = targetInfos.filter((info) => info.type === 'page' && !/^(edge|chrome|devtools|chrome-untrusted|chrome-extension|extension):\/\//.test(info.url));
    const alive = new Set(pages.map((page) => page.targetId));
    this.order = [...this.order.filter((id) => alive.has(id)), ...pages.map((page) => page.targetId).filter((id) => !this.order.includes(id))];
    for (const id of [...this.sessions.keys()]) if (!alive.has(id)) this.sessions.delete(id);
    return this.order.map((id) => pages.find((page) => page.targetId === id)!);
  }

  private async attach(targetId: string): Promise<Current> {
    const cdp = await this.client();
    let sessionId = this.sessions.get(targetId);
    if (!sessionId) {
      sessionId = ((await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }).sessionId;
      this.sessions.set(targetId, sessionId);
      await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    }
    this.current = { targetId, sessionId };
    return this.current;
  }

  private async page(): Promise<Current> {
    await this.client();
    if (this.current) return this.current;
    const pages = await this.pages();
    if (pages.length > 0) return this.attach(pages[0]!.targetId);
    const { targetId } = (await this.cdp!.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    await this.pages(); // so the new tab is known, and not mistaken for one a click opened
    return this.attach(targetId);
  }

  /** A command on the current tab; one retry if the tab was closed under us. */
  private async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const page = await this.page();
      try {
        return await this.cdp!.send(method, params, page.sessionId);
      } catch (error) {
        const message = (error as Error).message;
        if (attempt === 0 && /session|target|closed|not found|detached/i.test(message) && this.cdp) {
          this.sessions.delete(page.targetId);
          this.current = null;
          continue;
        }
        throw error;
      }
    }
  }

  private async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Page script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value as T;
  }

  private async waitLoaded(): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if ((await this.evaluate<string>('document.readyState')) === 'complete') return;
      } catch {
        // mid-navigation: the old page is gone, try again
      }
      await this.sleep(250);
    }
  }

  /** After a page change: a tab the click opened becomes the current one, and a bad address is left. */
  private async settle(): Promise<{ url: string; title: string; newTab: boolean }> {
    await this.sleep(SETTLE_MS);
    const known = new Set(this.order);
    const pages = await this.pages();
    const fresh = pages.find((page) => !known.has(page.targetId));
    if (fresh) await this.attach(fresh.targetId);
    await this.waitLoaded();
    const info = await this.evaluate<{ url: string; title: string }>('({ url: location.href, title: document.title })');
    if (info.url !== 'about:blank' && !info.url.startsWith('chrome-error://')) {
      try {
        checkUrl(info.url, this.deps.allowLocal);
      } catch (error) {
        await this.call('Page.navigate', { url: 'about:blank' });
        throw new Error(`The page went to ${info.url}, which was not allowed, so the tab was blanked. ${(error as Error).message}`);
      }
    }
    return { ...info, newTab: Boolean(fresh) };
  }

  async open(raw: string, newTab = false): Promise<{ url: string; title: string }> {
    const url = checkUrl(raw, this.deps.allowLocal);
    if (newTab) {
      await this.client();
      const { targetId } = (await this.cdp!.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
      await this.pages();
      await this.attach(targetId);
    }
    const result = (await this.call('Page.navigate', { url: url.toString() })) as { errorText?: string };
    if (result.errorText) throw new Error(`Could not open ${url.toString()}: ${result.errorText}`);
    const { url: finalUrl, title } = await this.settle();
    return { url: finalUrl, title };
  }

  async snapshot(): Promise<PageSnapshot> {
    return JSON.parse(await this.evaluate<string>(SNAPSHOT_SCRIPT)) as PageSnapshot;
  }

  private async find(ref: string): Promise<{ x: number; y: number; tag: string; type: string; name: string }> {
    if (!REF.test(ref)) throw new Error(`"${ref}" is not an element ref like e12.`);
    const found = await this.evaluate<{ x: number; y: number; tag: string; type: string; name: string } | null>(`(() => {
      const el = document.querySelector('[data-mimi-ref="${ref}"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), type: el.type || '', name: (el.getAttribute('aria-label') || el.innerText || el.value || '').slice(0, 60) };
    })()`);
    if (!found) throw new Error(`No element ${ref} on the page now. Take a new snapshot; refs change when the page does.`);
    return found;
  }

  async click(ref: string): Promise<{ url: string; title: string; newTab: boolean; target: string }> {
    const target = await this.find(ref);
    for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]] as const) {
      await this.call('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, ...extra });
    }
    return { ...(await this.settle()), target: `${target.tag}${target.name ? ` "${target.name}"` : ''}` };
  }

  async type(ref: string, text: string, options: { clear?: boolean; submit?: boolean } = {}): Promise<{ url: string; title: string; newTab: boolean }> {
    const target = await this.find(ref);
    if (target.type === 'password') throw new Error('That is a password field. The user types passwords themselves in the browser window.');
    await this.evaluate(`(() => {
      const el = document.querySelector('[data-mimi-ref="${ref}"]');
      el.focus();
      if (${options.clear !== false}) {
        if (el.select) el.select();
        else document.execCommand('selectAll');
      } else if (el.setSelectionRange && typeof el.value === 'string') {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      }
    })()`);
    await this.call('Input.insertText', { text });
    if (options.submit) await this.pressKey('Enter');
    return this.settle();
  }

  async select(ref: string, value: string): Promise<{ url: string; title: string; newTab: boolean }> {
    await this.find(ref);
    const ok = await this.evaluate<boolean>(`(() => {
      const el = document.querySelector('[data-mimi-ref="${ref}"]');
      if (!el || el.tagName !== 'SELECT') return false;
      const wanted = ${JSON.stringify(value)};
      const option = [...el.options].find((o) => o.value === wanted || o.text.trim() === wanted);
      if (!option) return false;
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`${ref} is not a drop-down with an option "${value}".`);
    return this.settle();
  }

  private async pressKey(name: string): Promise<void> {
    const key = KEYS[name];
    if (!key) throw new Error(`Unknown key "${name}". Use one of: ${KEY_NAMES.join(', ')}.`);
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk };
    await this.call('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text } : {}) });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async press(name: string): Promise<{ url: string; title: string; newTab: boolean }> {
    await this.pressKey(name);
    return this.settle();
  }

  async scroll(direction: 'up' | 'down', pixels?: number): Promise<{ y: number; height: number; view: number }> {
    const sign = direction === 'up' ? -1 : 1;
    return this.evaluate(`(() => {
      window.scrollBy(0, ${sign} * (${pixels ?? 0} || Math.round(innerHeight * 0.8)));
      return { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight };
    })()`);
  }

  async screenshot(fullPage = false, options: { format?: 'png' | 'jpeg'; quality?: number } = {}): Promise<Buffer> {
    const format = options.format ?? 'png';
    const params = { format, captureBeyondViewport: fullPage, ...(format === 'jpeg' ? { quality: options.quality ?? 80 } : {}) };
    const { data } = (await this.call('Page.captureScreenshot', params)) as { data: string };
    return Buffer.from(data, 'base64');
  }

  async history(direction: 'back' | 'forward' | 'reload'): Promise<{ url: string; title: string }> {
    if (direction === 'reload') {
      await this.call('Page.reload');
    } else {
      const history = (await this.call('Page.getNavigationHistory')) as { currentIndex: number; entries: Array<{ id: number }> };
      const entry = history.entries[history.currentIndex + (direction === 'back' ? -1 : 1)];
      if (!entry) throw new Error(`There is nothing to go ${direction} to.`);
      await this.call('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    const { url, title } = await this.settle();
    return { url, title };
  }

  async tabs(): Promise<TabInfo[]> {
    await this.page();
    const pages = await this.pages();
    return pages.map((page, index) => ({ index: index + 1, title: page.title, url: page.url, active: page.targetId === this.current?.targetId }));
  }

  private async tabAt(index: number): Promise<string> {
    const pages = await this.pages();
    const page = pages[index - 1];
    if (!page) throw new Error(`There is no tab ${index}; there are ${pages.length}.`);
    return page.targetId;
  }

  async switchTab(index: number): Promise<void> {
    await this.page();
    const targetId = await this.tabAt(index);
    await this.cdp!.send('Target.activateTarget', { targetId });
    await this.attach(targetId);
  }

  async closeTab(index: number): Promise<void> {
    await this.page();
    const targetId = await this.tabAt(index);
    await this.cdp!.send('Target.closeTarget', { targetId });
    if (this.current?.targetId === targetId) this.current = null;
    this.sessions.delete(targetId);
    await this.pages();
  }

  async close(): Promise<void> {
    if (this.cdp) {
      await this.cdp.send('Browser.close').catch(() => {});
      this.cdp.close();
    }
    this.reset();
  }
}
