/** The two calendar providers Mimi can watch. */
export type CalendarSource = 'google' | 'microsoft';

/** What happened to an event, as far as the provider tells us. */
export type CalendarChangeAction = 'created' | 'updated' | 'deleted';

/** One calendar change the watcher noticed, before it becomes a workflow item. */
export interface CalendarChangeView {
  /** Provider event id (`AAMk…` on Graph, `abc123` on Google). */
  id: string;
  source: CalendarSource;
  /** OAuth account id that owns the calendar. */
  account: string;
  action: CalendarChangeAction;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  organizer: string;
  attendees: string;
  link: string;
  status: string;
  /** Provider modification time, when it sends one. */
  updatedAt: string | null;
  /** When Mimi learned about the change. */
  receivedAt: string;
  /** Dedupe key: provider, account, event id and modification time. */
  key: string;
}

/** Per-account subscription and delta state, as the app shows it. */
export interface CalendarAccountSyncView {
  account: string;
  name: string;
  service: CalendarSource;
  connected: boolean;
  /** A push channel is active; false means the 15-minute poll is doing the work. */
  push: boolean;
  subscriptionExpiresAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Changes seen recently that a trigger has not necessarily handled yet. */
  pending: number;
}

/** The calendar sync screen. */
export interface CalendarSyncView {
  enabled: boolean;
  /** Base address providers call; absent = only polling (no public HTTPS endpoint). */
  publicUrl: string | null;
  /** True when subscriptions can be made (enabled and a public URL is configured). */
  pushAvailable: boolean;
  accounts: CalendarAccountSyncView[];
  lastCheckedAt: string | null;
}
