import { GRAPH, type MicrosoftAuth } from '../microsoft/auth.ts';
import type { GoogleAuth } from '../google/auth.ts';

/**
 * The provider calls behind realtime calendar sync. Google Calendar uses
 * `events.watch` + the events list with a `syncToken`; Microsoft Graph uses
 * `/subscriptions` + `/me/events/delta`. Both accept an auth object that only has
 * to implement `request`, which keeps the tests free of token plumbing.
 */

export interface CalendarRequester {
  request<T>(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
}

const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3';
const calendarPath = (calendarId: string) => `${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendarId)}`;

export interface GoogleChannel {
  id: string;
  resourceId: string;
  expiration: string | null;
}

export interface GoogleWatchInput {
  channelId: string;
  /** Public HTTPS URL the provider calls. */
  address: string;
  /** Compared with `x-goog-channel-token` on every notification. */
  token: string;
  ttlSeconds: number;
}

/** `events.watch`: ask Google to push a notification when the calendar changes. */
export async function googleWatch(auth: GoogleAuth | CalendarRequester, calendarId: string, input: GoogleWatchInput): Promise<GoogleChannel> {
  const body = await auth.request<{ id?: string; resourceId?: string; expiration?: string }>(`${calendarPath(calendarId)}/events/watch`, {
    method: 'POST',
    body: {
      id: input.channelId,
      type: 'web_hook',
      address: input.address,
      token: input.token,
      params: { ttl: String(Math.max(60, Math.round(input.ttlSeconds))) },
    },
  });
  if (!body.id || !body.resourceId) throw new Error('Google did not return a channel id; the push subscription was not created.');
  return { id: body.id, resourceId: body.resourceId, expiration: body.expiration ?? null };
}

/** Stops a channel; Google asks for both the channel id and its resource id. */
export async function googleStopChannel(auth: GoogleAuth | CalendarRequester, channel: { id: string; resourceId: string }): Promise<void> {
  await auth.request(`${GOOGLE_CALENDAR}/channels/stop`, { method: 'POST', body: { id: channel.id, resourceId: channel.resourceId } });
}

export interface CalendarEntry {
  id: string;
  summary: string;
  primary: boolean;
}

/** Every calendar in the account's list, for the picker. */
export async function googleCalendars(auth: GoogleAuth | CalendarRequester): Promise<CalendarEntry[]> {
  const body = await auth.request<{ items?: Array<{ id?: string; summary?: string; primary?: boolean }> }>(
    `${GOOGLE_CALENDAR}/users/me/calendarList?maxResults=250`,
  );
  return (body.items ?? []).flatMap((item) => (item.id ? [{ id: item.id, summary: item.summary?.trim() || item.id, primary: item.primary === true }] : []));
}

/** Every calendar in the Microsoft account, for the picker. */
export async function graphCalendars(auth: MicrosoftAuth | CalendarRequester): Promise<CalendarEntry[]> {
  const body = await auth.request<{ value?: Array<{ id?: string; name?: string; isDefault?: boolean }> }>(
    '/me/calendars?$select=id,name,isDefault',
  );
  return (body.value ?? []).flatMap((item) => (item.id ? [{ id: item.id, summary: item.name?.trim() || item.id, primary: item.isDefault === true }] : []));
}

export interface GoogleCalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

export interface GoogleEventPage {
  items: GoogleCalendarEvent[];
  syncToken: string | null;
  /** True when this pass was a full listing instead of an incremental sync. */
  baseline: boolean;
}

/**
 * Reads calendar changes. Without a `syncToken` it lists the recent window and
 * returns the token of that baseline; the caller must not treat those events as new.
 * A `410 Gone` (an old token) repeats as a full baseline automatically.
 */
export async function googleEventChanges(
  auth: GoogleAuth | CalendarRequester,
  calendarId: string,
  syncToken: string | undefined,
  options: { now?: () => Date; lookBackDays?: number } = {},
): Promise<GoogleEventPage> {
  const now = options.now?.() ?? new Date();
  let token = syncToken;
  let baseline = !token;
  for (let attempt = 0; ; attempt++) {
    try {
      return await readGooglePages(auth, calendarId, token, baseline, now, options.lookBackDays ?? 7);
    } catch (error) {
      // An expired or unknown token is the normal end of an incremental sync.
      if (token && attempt === 0 && /Google API error 410\b/.test((error as Error).message)) {
        token = undefined;
        baseline = true;
        continue;
      }
      throw error;
    }
  }
}

async function readGooglePages(
  auth: GoogleAuth | CalendarRequester,
  calendarId: string,
  syncToken: string | undefined,
  baseline: boolean,
  now: Date,
  lookBackDays: number,
): Promise<GoogleEventPage> {
  const items: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  do {
    const params = new URLSearchParams({ showDeleted: 'true', singleEvents: 'true', maxResults: '250' });
    if (syncToken) params.set('syncToken', syncToken);
    else params.set('timeMin', new Date(now.getTime() - lookBackDays * 86_400_000).toISOString());
    if (pageToken) params.set('pageToken', pageToken);
    const page = await auth.request<{ items?: GoogleCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(
      `${calendarPath(calendarId)}/events?${params}`,
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken && page.nextSyncToken) nextSyncToken = page.nextSyncToken;
  } while (pageToken);
  if (!nextSyncToken) throw new Error('Google returned no nextSyncToken; the calendar cannot be synced incrementally.');
  return { items, syncToken: nextSyncToken, baseline };
}

export interface GraphSubscription {
  id: string;
  expirationDateTime: string;
}

export interface GraphSubscriptionInput {
  notificationUrl: string;
  /** Receives subscription lifecycle events (removed, missed, reauthorization required). */
  lifecycleNotificationUrl?: string;
  /** Compared with every notification's `clientState`. */
  clientState: string;
  /** UTC ISO-8601; Graph caps `/me/events` at 4230 minutes. */
  expirationDateTime: string;
  resource?: string;
}

/** Subscribes to created/updated/deleted events under `/me/events`. */
export async function graphCreateSubscription(auth: MicrosoftAuth | CalendarRequester, input: GraphSubscriptionInput): Promise<GraphSubscription> {
  const body = await auth.request<{ id?: string; expirationDateTime?: string }>('/subscriptions', {
    method: 'POST',
    body: {
      changeType: 'created,updated,deleted',
      notificationUrl: input.notificationUrl,
      ...(input.lifecycleNotificationUrl ? { lifecycleNotificationUrl: input.lifecycleNotificationUrl } : {}),
      resource: input.resource ?? '/me/events',
      expirationDateTime: input.expirationDateTime,
      clientState: input.clientState,
    },
  });
  if (!body.id || !body.expirationDateTime) throw new Error('Graph did not return a subscription id; the push subscription was not created.');
  return { id: body.id, expirationDateTime: body.expirationDateTime };
}

export async function graphRenewSubscription(
  auth: MicrosoftAuth | CalendarRequester,
  subscriptionId: string,
  expirationDateTime: string,
): Promise<GraphSubscription> {
  const body = await auth.request<{ id?: string; expirationDateTime?: string }>(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    body: { expirationDateTime },
  });
  if (!body.id || !body.expirationDateTime) throw new Error('Graph did not return the renewed subscription.');
  return { id: body.id, expirationDateTime: body.expirationDateTime };
}

export async function graphDeleteSubscription(auth: MicrosoftAuth | CalendarRequester, subscriptionId: string): Promise<void> {
  await auth.request(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
}

export interface GraphCalendarEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  webLink?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  '@removed'?: { reason?: string };
}

export interface GraphEventPage {
  items: GraphCalendarEvent[];
  deltaLink: string | null;
  baseline: boolean;
}

/** How many pages one pass may read, so a huge calendar cannot hang a tick. */
const MAX_DELTA_PAGES = 50;

/**
 * Reads `/me/events/delta`. Without a delta link the first pass is the baseline
 * (its events are not "new"); a `410` means Graph dropped the state and the caller
 * starts over from a baseline.
 */
export async function graphEventChanges(
  auth: MicrosoftAuth | CalendarRequester,
  deltaLink: string | undefined,
  resource?: string,
): Promise<GraphEventPage> {
  try {
    return await readGraphDelta(auth, deltaLink, resource);
  } catch (error) {
    // Graph forgot the delta state (410): start over with a fresh baseline.
    if (deltaLink && /Microsoft Graph error 410\b/.test((error as Error).message)) return readGraphDelta(auth, undefined, resource);
    throw error;
  }
}

async function readGraphDelta(
  auth: MicrosoftAuth | CalendarRequester,
  deltaLink: string | undefined,
  resource?: string,
): Promise<GraphEventPage> {
  const baseline = !deltaLink;
  const select = 'id,subject,start,end,location,organizer,attendees,webLink,isAllDay,isCancelled,createdDateTime,lastModifiedDateTime';
  let next: string | undefined =
    deltaLink ?? `${resource ?? '/me/events'}/delta?$select=${select}`;
  const items: GraphCalendarEvent[] = [];
  let delta: string | null = null;
  for (let page = 0; next && page < MAX_DELTA_PAGES; page++) {
    const path: string = next.startsWith(GRAPH) ? next.slice(GRAPH.length) : next;
    const body: { value?: GraphCalendarEvent[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await auth.request(path, {
      headers: { Prefer: 'odata.maxpagesize=100' },
    });
    items.push(...(body.value ?? []));
    next = body['@odata.nextLink'];
    if (!next && body['@odata.deltaLink']) delta = body['@odata.deltaLink'];
  }
  if (!delta) throw new Error('Graph returned no deltaLink; the calendar cannot be synced incrementally.');
  return { items, deltaLink: delta, baseline };
}
