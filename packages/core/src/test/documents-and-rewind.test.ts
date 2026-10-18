import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, test } from 'node:test';
import { writeFileTool } from '@mimi/pc-agent';
import { FileSnapshots, SnapshotExecutor } from '../chat/file-snapshots.ts';
import { openDb } from '../db/db.ts';
import type { GoogleAuth } from '../google/auth.ts';
import type { MicrosoftAuth } from '../microsoft/auth.ts';
import { LocalExecutor } from '../tools/executor.ts';
import { createMailAttachmentTools, safeFileName } from '../tools/mail-attachments.ts';
import { documentText } from '../workflows/file-nodes.ts';
import { runWorkflowNode, WorkflowState } from '../workflows/runner.ts';
import { excelDate, readXlsx, sheetItems, unzip, xlsxText } from '../workflows/xlsx.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-docs-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A minimal zip writer (stored and deflated entries), enough to build test .xlsx files. */
function zip(entries: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const WORKBOOK = {
  'xl/workbook.xml': '<workbook><sheets><sheet name="รายจ่าย" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>วันที่</t></si><si><t>รายการ</t></si><si><t>ยอด</t></si><si><r><t>ค่า</t></r><r><t>ไฟ</t></r></si><si><t>กาแฟ &amp; ขนม</t></si></sst>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2"><v>46313</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>1250.5</v></c></row>' +
    '<row r="4"><c r="A4"><v>46314</v></c><c r="B4" t="s"><v>4</v></c><c r="C4"><f>SUM(1,2)</f><v>85</v></c><c r="E4" t="b"><v>1</v></c></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>จดไว้</t></is></c></row></sheetData></worksheet>',
};

test('xlsx: sheets, shared / rich / inline strings, numbers, gaps and booleans', () => {
  for (const deflate of [true, false]) {
    const data = zip(WORKBOOK, deflate);
    assert.equal(unzip(data).size, 5);
    const sheets = readXlsx(data);
    assert.deepEqual(sheets.map((sheet) => sheet.name), ['รายจ่าย', 'Notes & more']);
    assert.deepEqual(sheets[0]!.rows[1], [46313, 'ค่าไฟ', 1250.5]);
    assert.deepEqual(sheets[0]!.rows[2], [], 'an empty row keeps its place');
    assert.deepEqual(sheets[0]!.rows[3], [46314, 'กาแฟ & ขนม', 85, null, true]);
    assert.deepEqual(sheetItems(sheets[0]!), [
      { วันที่: 46313, รายการ: 'ค่าไฟ', ยอด: 1250.5, col4: null, col5: null },
      { วันที่: 46314, รายการ: 'กาแฟ & ขนม', ยอด: 85, col4: null, col5: true },
    ]);
  }
  assert.equal(excelDate(46313), '2026-10-18');
  assert.match(xlsxText(zip(WORKBOOK)), /## รายจ่าย\nวันที่\tรายการ\tยอด\n46313\tค่าไฟ\t1250\.5/);
  assert.throws(() => readXlsx(Buffer.from('not a zip')), /not a zip/);
});

test('extract_file and documentText read Excel; old .xls gets a clear message', async () => {
  const folder = path.join(tmp, 'allowed');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'bank.xlsx'), zip(WORKBOOK));
  fs.writeFileSync(path.join(folder, 'old.xls'), 'binary');
  const deps = { runAgent: async () => '', tool: () => undefined, speak: () => {}, mail: { list: async () => [], markRead: async () => {} }, state: new WorkflowState(path.join(tmp, 's.json')), allowedDirs: [folder] };
  const workflow = { name: 'f', agent: 'mimi', title: 'F', description: '', enabled: true, trigger: { pool: 'manual', config: {} }, webhook: null, nodes: [] };
  const first = await runWorkflowNode(workflow, { id: 'n1', type: 'extract_file', config: { path: 'bank.xlsx' }, links: { main: [] } }, [{ json: {} }], deps);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.outputs.main!.map((item) => item.json['รายการ']), ['ค่าไฟ', 'กาแฟ & ขนม']);
  const named = await runWorkflowNode(workflow, { id: 'n1', type: 'extract_file', config: { path: 'bank.xlsx', sheet: 'Notes & more', header: 'data' }, links: { main: [] } }, [{ json: {} }], deps);
  assert.deepEqual(named.outputs.main!.map((item) => item.json.col1), ['จดไว้']);
  const missing = await runWorkflowNode(workflow, { id: 'n1', type: 'extract_file', config: { path: 'bank.xlsx', sheet: 'nope' }, links: { main: [] } }, [{ json: {} }], deps);
  assert.match(missing.error!, /no sheet "nope".*รายจ่าย/);
  assert.match(await documentText(path.join(folder, 'bank.xlsx'), undefined), /ค่าไฟ/);
  await assert.rejects(documentText(path.join(folder, 'old.xls'), undefined), /old \.xls/);
  await assert.rejects(documentText(path.join(folder, 'scan.pdf'), undefined), /vision/);
});

test('mail attachments: listed, saved into the allowed folder with safe names', async () => {
  const folder = path.join(tmp, 'mail');
  const pdf = Buffer.from('%PDF-1.4 receipt');
  const google = {
    request: async (url: string) => {
      if (url.includes('/attachments/')) return { data: pdf.toString('base64url') };
      return {
        payload: {
          parts: [
            { mimeType: 'text/plain', body: { data: 'aGk' } },
            { filename: '../ใบเสร็จ:ตุลา.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A1', size: pdf.length } },
          ],
        },
      };
    },
  } as unknown as GoogleAuth;
  const microsoft = {
    request: async (url: string) =>
      url.endsWith('/attachments?$select=id,name,contentType,size')
        ? { value: [{ id: 'x', name: 'bill.png', contentType: 'image/png', size: 3 }] }
        : { contentBytes: Buffer.from('png').toString('base64') },
  } as unknown as MicrosoftAuth;
  const [gmail, outlook] = createMailAttachmentTools(google, microsoft);
  const context = { traceId: 't', thread: 'main', agent: 'tim', allowedDirs: [folder] };
  assert.equal(gmail!.risk, 'write', 'saving files is approved by the user');
  assert.match(String(await gmail!.execute({ id: 'm1' }, context, {})), /1\. \.\.\/ใบเสร็จ:ตุลา\.pdf \(application\/pdf/);
  const saved = String(await gmail!.execute({ id: 'm1', save: true }, context, {}));
  const file = path.join(folder, 'mail-attachments', 'gmail-m1', '_ใบเสร็จ_ตุลา.pdf');
  assert.match(saved, /Saved:/);
  assert.deepEqual(fs.readFileSync(file), pdf);
  assert.match(String(await outlook!.execute({ id: 'o1', save: true }, context, {})), /bill\.png/);
  assert.equal(safeFileName('..\\..\\evil<>.exe'), '_.._evil__.exe');
  assert.match(String(await gmail!.execute({ id: 'm1', save: true }, { ...context, allowedDirs: [] }, {})), /No allowed folder/);
});

test('rewind: files an agent wrote go back (overwritten restored, new deleted)', async () => {
  const folder = path.join(tmp, 'work');
  fs.mkdirSync(folder, { recursive: true });
  const notes = path.join(folder, 'notes.md');
  fs.writeFileSync(notes, 'เดิม');
  const snapshots = new FileSnapshots(openDb(':memory:'));
  const executor = new SnapshotExecutor(new LocalExecutor(), snapshots, { localPcTools: true });
  const context = (thread: string) => ({ traceId: 't1', thread, agent: 'mimi', allowedDirs: [folder] });
  const since = new Date(Date.now() - 1).toISOString();
  await executor.execute(writeFileTool, { path: 'notes.md', content: 'แก้ครั้งที่ 1' }, context('a'));
  await executor.execute(writeFileTool, { path: 'notes.md', content: 'แก้ครั้งที่ 2' }, context('a'));
  await executor.execute(writeFileTool, { path: 'new.md', content: 'ไฟล์ใหม่' }, context('a'));
  await executor.execute(writeFileTool, { path: 'other.md', content: 'อีกแชต' }, context('b'));
  assert.equal(fs.readFileSync(notes, 'utf8'), 'แก้ครั้งที่ 2');
  const result = snapshots.restoreSince('a', since);
  assert.deepEqual(result.restored.sort(), [path.join(folder, 'new.md'), notes].sort());
  assert.equal(fs.readFileSync(notes, 'utf8'), 'เดิม', 'back to before the first write');
  assert.equal(fs.existsSync(path.join(folder, 'new.md')), false, 'a file the agent created is removed');
  assert.equal(fs.readFileSync(path.join(folder, 'other.md'), 'utf8'), 'อีกแชต', 'another chat is untouched');
  assert.deepEqual(snapshots.restoreSince('a', since), { restored: [], skipped: [] }, 'nothing twice');
});
