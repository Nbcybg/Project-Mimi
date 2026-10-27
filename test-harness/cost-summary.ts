import fs from 'node:fs';
import path from 'node:path';
let total = 0;
const rows: Array<[string, number, number, number]> = [];
for (const d of fs.readdirSync('test-report').sort()) {
  const t = fs.readFileSync(path.join('test-report', d, 'transcript.txt'), 'utf8');
  let cost = 0;
  for (const m of t.matchAll(/cost=\$([\d.]+)/g)) cost += parseFloat(m[1]);
  const perms = (t.match(/\[PERMISSION\]/g) ?? []).length;
  const finish = t.match(/run-finish reason=(\w+)/);
  total += cost;
  rows.push([d, cost, perms, finish ? 1 : 0]);
  console.log(d.padEnd(30), `$${cost.toFixed(5)}`.padStart(12), `perms=${perms}`, `reason=${finish ? finish[1] : '?'}`);
}
console.log(`TOTAL: $${total.toFixed(5)}`);
