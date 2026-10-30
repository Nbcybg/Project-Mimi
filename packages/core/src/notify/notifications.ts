import type { Notification, NotificationItem, PreferencesView, PushDeviceView } from '@mimi/shared';
import type { Db } from '../db/db.ts';
import { type PushResult, type PushSubscriptionKeys, sendPush, type VapidKeys } from './web-push.ts';
import { timeZoneName, type TimeZoneSource } from '../timezone.ts';

/** Kinds worth waking a phone for; "info" notes only go to the inbox. */
const PUSHED = new Set<Notification['kind']>(['reminder', 'task-result', 'approval', 'message']);
const KEEP = 500;
/** A device that fails this many pushes in a row (without saying "gone") is dropped. */
const MAX_FAILURES = 20;

interface NotificationRow {
  id: number;
  kind: Notification['kind'];
  title: string;
  body: string;
  chat_id: number | null;
  trigger_id: number | null;
  agent: string | null;
  created_at: string;
  read_at: string | null;
}

interface DeviceRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: string;
  last_ok_at: string | null;
}

export interface NotificationCenterDeps {
  vapid: () => VapidKeys;
  /** VAPID contact (`mailto:` or `https:`), sent to the push services. */
  subject: string;
  send?: (subscription: PushSubscriptionKeys, payload: unknown, urgency: 'normal' | 'high') => Promise<PushResult>;
  /** Quiet hours and which kinds are pushed (read on every notification). */
  preferences?: () => PreferencesView;
  timezone?: TimeZoneSource;
  now?: () => Date;
  log?: (message: string) => void;
}

const toItem = (row: NotificationRow): NotificationItem => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  ...(row.chat_id !== null ? { chatId: row.chat_id } : {}),
  ...(row.trigger_id !== null ? { triggerId: row.trigger_id } : {}),
  ...(row.agent ? { agent: row.agent } : {}),
  createdAt: row.created_at,
  read: row.read_at !== null,
});

/**
 * Notifications live on the server: every one is kept (an inbox any device can read,
 * so a lost phone loses nothing) and the important ones are pushed to each browser
 * that subscribed, even while the app is closed.
 */
export class NotificationCenter {
  private readonly db: Db;
  private readonly deps: NotificationCenterDeps;

  constructor(db: Db, deps: NotificationCenterDeps) {
    this.db = db;
    this.deps = deps;
  }

  /** Stores one notification and pushes it; returns it as stored. */
  add(notification: Notification): NotificationItem {
    const id = Number(
      this.db
        .prepare('INSERT INTO notifications (kind, title, body, chat_id, trigger_id, agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(
          notification.kind,
          notification.title,
          notification.body.slice(0, 4000),
          notification.chatId ?? null,
          notification.triggerId ?? null,
          notification.agent ?? null,
          new Date().toISOString(),
        )
        .lastInsertRowid,
    );
    this.db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)').run(KEEP);
    const item = toItem(this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow);
    if (this.shouldPush(item)) void this.push(item);
    return item;
  }

  /** True when this agent is muted: it stays in the inbox but is not pushed or shown live. */
  muted(agent: string | undefined): boolean {
    if (!agent) return false;
    return (this.deps.preferences?.().mutedAgents ?? []).includes(agent);
  }

  /** Whether an item is pushed now: kind, mute list and quiet hours (urgent approvals excepted). */
  shouldPush(item: Notification['kind'] | Pick<NotificationItem, 'kind' | 'agent'>): boolean {
    const kind = typeof item === 'string' ? item : item.kind;
    const agent = typeof item === 'string' ? undefined : item.agent;
    const preferences = this.deps.preferences?.() ?? {};
    const kinds = preferences.pushKinds ? new Set(preferences.pushKinds) : PUSHED;
    if (!kinds.has(kind)) return false;
    if (this.muted(agent)) return false;
    if (kind === 'approval' && preferences.urgentApprovals !== false && this.quiet(preferences)) return true;
    return !this.quiet(preferences);
  }

  private quiet(preferences: PreferencesView): boolean {
    const toMinutes = (value: string | undefined) => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
      return match ? Number(match[1]) * 60 + Number(match[2]) : null;
    };
    const from = toMinutes(preferences.quietFrom);
    const to = toMinutes(preferences.quietTo);
    if (from === null || to === null || from === to) return false;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZoneName(this.deps.timezone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(this.deps.now?.() ?? new Date());
    const now = Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
    // A window like 22:00-07:00 crosses midnight.
    return from < to ? now >= from && now < to : now >= from || now < to;
  }

  list(limit = 50): { items: NotificationItem[]; unread: number } {
    const rows = this.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit) as NotificationRow[];
    return { items: rows.map(toItem), unread: this.unread() };
  }

  unread(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number }).n;
  }

  /** Marks the given ones read, or all of them when no ids are given. */
  markRead(ids?: number[]): void {
    const now = new Date().toISOString();
    if (!ids) {
      this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now);
      return;
    }
    const update = this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL');
    this.db.transaction(() => ids.forEach((id) => update.run(now, id)))();
  }

  /** The public key a browser subscribes with. */
  publicKey(): string {
    return this.deps.vapid().publicKey;
  }

  subscribe(subscription: PushSubscriptionKeys, label: string): void {
    const endpoint = String(subscription.endpoint ?? '');
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('Push subscription: the endpoint is not a URL.');
    }
    if (url.protocol !== 'https:') throw new Error('Push subscription: the endpoint must be https.');
    if (!subscription.p256dh || !subscription.auth) throw new Error('Push subscription: keys are missing.');
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, failures = 0`,
      )
      .run(endpoint, subscription.p256dh, subscription.auth, label.slice(0, 80), new Date().toISOString());
  }

  unsubscribe(endpoint: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
  }

  devices(): PushDeviceView[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as DeviceRow[];
    return rows.map((row) => ({ endpoint: row.endpoint, service: new URL(row.endpoint).host, label: row.label, createdAt: row.created_at, lastOkAt: row.last_ok_at }));
  }

  /** Sends one item to every device; dropped subscriptions are forgotten. Returns how many took it. */
  async push(item: Pick<NotificationItem, 'id' | 'kind' | 'title' | 'body' | 'chatId'>): Promise<number> {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions').all() as DeviceRow[];
    if (rows.length === 0) return 0;
    const send =
      this.deps.send ??
      ((subscription: PushSubscriptionKeys, payload: unknown, urgency: 'normal' | 'high') =>
        sendPush(subscription, payload, { vapid: this.deps.vapid(), subject: this.deps.subject, urgency }));
    const payload = { id: item.id, kind: item.kind, title: item.title, body: item.body.slice(0, 1000), chatId: item.chatId ?? null };
    const urgency = item.kind === 'approval' || item.kind === 'reminder' ? 'high' : 'normal';
    let delivered = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          const result = await send({ endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, payload, urgency);
          if (result.gone) {
            this.unsubscribe(row.endpoint);
          } else if (result.status >= 200 && result.status < 300) {
            delivered++;
            this.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?').run(new Date().toISOString(), row.endpoint);
          } else {
            this.failed(row.endpoint, `HTTP ${result.status}`);
          }
        } catch (error) {
          this.failed(row.endpoint, (error as Error).message);
        }
      }),
    );
    return delivered;
  }

  private failed(endpoint: string, reason: string): void {
    this.deps.log?.(`push to ${new URL(endpoint).host} failed: ${reason}`);
    this.db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(endpoint);
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND failures >= ?').run(endpoint, MAX_FAILURES);
  }
}
