import type { FlowItem, JsonValue } from '@mimi/shared';
import { matchText } from './text-match.ts';

export const DEFAULT_TOKEN_SECRET = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram refuses longer messages; longer text goes out in parts. */
const MAX_MESSAGE = 4096;

/** A workflow that wants Telegram messages, with its trigger settings. */
export interface TelegramListener {
  id: string;
  tokenSecret: string;
  chatIds: string[];
  match: string;
  pattern: string;
  run(item: FlowItem): Promise<unknown>;
}

export interface TelegramHubDeps {
  secret(name: string): string | undefined;
  /** Workflows listening right now (read on every sync and every update). */
  listeners(): TelegramListener[];
  /** Last update id handled per bot, so a restart does not replay old messages. */
  cursor: { get(key: string): string | undefined; set(key: string, value: string): void };
  /** A problem worth telling the user about (missing token, webhook still set…); repeats are dropped. */
  report(message: string): void;
  fetchFn?: typeof fetch;
  apiBase?: string;
  /** Wait after an error before trying again. */
  retryMs?: number;
  /** Long-poll length in seconds. */
  pollSeconds?: number;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type?: string; title?: string };
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
}

/** What a Telegram message becomes as a workflow item. */
export function telegramItem(message: TelegramMessage, rest: string): FlowItem {
  const from = message.from;
  const json: Record<string, JsonValue> = {
    text: message.text ?? message.caption ?? '',
    rest,
    chatId: message.chat.id,
    chatType: message.chat.type ?? '',
    messageId: message.message_id,
    from: from ? { id: from.id, username: from.username ?? '', firstName: from.first_name ?? '', lastName: from.last_name ?? '' } : null,
    date: new Date(message.date * 1000).toISOString(),
  };
  return { json };
}

/** Whether a listener takes this message: allowed chat, then the text rule. */
export function telegramMatch(listener: TelegramListener, message: TelegramMessage): { ok: boolean; rest: string } {
  if (listener.chatIds.length > 0 && !listener.chatIds.includes(String(message.chat.id))) return { ok: false, rest: '' };
  return matchText(listener.match, listener.pattern, message.text ?? message.caption ?? '');
}

/** Splits text at Telegram's limit, preferring line breaks. */
export function splitMessage(text: string, limit = MAX_MESSAGE): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit);
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest || parts.length === 0) parts.push(rest);
  return parts;
}

/** Sends a message; returns the id of the last part sent. */
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
  options: { parseMode?: string; fetchFn?: typeof fetch; apiBase?: string; signal?: AbortSignal } = {},
): Promise<number> {
  let last = 0;
  for (const part of splitMessage(text)) {
    const response = await (options.fetchFn ?? fetch)(`${options.apiBase ?? TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: part, ...(options.parseMode ? { parse_mode: options.parseMode } : {}) }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!response.ok || !body.ok) throw new Error(`Telegram sendMessage: ${body.description ?? `HTTP ${response.status}`}`);
    last = body.result?.message_id ?? last;
  }
  return last;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Long-polls each bot that a workflow listens on (one loop per token secret, since
 * Telegram allows a single getUpdates consumer) and hands each message to every
 * matching workflow.
 */
export class TelegramHub {
  private readonly deps: TelegramHubDeps;
  private readonly loops = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private lastReport = '';

  constructor(deps: TelegramHubDeps) {
    this.deps = deps;
  }

  /** Starts loops for bots that gained a listener and stops the ones that lost theirs. */
  sync(): void {
    const wanted = new Set(this.deps.listeners().map((listener) => listener.tokenSecret));
    for (const [secret, loop] of this.loops) {
      if (!wanted.has(secret)) {
        loop.controller.abort();
        this.loops.delete(secret);
      }
    }
    for (const secret of wanted) {
      if (this.loops.has(secret)) continue;
      const controller = new AbortController();
      this.loops.set(secret, { controller, done: this.poll(secret, controller.signal) });
    }
  }

  /** Bots being polled right now (by secret name). */
  active(): string[] {
    return [...this.loops.keys()];
  }

  async close(): Promise<void> {
    const loops = [...this.loops.values()];
    this.loops.clear();
    for (const loop of loops) loop.controller.abort();
    await Promise.all(loops.map((loop) => loop.done));
  }

  private report(message: string): void {
    if (message === this.lastReport) return;
    this.lastReport = message;
    this.deps.report(message);
  }

  private async poll(secret: string, signal: AbortSignal): Promise<void> {
    const retryMs = this.deps.retryMs ?? 60_000;
    const seconds = this.deps.pollSeconds ?? 25;
    const key = `telegram:${secret}`;
    while (!signal.aborted) {
      const token = this.deps.secret(secret);
      if (!token) {
        this.report(`Telegram: ยังไม่มี secret "${secret}" — ใส่ bot token ที่หน้า ตั้งค่า → secret`);
        await sleep(retryMs, signal);
        continue;
      }
      try {
        const offset = this.deps.cursor.get(key);
        const url = `${this.deps.apiBase ?? TELEGRAM_API}/bot${token}/getUpdates?timeout=${seconds}&allowed_updates=%5B%22message%22%5D${offset ? `&offset=${offset}` : ''}`;
        const response = await (this.deps.fetchFn ?? fetch)(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout((seconds + 15) * 1000)]),
        });
        const body = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          description?: string;
          result?: Array<{ update_id: number; message?: TelegramMessage }>;
        };
        if (!response.ok || !body.ok) {
          const conflict = response.status === 409 ? ' (บอทนี้ยังผูก webhook หรือมีโปรแกรมอื่นดึงอยู่ เช่น n8n)' : '';
          throw new Error(`${body.description ?? `HTTP ${response.status}`}${conflict}`);
        }
        for (const update of body.result ?? []) {
          this.deps.cursor.set(key, String(update.update_id + 1));
          const message = update.message;
          if (!message) continue;
          for (const listener of this.deps.listeners()) {
            if (listener.tokenSecret !== secret) continue;
            const matched = telegramMatch(listener, message);
            if (!matched.ok) continue;
            // A run may wait (an approval, a slow model): the poll goes on meanwhile.
            void listener.run(telegramItem(message, matched.rest)).catch(() => {});
          }
        }
        this.lastReport = '';
      } catch (error) {
        if (signal.aborted) break;
        this.report(`Telegram (${secret}): ${(error as Error).message}`);
        await sleep(retryMs, signal);
      }
    }
  }
}
