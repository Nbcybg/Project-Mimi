import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CalendarAccountSyncView, CalendarChangeAction, CalendarChangeView, CalendarSource, CalendarSyncView } from '@mimi/shared';
import type { GoogleAuth } from '../google/auth.ts';
import type { MicrosoftAuth } from '../microsoft/auth.ts';
import {
  googleCalendars,
  googleEventChanges,
  googleStopChannel,
  googleWatch,
  graphCalendars,
  graphCreateSubscription,
  graphDeleteSubscription,
  graphEventChanges,
  graphRenewSubscription,
  type GoogleCalendarEvent,
  type GraphCalendarEvent,
} from './api.ts';

/** The OAuth account hub, reduced to what the watcher needs. */
export interface CalendarAccountHub {
  list(): Array<{ id: string; service: CalendarSource; name: string }>;
  google(id?: string): GoogleAuth;
  microsoft(id?: string): MicrosoftAuth;
}

export interface CalendarSyncDeps {
  /** Holds `calendar-sync.json`; machine-local. */
  dir: string;
  accounts: CalendarAccountHub;
  /** Public HTTPS base (tunnel or accounts gateway `/h/<id>`); absent = polling only. */
  publicUrl?: string | undefined;
  enabled?: boolean;
  /** A new subscription error, and a recovery after one. */
  notify?: (title: string, body: string) => void;
  /** Changes that were not seen before, for workflows and the app. */
  onChanges?: (changes: CalendarChangeView[]) => void;
  /** State changed (subscription renewed, delta pulled, error): refresh open screens. */
  onChanged?: () => void;
  now?: () => Date;
}

interface GoogleSubscriptionState {
  channelId: string;
  resourceId: string;
  token: string;
  address: string;
  calendarId: string;
  expiration: string | null;
  messageNumber: number;
  syncToken: string | null;
}

interface MicrosoftSubscriptionState {
  subscriptionId: string;
  clientState: string;
  address: string;
  resource: string;
  expiration: string | null;
  deltaLink: string | null;
}

interface AccountState {
  account: string;
  source: CalendarSource;
  /** Which calendar to watch: Google defaults to `primary`, Microsoft to all. */
  calendarId?: string;
  pushToken: string;
  google?: GoogleSubscriptionState;
  microsoft?: MicrosoftSubscriptionState;
  lastSyncAt: string | null;
  lastError: string | null;
}

interface CalendarSyncFile {
  version: 1;
  enabled: boolean;
  accounts: Record<string, AccountState>;
  /** Recent changes, newest last, for the safety-net poll and the app. */
  changes: CalendarChangeView[];
  /** Dedupe keys per account, so two notifications never become two workflow runs. */
  seen: Record<string, string[]>;
  lastCheckedAt: string | null;
}

export interface CalendarPushRequest {
  method: string;
  url: URL;
  /** Node's header bag: values may be arrays. */
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface CalendarPushResult {
  status: number;
  contentType?: string;
  body: string;
}

const KEEP_CHANGES = 500;
const KEEP_SEEN = 1000;
const CHANGE_TTL_MS = 24 * 3600_000;
const GOOGLE_TTL_MS = 7 * 86_400_000;
const GOOGLE_RENEW_BEFORE_MS = 24 * 3600_000;
/** Graph caps a `/me/events` subscription at 4230 minutes; renew well before that. */
const GRAPH_TTL_MS = 4200 * 60_000;
const GRAPH_RENEW_BEFORE_MS = 12 * 3600_000;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{2,80}$/;

const validCalendarId = (value: string): boolean => value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
const microsoftResource = (calendarId?: string): string => (calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/events` : '/me/events');
const nowIso = (now: () => Date) => now().toISOString();
const headerOf = (headers: CalendarPushRequest['headers'], name: string): string => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
};
const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};
const parseDate = (value: string | null | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const newToken = () => randomBytes(24).toString('base64url');

/**
 * Realtime calendar sync per OAuth account:
 *
 * - Google: `events.watch` channel → `/api/calendar/push/<token>` → `events.list`
 *   with a `syncToken` (incremental delta).
 * - Microsoft: Graph `/subscriptions` on `/me/events` → the same endpoint (with the
 *   `validationToken` handshake) → `/me/events/delta` (`@odata.deltaLink`).
 * - Every account also runs the delta pass on a 15-minute timer, because push
 *   notifications can silently stop. Subscription renewal rides on the same tick.
 *
 * State lives in `calendar-sync.json`; nothing here needs a database migration.
 */
export class CalendarSync {
  private readonly deps: CalendarSyncDeps;
  private readonly file: string;
  private pushBase: string | null;
  private readonly enabled: boolean;
  private data: CalendarSyncFile;
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private queuedTick = false;
  private readonly syncing = new Set<string>();
  private readonly queued = new Set<Promise<unknown>>();

  constructor(deps: CalendarSyncDeps) {
    this.deps = deps;
    this.file = path.join(deps.dir, 'calendar-sync.json');
    this.pushBase = deps.publicUrl?.trim().replace(/\/+$/, '') || null;
    this.enabled = deps.enabled !== false;
    this.data = { version: 1, enabled: this.enabled, accounts: {}, changes: [], seen: {}, lastCheckedAt: null };
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<CalendarSyncFile>;
      const accounts: Record<string, AccountState> = {};
      if (parsed.accounts && typeof parsed.accounts === 'object') {
        for (const [id, raw] of Object.entries(parsed.accounts)) {
          if (!raw || typeof raw !== 'object' || !ACCOUNT_ID.test(id)) continue;
          const value = raw as Partial<AccountState>;
          if (value.source !== 'google' && value.source !== 'microsoft') continue;
          accounts[id] = {
            account: id,
            source: value.source,
            ...(typeof value.calendarId === 'string' && validCalendarId(value.calendarId) ? { calendarId: value.calendarId } : {}),
            pushToken: typeof value.pushToken === 'string' && value.pushToken.length >= 20 ? value.pushToken : newToken(),
            ...(value.google && typeof value.google === 'object' ? { google: value.google } : {}),
            ...(value.microsoft && typeof value.microsoft === 'object' ? { microsoft: value.microsoft } : {}),
            lastSyncAt: typeof value.lastSyncAt === 'string' ? value.lastSyncAt : null,
            lastError: typeof value.lastError === 'string' ? value.lastError : null,
          };
        }
      }
      this.data = {
        version: 1,
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : this.enabled,
        accounts,
        changes: Array.isArray(parsed.changes)
          ? parsed.changes.filter((entry): entry is CalendarChangeView => Boolean(entry) && typeof (entry as CalendarChangeView).key === 'string').slice(-KEEP_CHANGES)
          : [],
        seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
        lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
      };
    } catch {
      // first start, or an unreadable file: begin clean
    }
  }

  private save(): void {
    this.data.enabled = this.enabled;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Windows: the file holds no credential beyond the unguessable push token
    }
    this.deps.onChanged?.();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * A public address that appeared or went away while running (the quick tunnel).
   * Subscriptions are made again for the new address on the next pass, which starts now.
   */
  setPublicUrl(url: string | null): void {
    const next = url?.trim().replace(/\/+$/, '') || null;
    if (next === this.pushBase) return;
    this.pushBase = next;
    void this.tick().catch(() => {});
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    const run = () => void this.tick().catch((error: Error) => console.error(`calendar sync: ${error.message}`));
    this.timer = setInterval(run, Math.max(60_000, intervalMs));
    this.timer.unref();
    this.firstTimer = setTimeout(run, 15_000);
    this.firstTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  /** Waits for push-triggered syncs (tests, and a clean shutdown). */
  async idle(): Promise<void> {
    while (this.queued.size > 0) await Promise.allSettled([...this.queued]);
  }

  /** One full pass: renew subscriptions, then read every account's delta. */
  async tick(): Promise<number> {
    if (!this.enabled) return 0;
    if (this.ticking) {
      this.queuedTick = true;
      return 0;
    }
    this.ticking = true;
    const fresh: CalendarChangeView[] = [];
    try {
      const accounts = this.deps.accounts.list().filter((account) => ACCOUNT_ID.test(account.id));
      const known = new Set(accounts.map((account) => account.id));
      for (const id of Object.keys(this.data.accounts)) {
        if (known.has(id)) continue;
        await this.dropAccount(id);
      }
      for (const account of accounts) {
        fresh.push(...(await this.syncAccount(account.id)));
      }
      this.prune();
      this.data.lastCheckedAt = nowIso(this.now);
      this.save();
    } finally {
      this.ticking = false;
      if (this.queuedTick) {
        this.queuedTick = false;
        void this.tick().catch(() => {});
      }
    }
    await this.emit(fresh);
    return fresh.length;
  }

  /** Changes a workflow may consume, newest last, from the last day. */
  pending(source: CalendarSource, account?: string): CalendarChangeView[] {
    const cutoff = this.now().getTime() - CHANGE_TTL_MS;
    return this.data.changes.filter(
      (change) => change.source === source && (!account || change.account === account) && parseDate(change.receivedAt) >= cutoff,
    );
  }

  view(): CalendarSyncView {
    const accounts: CalendarAccountSyncView[] = [];
    for (const account of this.deps.accounts.list()) {
      if (account.service !== 'google' && account.service !== 'microsoft') continue;
      const auth = account.service === 'google' ? this.deps.accounts.google(account.id) : this.deps.accounts.microsoft(account.id);
      const state = this.data.accounts[account.id];
      accounts.push({
        account: account.id,
        name: account.name,
        service: account.service,
        calendarId: state?.calendarId ?? (account.service === 'google' ? 'primary' : 'all'),
        connected: auth.isConfigured,
        push: this.subscriptionActive(state),
        subscriptionExpiresAt: state?.google?.expiration ?? state?.microsoft?.expiration ?? null,
        lastSyncAt: state?.lastSyncAt ?? null,
        lastError: state?.lastError ?? null,
        pending: state ? this.pending(account.service, account.id).length : 0,
      });
    }
    return {
      enabled: this.enabled,
      publicUrl: this.pushBase,
      pushAvailable: this.enabled && this.pushBase !== null,
      accounts,
      lastCheckedAt: this.data.lastCheckedAt,
    };
  }

  /** The account's calendars, for the picker. */
  async calendars(accountId: string): Promise<Array<{ id: string; summary: string; primary: boolean }>> {
    const account = this.deps.accounts.list().find((entry) => entry.id === accountId);
    if (!account || (account.service !== 'google' && account.service !== 'microsoft')) throw new Error('Only calendar accounts can be listed.');
    if (account.service === 'google') {
      const auth = this.deps.accounts.google(accountId);
      if (!auth.isConfigured) throw new Error('Reconnect the Google account first.');
      return googleCalendars(auth);
    }
    const auth = this.deps.accounts.microsoft(accountId);
    if (!auth.isConfigured) throw new Error('Reconnect the Microsoft account first.');
    return graphCalendars(auth);
  }

  /** Switches the watched calendar and starts a fresh baseline. `all` = every Microsoft calendar. */
  setCalendar(accountId: string, rawCalendarId: string): { ok: boolean; error?: string } {
    const account = this.deps.accounts.list().find((entry) => entry.id === accountId);
    if (!account || (account.service !== 'google' && account.service !== 'microsoft')) {
      return { ok: false, error: 'Only a calendar account can choose a calendar.' };
    }
    const calendarId = String(rawCalendarId ?? '').trim();
    const all = account.service === 'microsoft' && (calendarId === '' || calendarId === 'all');
    if (!all && !validCalendarId(calendarId)) return { ok: false, error: 'A calendar id is 1-200 characters on one line.' };
    const state = this.ensureState(account);
    const current = state.calendarId ?? (account.service === 'google' ? 'primary' : 'all');
    if (current === (all ? 'all' : calendarId)) return { ok: true };
    const previousGoogle = state.google;
    const previousMicrosoft = state.microsoft;
    if (all || (account.service === 'google' && calendarId === 'primary')) delete state.calendarId;
    else state.calendarId = calendarId;
    state.google = undefined;
    state.microsoft = undefined;
    delete this.data.seen[state.account];
    this.save();
    if (previousGoogle && previousGoogle.channelId) {
      const auth = this.deps.accounts.google(accountId);
      void googleStopChannel(auth, { id: previousGoogle.channelId, resourceId: previousGoogle.resourceId }).catch(() => {});
    }
    if (previousMicrosoft) {
      const auth = this.deps.accounts.microsoft(accountId);
      void graphDeleteSubscription(auth, previousMicrosoft.subscriptionId).catch(() => {});
    }
    void this.tick().catch(() => {});
    return { ok: true };
  }

  /** The URL providers call; null when no public base is configured. */
  pushUrl(accountId: string): string | null {
    const state = this.data.accounts[accountId];
    return this.pushBase && state ? `${this.pushBase}/api/calendar/push/${state.pushToken}` : null;
  }

  /**
   * Answers a provider notification. Graph's validation handshake (a `validationToken`
   * query the endpoint must echo) and the Google channel token are checked before the
   * delta pass is queued; the HTTP response never waits for providers.
   */
  async handlePush(request: CalendarPushRequest): Promise<CalendarPushResult> {
    const token = decodeURIComponent(request.url.pathname.split('/').filter(Boolean).pop() ?? '');
    const entry = Object.values(this.data.accounts).find((state) => same(state.pushToken, token));
    if (!entry) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'No such calendar channel.' };

    const validationToken = request.url.searchParams.get('validationToken');
    if (validationToken !== null) {
      // Microsoft Graph: echo the token exactly, as text/plain, within 10 seconds.
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: validationToken };
    }

    if (entry.source === 'google') {
      const channel = entry.google;
      if (!channel) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'No Google channel.' };
      if (!same(headerOf(request.headers, 'x-goog-channel-token'), channel.token) || headerOf(request.headers, 'x-goog-channel-id') !== channel.channelId) {
        return { status: 401, contentType: 'text/plain; charset=utf-8', body: 'Wrong channel token.' };
      }
      const state = headerOf(request.headers, 'x-goog-resource-state');
      const rawMessage = headerOf(request.headers, 'x-goog-message-number');
      const message = rawMessage ? Number(rawMessage) : Number.NaN;
      if (Number.isFinite(message) && message > channel.messageNumber) {
        channel.messageNumber = message;
        this.save();
      } else if (Number.isFinite(message) && message <= channel.messageNumber) {
        return { status: 200, contentType: 'text/plain; charset=utf-8', body: 'duplicate' };
      }
      // The first notification only says the channel is live.
      if (state !== 'sync') this.queue(entry.account);
      return { status: 200, contentType: 'text/plain; charset=utf-8', body: 'ok' };
    }

    if (entry.source === 'microsoft') {
      const subscription = entry.microsoft;
      if (!subscription) return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'No Microsoft subscription.' };
      let body: { value?: Array<{ clientState?: string; lifecycleEvent?: string }> } = {};
      try {
        body = JSON.parse(request.body || '{}') as typeof body;
      } catch {
        return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'Bad notification.' };
      }
      const notifications = (body.value ?? []).filter((notification) => same(String(notification.clientState ?? ''), subscription.clientState));
      if (notifications.length === 0) return { status: 401, contentType: 'text/plain; charset=utf-8', body: 'Wrong client state.' };
      const lifecycle = notifications.map((notification) => notification.lifecycleEvent).filter((event): event is string => typeof event === 'string');
      if (lifecycle.length > 0) {
        let replace = false;
        for (const event of lifecycle) {
          if (event === 'subscriptionRemoved') {
            delete entry.microsoft;
            this.setError(entry, 'push subscription was removed by Microsoft; creating a new one');
            replace = true;
          } else if (event === 'reauthorizationRequired') {
            this.setError(entry, 'authorization expired; reconnect the Microsoft account to keep calendar push');
          } else if (event === 'missed') {
            replace = true;
          }
        }
        this.save();
        if (replace) this.queue(entry.account);
        return { status: 202, contentType: 'text/plain; charset=utf-8', body: 'ok' };
      }
      this.queue(entry.account);
      return { status: 202, contentType: 'text/plain; charset=utf-8', body: 'ok' };
    }

    return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'No such calendar channel.' };
  }

  private now = (): Date => this.deps.now?.() ?? new Date();

  private subscriptionActive(state: AccountState | undefined): boolean {
    if (!this.enabled || !this.pushBase || !state) return false;
    if (state.source === 'google') {
      return Boolean(state.google && state.google.address === this.pushBase && parseDate(state.google.expiration) > this.now().getTime());
    }
    return Boolean(state.microsoft && state.microsoft.address === this.pushBase && parseDate(state.microsoft.expiration) > this.now().getTime());
  }

  private ensureState(account: { id: string; service: CalendarSource }): AccountState {
    const existing = this.data.accounts[account.id];
    if (existing && existing.source === account.service) return existing;
    const state: AccountState = {
      account: account.id,
      source: account.service,
      pushToken: existing?.pushToken ?? newToken(),
      lastSyncAt: null,
      lastError: null,
    };
    this.data.accounts[account.id] = state;
    return state;
  }

  private setError(state: AccountState, message: string | null): void {
    const previous = state.lastError;
    state.lastError = message;
    if (message && previous !== message) {
      this.deps.notify?.(`Calendar sync (${state.account})`, message);
    }
  }

  /** Syncs one account: subscription upkeep plus the delta pass. Returns events worth emitting. */
  private async syncAccount(accountId: string): Promise<CalendarChangeView[]> {
    if (this.syncing.has(accountId)) return [];
    const account = this.deps.accounts.list().find((entry) => entry.id === accountId);
    if (!account || (account.service !== 'google' && account.service !== 'microsoft')) return [];
    const auth = account.service === 'google' ? this.deps.accounts.google(accountId) : this.deps.accounts.microsoft(accountId);
    if (!auth.isConfigured) return [];
    this.syncing.add(accountId);
    const state = this.ensureState(account);
    try {
      let pushError: string | null = null;
      if (this.enabled && this.pushBase) {
        try {
          await this.ensureSubscription(state, auth);
        } catch (error) {
          pushError = `push subscription: ${(error as Error).message}`;
        }
      }
      let fresh: CalendarChangeView[];
      if (account.service === 'google') {
        if (!state.google) state.google = emptyGoogleState();
        fresh = await this.pullGoogle(state, auth as GoogleAuth);
      } else {
        if (!state.microsoft) state.microsoft = emptyMicrosoftState();
        fresh = await this.pullMicrosoft(state, auth as MicrosoftAuth);
      }
      state.lastSyncAt = nowIso(this.now);
      this.setError(state, pushError);
      this.save();
      return fresh;
    } catch (error) {
      this.setError(state, (error as Error).message);
      this.save();
      return [];
    } finally {
      this.syncing.delete(accountId);
    }
  }

  private async ensureSubscription(state: AccountState, auth: GoogleAuth | MicrosoftAuth): Promise<void> {
    const address = `${this.pushBase}/api/calendar/push/${state.pushToken}`;
    const now = this.now().getTime();
    if (state.source === 'google') {
      const existing = state.google;
      const calendarId = state.calendarId ?? 'primary';
      const expiresSoon = existing ? parseDate(existing.expiration) - now < GOOGLE_RENEW_BEFORE_MS : true;
      if (existing && existing.calendarId === calendarId && !expiresSoon && existing.address === address) return;
      if (existing) {
        await googleStopChannel(auth as GoogleAuth, { id: existing.channelId, resourceId: existing.resourceId }).catch(() => {});
      }
      const token = existing?.token ?? newToken();
      const channel = await googleWatch(auth as GoogleAuth, calendarId, {
        channelId: `${state.account}-${randomBytes(9).toString('hex')}`,
        address,
        token,
        ttlSeconds: GOOGLE_TTL_MS / 1000,
      });
      state.google = {
        channelId: channel.id,
        resourceId: channel.resourceId,
        token,
        address,
        calendarId,
        expiration: channel.expiration ? new Date(Number(channel.expiration)).toISOString() : null,
        messageNumber: existing?.messageNumber ?? 0,
        syncToken: existing?.calendarId === calendarId ? (existing.syncToken ?? null) : null,
      };
      return;
    }

    const existing = state.microsoft;
    const resource = microsoftResource(state.calendarId);
    const expiresSoon = existing ? parseDate(existing.expiration) - now < GRAPH_RENEW_BEFORE_MS : true;
    if (existing && existing.resource === resource && !expiresSoon && existing.address === address) return;
    const expirationDateTime = new Date(now + GRAPH_TTL_MS).toISOString();
    if (existing) {
      if (existing.address === address && existing.resource === resource) {
        try {
          const renewed = await graphRenewSubscription(auth as MicrosoftAuth, existing.subscriptionId, expirationDateTime);
          existing.expiration = renewed.expirationDateTime;
          return;
        } catch (error) {
          if (!/Microsoft Graph error 40[34]\b/.test((error as Error).message)) throw error;
          // The subscription was dropped on the Graph side; create a new one below.
        }
      }
      await graphDeleteSubscription(auth as MicrosoftAuth, existing.subscriptionId).catch(() => {});
    }
    const clientState = existing?.clientState ?? newToken();
    const subscription = await graphCreateSubscription(auth as MicrosoftAuth, {
      notificationUrl: address,
      lifecycleNotificationUrl: address,
      resource,
      clientState,
      expirationDateTime,
    });
    state.microsoft = {
      subscriptionId: subscription.id,
      clientState,
      address,
      resource,
      expiration: subscription.expirationDateTime,
      deltaLink: existing?.resource === resource ? (existing.deltaLink ?? null) : null,
    };
  }

  private async pullGoogle(state: AccountState, auth: GoogleAuth): Promise<CalendarChangeView[]> {
    const page = await googleEventChanges(auth, state.calendarId ?? 'primary', state.google?.syncToken ?? undefined, { now: this.now });
    state.google!.syncToken = page.syncToken;
    if (page.baseline) return [];
    const fresh: CalendarChangeView[] = [];
    const receivedAt = nowIso(this.now);
    for (const item of page.items) {
      const change = googleChange(item, state.account, receivedAt);
      if (change && this.remember(state, change.key)) fresh.push(change);
    }
    return fresh;
  }

  private async pullMicrosoft(state: AccountState, auth: MicrosoftAuth): Promise<CalendarChangeView[]> {
    const page = await graphEventChanges(auth, state.microsoft?.deltaLink ?? undefined, microsoftResource(state.calendarId));
    state.microsoft!.deltaLink = page.deltaLink;
    if (page.baseline) return [];
    const fresh: CalendarChangeView[] = [];
    const receivedAt = nowIso(this.now);
    for (const item of page.items) {
      const change = microsoftChange(item, state.account, receivedAt);
      if (change && this.remember(state, change.key)) fresh.push(change);
    }
    return fresh;
  }

  /** True the first time a change key is seen; both notifications and polls use it. */
  private remember(state: AccountState, key: string): boolean {
    const known = this.data.seen[state.account] ?? [];
    if (known.includes(key)) return false;
    known.push(key);
    this.data.seen[state.account] = known.slice(-KEEP_SEEN);
    return true;
  }

  private async emit(changes: CalendarChangeView[]): Promise<void> {
    if (changes.length === 0) return;
    // The buffer keeps the same objects; dedupe already dropped repeats.
    for (const change of changes) this.data.changes.push(change);
    this.data.changes = this.data.changes.slice(-KEEP_CHANGES);
    this.save();
    try {
      this.deps.onChanges?.(changes);
    } catch (error) {
      console.error(`calendar changes: ${(error as Error).message}`);
    }
  }

  private queue(accountId: string): void {
    const run = this.syncAccount(accountId)
      .then((changes) => this.emit(changes))
      .finally(() => {
        this.queued.delete(run);
      });
    this.queued.add(run);
  }

  private prune(): void {
    // Drop dedupe keys whose changes are older than the change window, so accounts
    // that are edited once a year do not grow without bound.
    for (const [account, keys] of Object.entries(this.data.seen)) {
      if (!this.data.accounts[account]) delete this.data.seen[account];
      else if (keys.length > KEEP_SEEN) this.data.seen[account] = keys.slice(-KEEP_SEEN);
    }
    this.data.changes = this.data.changes.filter((change) => parseDate(change.receivedAt) >= this.now().getTime() - CHANGE_TTL_MS);
  }

  private async dropAccount(id: string): Promise<void> {
    const state = this.data.accounts[id];
    if (!state) return;
    const account = this.deps.accounts.list().find((entry) => entry.id === id);
    try {
      if (state.google && account?.service === 'google') {
        await googleStopChannel(this.deps.accounts.google(id), { id: state.google.channelId, resourceId: state.google.resourceId });
      }
      if (state.microsoft && account?.service === 'microsoft') {
        await graphDeleteSubscription(this.deps.accounts.microsoft(id), state.microsoft.subscriptionId);
      }
    } catch {
      // the account is gone; the provider will expire the subscription on its own
    }
    delete this.data.accounts[id];
    delete this.data.seen[id];
  }
}

function emptyGoogleState(): GoogleSubscriptionState {
  return { channelId: '', resourceId: '', token: '', address: '', calendarId: 'primary', expiration: null, messageNumber: 0, syncToken: null };
}

function emptyMicrosoftState(): MicrosoftSubscriptionState {
  return { subscriptionId: '', clientState: '', address: '', resource: '/me/events', expiration: null, deltaLink: null };
}

function eventTimes(start?: { dateTime?: string; date?: string }, end?: { dateTime?: string; date?: string }) {
  return {
    start: start?.dateTime ?? start?.date ?? '',
    end: end?.dateTime ?? end?.date ?? '',
    allDay: Boolean(start?.date && !start?.dateTime),
  };
}

function googleChange(item: GoogleCalendarEvent, account: string, receivedAt: string): CalendarChangeView | null {
  if (!item.id) return null;
  const action: CalendarChangeAction =
    item.status === 'cancelled' ? 'deleted' : item.created && item.updated && item.created === item.updated ? 'created' : 'updated';
  const times = eventTimes(item.start, item.end);
  const attendees = (item.attendees ?? [])
    .map((entry) => entry.email ?? entry.displayName)
    .filter((entry): entry is string => Boolean(entry))
    .join(', ');
  return {
    id: item.id,
    source: 'google',
    account,
    action,
    title: item.summary ?? '',
    start: times.start,
    end: times.end,
    allDay: times.allDay,
    location: item.location ?? '',
    organizer: item.organizer?.email ?? item.organizer?.displayName ?? '',
    attendees,
    link: item.htmlLink ?? '',
    status: item.status ?? '',
    updatedAt: item.updated || null,
    receivedAt,
    key: `google:${account}:${item.id}:${item.updated ?? action}:${action}`,
  };
}

function microsoftChange(item: GraphCalendarEvent, account: string, receivedAt: string): CalendarChangeView | null {
  if (!item.id) return null;
  const removed = Boolean(item['@removed']) || item.isCancelled === true;
  const action: CalendarChangeAction = removed
    ? 'deleted'
    : item.createdDateTime && item.lastModifiedDateTime && item.createdDateTime === item.lastModifiedDateTime
      ? 'created'
      : 'updated';
  const times = eventTimes(item.start, item.end);
  const attendees = (item.attendees ?? [])
    .map((entry) => entry.emailAddress?.address)
    .filter((entry): entry is string => Boolean(entry))
    .join(', ');
  const organizer = item.organizer?.emailAddress;
  return {
    id: item.id,
    source: 'microsoft',
    account,
    action,
    title: item.subject ?? '',
    start: times.start,
    end: times.end,
    allDay: item.isAllDay === true || times.allDay,
    location: item.location?.displayName ?? '',
    organizer: organizer?.address ?? organizer?.name ?? '',
    attendees,
    link: item.webLink ?? '',
    status: removed ? 'cancelled' : 'confirmed',
    updatedAt: item.lastModifiedDateTime || null,
    receivedAt,
    key: `microsoft:${account}:${item.id}:${item.lastModifiedDateTime ?? action}:${action}`,
  };
}
