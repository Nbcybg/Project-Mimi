/**
 * The zone the app runs on: an IANA name (Asia/Bangkok) or a function that returns the
 * current one, so changing Settings takes effect on the next message without a restart.
 */
export type TimeZoneSource = string | (() => string);

/** The zone in force now; an unset one falls back to the machine's zone. */
export function timeZoneName(source?: TimeZoneSource): string {
  const value = typeof source === 'function' ? source() : source;
  return value && value.trim() ? value.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A validated IANA zone name from what the user typed; empty when Intl does not know it. */
export function cleanTimeZone(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const zone = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}
