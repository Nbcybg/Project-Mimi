import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { FlowItem, WorkflowNode, WorkflowView } from '@mimi/shared';
import { addTo, diffIn, formatDate, parseDate, startOf } from '../workflows/datetime.ts';
import { htmlToText, parseCsv, parseCsvRows, toCsv } from '../workflows/file-nodes.ts';
import { runWorkflowNode, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { makeTestCore } from './core-helpers.ts';
import { replyingModel } from './helpers.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-data-')));
const allowed = path.join(tmp, 'allowed');
fs.mkdirSync(allowed);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BKK = 'Asia/Bangkok';

const workflow = (): WorkflowView => ({
  name: 'flow',
  agent: 'mimi',
  title: 'Flow',
  description: '',
  enabled: true,
  trigger: { pool: 'manual', config: {} },
  webhook: null,
  nodes: [],
});

function deps(extra: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps {
  return {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)),
    allowedDirs: [allowed],
    timezone: BKK,
    ...extra,
  };
}

const node = (type: WorkflowNode['type'], config: WorkflowNode['config']): WorkflowNode => ({ id: 'n1', type, config, links: { main: [] } });
const run = (n: WorkflowNode, items: FlowItem[], d = deps()) => runWorkflowNode(workflow(), n, items, d);

test('datetime: parse, Thai formats, calendar math and diffs in the zone', () => {
  const date = parseDate('2026-10-18T02:30:00Z', BKK);
  assert.equal(formatDate(date, 'th', BKK), '18 ตุลาคม 2569');
  assert.equal(formatDate(date, 'th-full', BKK), 'วันอาทิตย์ที่ 18 ตุลาคม 2569');
  assert.equal(formatDate(date, 'th-time', BKK), '18 ต.ค. 2569 09:30 น.');
  assert.equal(formatDate(date, 'YYYY-MM-DD HH:mm', BKK), '2026-10-18 09:30');
  assert.equal(formatDate(date, '', BKK), '2026-10-18T02:30:00.000Z');
  // Date-only and Thai dates are midnight in the zone; a Buddhist year is converted.
  assert.equal(parseDate('2026-10-18', BKK).toISOString(), '2026-10-17T17:00:00.000Z');
  assert.equal(parseDate('18/10/2569', BKK).toISOString(), '2026-10-17T17:00:00.000Z');
  assert.equal(parseDate(1_760_000_000, BKK).toISOString(), new Date(1_760_000_000_000).toISOString());
  assert.throws(() => parseDate('not a date', BKK), /not a date/);
  // 31 Jan + 1 month stays in February.
  assert.equal(formatDate(addTo(parseDate('2026-01-31', BKK), 1, 'months', BKK), 'date', BKK), '2026-02-28');
  assert.equal(formatDate(addTo(date, -2, 'days', BKK), 'date', BKK), '2026-10-16');
  assert.equal(formatDate(startOf(date, 'week', BKK), 'YYYY-MM-DD HH:mm', BKK), '2026-10-12 00:00');
  assert.equal(formatDate(startOf(date, 'month', BKK), 'date', BKK), '2026-10-01');
  assert.equal(diffIn(parseDate('2026-10-01', BKK), parseDate('2026-10-18', BKK), 'days', BKK), 17);
  assert.equal(diffIn(parseDate('2026-01-31', BKK), parseDate('2026-03-30', BKK), 'months', BKK), 1);
  assert.equal(diffIn(parseDate('2024-10-18', BKK), parseDate('2026-10-18', BKK), 'years', BKK), 2);
});

test('datetime node: per item, into the named field', async () => {
  const added = await run(node('datetime', { operation: 'add', value: '{{ $json.Date }}', amount: 7, unit: 'days', format: 'date', name: 'due' }), [
    { json: { Date: '2026-10-18' } },
  ]);
  assert.equal(added.ok, true, added.error);
  assert.equal(added.outputs.main![0]!.json.due, '2026-10-25');
  const diff = await run(node('datetime', { operation: 'diff', value: '2026-10-18', other: '{{ $json.due }}', unit: 'days', name: 'left' }), [
    { json: { due: '2026-10-20' } },
  ]);
  assert.equal(diff.outputs.main![0]!.json.left, 2);
});

test('csv: quotes, delimiters, headers and back again', () => {
  const text = '﻿name;amount;note\r\n"ร้าน ""A""";120;"line1\nline2"\r\nB;80;\r\n\r\n';
  assert.deepEqual(parseCsvRows(text), [['name', 'amount', 'note'], ['ร้าน "A"', '120', 'line1\nline2'], ['B', '80', '']]);
  assert.deepEqual(parseCsv('a,b\n1,2').map((item) => item.json), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCsv('1,2\n3,4', false).map((item) => item.json), [{ col1: '1', col2: '2' }, { col1: '3', col2: '4' }]);
  const csv = toCsv([{ json: { a: 'x,y', b: 1 } }, { json: { c: 'say "hi"' } }]);
  assert.equal(csv, 'a,b,c\r\n"x,y",1,\r\n,,"say ""hi"""\r\n');
  assert.deepEqual(parseCsv(csv).map((item) => item.json), [{ a: 'x,y', b: '1', c: '' }, { a: '', b: '', c: 'say "hi"' }]);
  assert.equal(htmlToText('<p>สวัสดี&nbsp;<b>ครับ</b></p><script>x()</script><p>a &amp; b</p>'), 'สวัสดี ครับ\na & b');
});

test('file node: write / append / read / list inside the allowed folder only', async () => {
  const wrote = await run(node('file', { operation: 'write', path: 'notes/{{ $json.day }}.md', content: '# {{ $json.day }}' }), [{ json: { day: '2026-10-18' } }]);
  assert.equal(wrote.ok, true, wrote.error);
  const file = path.join(allowed, 'notes', '2026-10-18.md');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 2026-10-18');

  await run(node('file', { operation: 'append', path: 'notes/2026-10-18.md', content: '- {{ $json.rest }}' }), [{ json: { rest: 'ซื้อนม' } }, { json: { rest: 'จ่ายค่าไฟ' } }]);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 2026-10-18\n- ซื้อนม\n- จ่ายค่าไฟ\n');

  const read = await run(node('file', { operation: 'read', path: 'notes/2026-10-18.md', format: 'lines' }), [{ json: {} }]);
  assert.deepEqual(read.outputs.main!.map((item) => item.json.line), ['# 2026-10-18', '- ซื้อนม', '- จ่ายค่าไฟ']);
  const text = await run(node('file', { operation: 'read', path: file, format: 'text', name: 'body' }), [{ json: { keep: 1 } }]);
  assert.equal(text.outputs.main![0]!.json.keep, 1);
  assert.match(String(text.outputs.main![0]!.json.body), /จ่ายค่าไฟ/);

  const items = [{ json: { a: 1, b: 'x' } }, { json: { a: 2, b: 'y' } }];
  const asCsv = await run(node('file', { operation: 'write', path: 'out/rows.csv', source: 'items_csv' }), items);
  assert.deepEqual(asCsv.outputs.main![0]!.json.items, 2);
  assert.equal(fs.readFileSync(path.join(allowed, 'out', 'rows.csv'), 'utf8'), 'a,b\r\n1,x\r\n2,y\r\n');
  await run(node('file', { operation: 'write', path: 'out/rows.json', source: 'items_json' }), items);
  const back = await run(node('file', { operation: 'read', path: 'out/rows.json', format: 'json' }), [{ json: {} }]);
  assert.deepEqual(back.outputs.main!.map((item) => item.json), [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);

  const listed = await run(node('file', { operation: 'list', path: 'out', pattern: '*.csv' }), [{ json: {} }]);
  assert.deepEqual(listed.outputs.main!.map((item) => item.json.name), ['rows.csv']);

  const outside = await run(node('file', { operation: 'read', path: path.join(tmp, 'secret.txt') }), [{ json: {} }]);
  assert.match(outside.error!, /outside the allowed folders/);
  const escape = await run(node('file', { operation: 'write', path: '../escape.txt', content: 'x' }), [{ json: {} }]);
  assert.match(escape.error!, /outside the allowed folders/);
  assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
});

test('extract_file node: CSV / JSON become items, HTML text, PDF and images go to the model', async () => {
  fs.writeFileSync(path.join(allowed, 'bank.csv'), 'date,amount\n2026-10-01,120\n2026-10-02,80\n');
  fs.writeFileSync(path.join(allowed, 'page.html'), '<h1>หัวข้อ</h1><p>เนื้อหา</p>');
  fs.writeFileSync(path.join(allowed, 'receipt.pdf'), '%PDF-1.4 fake');
  fs.writeFileSync(path.join(allowed, 'book.xlsx'), 'PK');
  const asked: Array<{ mime: string; name: string; instruction: string; size: number }> = [];
  const d = deps({
    readMedia: async (request) => {
      asked.push({ mime: request.mime, name: request.name, instruction: request.instruction, size: request.data.length });
      return 'ร้าน A ยอด 120';
    },
  });
  const csv = await run(node('extract_file', { path: 'bank.csv', type: 'auto' }), [{ json: {} }], d);
  assert.deepEqual(csv.outputs.main!.map((item) => item.json), [{ date: '2026-10-01', amount: '120' }, { date: '2026-10-02', amount: '80' }]);
  const html = await run(node('extract_file', { path: 'page.html' }), [{ json: { id: 1 } }], d);
  assert.deepEqual(html.outputs.main![0]!.json, { id: 1, file: 'page.html', text: 'หัวข้อ\nเนื้อหา' });
  const pdf = await run(node('extract_file', { path: '{{ $json.path }}', instruction: 'อ่านยอดรวม', name: 'receipt' }), [{ json: { path: 'receipt.pdf' } }], d);
  assert.equal(pdf.outputs.main![0]!.json.receipt, 'ร้าน A ยอด 120');
  assert.deepEqual(asked, [{ mime: 'application/pdf', name: 'receipt.pdf', instruction: 'อ่านยอดรวม', size: 13 }]);
  const excel = await run(node('extract_file', { path: 'book.xlsx' }), [{ json: {} }], d);
  assert.match(excel.error!, /Excel is not supported/);
});

test('core: extract_file reads a PDF with the agent vision model', async () => {
  const target = await makeTestCore({ small: replyingModel([{ text: 'ใบเสร็จ: 99 บาท' }]) });
  const folder = target.core.deps.allowedDirs[0]!;
  fs.writeFileSync(path.join(folder, 'r.pdf'), '%PDF-1.4');
  const result = await target.core.testWorkflowNode(workflow(), node('extract_file', { path: 'r.pdf' }), []);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.outputs.main![0]!.json.text, 'ใบเสร็จ: 99 บาท');
  const logged = target.core.db.prepare('SELECT capability FROM usage_log').all() as Array<{ capability: string }>;
  assert.deepEqual(logged.map((row) => row.capability), ['vision']);
  await target.cleanup();
});
