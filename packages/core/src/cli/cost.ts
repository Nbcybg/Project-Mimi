import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';
import {
  costByDayAndAgent,
  formatCallsTable,
  formatCostTable,
  recentCalls,
} from '../usage/report.ts';

/** Current UTC offset of a time zone as "+07:00", for SQLite date modifiers. */
function utcOffset(timezone: string): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')?.value;
  return /[+-]\d{2}:\d{2}/.exec(name ?? '')?.[0] ?? '+00:00';
}

// npm run cost -- [--days 30] [--calls 20]
const { values } = parseArgs({
  options: { days: { type: 'string', default: '30' }, calls: { type: 'string' } },
});
const config = loadConfig();
const db = openDb(config.dbPath);
const days = Number(values.days) > 0 ? Number(values.days) : 30;

console.log(`Usage by day and agent, last ${days} day(s), ${config.timezone}\n`);
console.log(formatCostTable(costByDayAndAgent(db, utcOffset(config.timezone), days)));
if (values.calls !== undefined) {
  const calls = Number(values.calls) > 0 ? Number(values.calls) : 20;
  console.log(`\nLast ${calls} model call(s)\n`);
  console.log(formatCallsTable(recentCalls(db, calls)));
}
db.close();
