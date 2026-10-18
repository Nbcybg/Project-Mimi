/** Date math and formatting for the datetime node: time-zone aware, Thai-friendly, no libraries. */

export type DateUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';

const UNIT_MS: Record<Exclude<DateUnit, 'months' | 'years'>, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_DAYS_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

/** Named formats the node offers besides a free pattern. */
export const DATE_PRESETS: Record<string, string> = {
  date: 'YYYY-MM-DD',
  datetime: 'YYYY-MM-DD HH:mm',
  time: 'HH:mm',
  th: 'D MMMM BBBB',
  'th-short': 'D MMM BB',
  'th-full': 'วันdddd[ที่] D MMMM BBBB',
  'th-time': 'D MMM BBBB HH:mm [น.]',
};

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock reading of `date` in `timeZone`. */
export function zoneParts(date: Date, timeZone: string): ZoneParts {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? 'Sun'),
  };
}

/** The instant whose wall clock in `timeZone` reads `parts` (DST gaps resolve forward). */
export function fromZone(parts: Omit<ZoneParts, 'weekday'>, timeZone: string): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = asUtc;
  // Two rounds settle the offset, including across a DST change.
  for (let round = 0; round < 2; round++) {
    const seen = zoneParts(new Date(guess), timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    guess += asUtc - seenUtc;
  }
  return new Date(guess);
}

/**
 * Reads a date: ISO strings, epoch numbers (seconds or ms), `YYYY-MM-DD` or `D/M/YYYY`
 * (a Buddhist year above 2400 is converted) as midnight in the zone; empty means now.
 */
export function parseDate(value: unknown, timeZone: string, now = new Date()): Date {
  if (value === undefined || value === null || value === '' || value === 'now') return now;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  const text = String(value).trim();
  if (/^\d{9,13}$/.test(text)) return parseDate(Number(text), timeZone, now);
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (dateOnly) return fromZone({ year: toGregorian(Number(dateOnly[1])), month: Number(dateOnly[2]), day: Number(dateOnly[3]), hour: 0, minute: 0, second: 0 }, timeZone);
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (local) {
    return fromZone(
      {
        year: toGregorian(Number(local[3])),
        month: Number(local[2]),
        day: Number(local[1]),
        hour: Number(local[4] ?? 0),
        minute: Number(local[5] ?? 0),
        second: Number(local[6] ?? 0),
      },
      timeZone,
    );
  }
  // A date-time without a zone is wall-clock time in the zone.
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (naive) {
    return fromZone(
      { year: Number(naive[1]), month: Number(naive[2]), day: Number(naive[3]), hour: Number(naive[4]), minute: Number(naive[5]), second: Number(naive[6] ?? 0) },
      timeZone,
    );
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`"${text}" is not a date I can read`);
  return new Date(parsed);
}

const toGregorian = (year: number) => (year > 2400 ? year - 543 : year);
const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** Formats with tokens YYYY YY BBBB BB MMMM MMM MM M DD D dddd ddd HH H mm ss, [literal]; or a preset name, or "iso". */
export function formatDate(date: Date, pattern: string, timeZone: string): string {
  const wanted = pattern.trim() || 'iso';
  if (wanted === 'iso') return date.toISOString();
  const template = DATE_PRESETS[wanted] ?? wanted;
  const parts = zoneParts(date, timeZone);
  return template.replace(/\[([^\]]*)\]|YYYY|BBBB|YY|BB|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY':
        return String(parts.year);
      case 'YY':
        return pad(parts.year % 100);
      case 'BBBB':
        return String(parts.year + 543);
      case 'BB':
        return pad((parts.year + 543) % 100);
      case 'MMMM':
        return TH_MONTHS[parts.month - 1]!;
      case 'MMM':
        return TH_MONTHS_SHORT[parts.month - 1]!;
      case 'MM':
        return pad(parts.month);
      case 'M':
        return String(parts.month);
      case 'DD':
        return pad(parts.day);
      case 'D':
        return String(parts.day);
      case 'dddd':
        return TH_DAYS[parts.weekday]!;
      case 'ddd':
        return TH_DAYS_SHORT[parts.weekday]!;
      case 'HH':
        return pad(parts.hour);
      case 'H':
        return String(parts.hour);
      case 'mm':
        return pad(parts.minute);
      case 'ss':
        return pad(parts.second);
      default:
        return token;
    }
  });
}

/** Adds (or with a negative amount, subtracts); months and years follow the calendar in the zone. */
export function addTo(date: Date, amount: number, unit: DateUnit, timeZone: string): Date {
  if (unit === 'months' || unit === 'years') {
    const parts = zoneParts(date, timeZone);
    const months = parts.year * 12 + (parts.month - 1) + (unit === 'years' ? amount * 12 : amount);
    const year = Math.floor(months / 12);
    const month = (months % 12) + 1;
    // 31 Jan + 1 month = 28/29 Feb, not 3 Mar.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return fromZone({ ...parts, year, month, day: Math.min(parts.day, lastDay) }, timeZone);
  }
  return new Date(date.getTime() + amount * UNIT_MS[unit]);
}

/** Start of the day / week (Monday) / month / year that `date` falls in, in the zone. */
export function startOf(date: Date, unit: 'day' | 'week' | 'month' | 'year', timeZone: string): Date {
  const parts = zoneParts(date, timeZone);
  const midnight = { ...parts, hour: 0, minute: 0, second: 0 };
  switch (unit) {
    case 'day':
      return fromZone(midnight, timeZone);
    case 'week': {
      const back = (parts.weekday + 6) % 7;
      return addTo(fromZone(midnight, timeZone), -back, 'days', timeZone);
    }
    case 'month':
      return fromZone({ ...midnight, day: 1 }, timeZone);
    case 'year':
      return fromZone({ ...midnight, month: 1, day: 1 }, timeZone);
  }
}

/** `to - from` in the unit (two decimals); months and years count calendar months. */
export function diffIn(from: Date, to: Date, unit: DateUnit, timeZone: string): number {
  if (unit === 'months' || unit === 'years') {
    const a = zoneParts(from, timeZone);
    const b = zoneParts(to, timeZone);
    let months = (b.year - a.year) * 12 + (b.month - a.month);
    // Not a whole month yet until the day (and time) comes round again.
    const aRest = ((a.day * 24 + a.hour) * 60 + a.minute) * 60 + a.second;
    const bRest = ((b.day * 24 + b.hour) * 60 + b.minute) * 60 + b.second;
    if (months > 0 && bRest < aRest) months--;
    if (months < 0 && bRest > aRest) months++;
    return unit === 'years' ? Math.trunc(months / 12) : months;
  }
  return Math.round(((to.getTime() - from.getTime()) / UNIT_MS[unit]) * 100) / 100;
}
