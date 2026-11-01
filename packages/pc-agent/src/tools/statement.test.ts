import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  parseAmount,
  parseCsvStatement,
  parseOfxStatement,
  parseQifStatement,
  parseStatementDate,
  statementReadTool,
} from './statement.ts';
import { PathNotAllowedError } from './path-guard.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-statement-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const context = { traceId: 't', thread: 'th', agent: 'mimi', allowedDirs: [dir] };

test('statement money and dates: parentheses, separators, Thai and QIF orders', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount('(45.00)'), -45);
  assert.equal(parseAmount('45.00-'), -45);
  assert.equal(parseAmount('฿ 1,000.00'), 1000);
  assert.equal(parseAmount('-'), undefined);
  assert.equal(parseStatementDate('2026-02-01'), '2026-02-01');
  assert.equal(parseStatementDate('01/02/2026'), '2026-02-01');
  assert.equal(parseStatementDate('02/13/2026'), '2026-02-13');
  assert.equal(parseStatementDate('02/01/2026', 'mdy'), '2026-02-01');
  assert.equal(parseStatementDate('20260201'), '2026-02-01');
  assert.equal(parseStatementDate('1 Feb 2026'), '2026-02-01');
  assert.equal(parseStatementDate('31/02/2026'), undefined);
});

test('csv statements: quoted text, Thai headers, debit/credit and totals', async () => {
  const file = path.join(dir, 'bank.csv');
  fs.writeFileSync(
    file,
    `วันที่,รายละเอียด,เดบิต,เครดิต,คงเหลือ
01/02/2026,"กาแฟ, เช้า",50.00,,"1,950.00"
02/02/2026,เงินเดือน,,25000.00,"26,950.00"
`,
  );
  const result = JSON.parse(await statementReadTool.execute({ path: file }, context)) as {
    format: string;
    count: number;
    totals: { in: number; out: number; net: number };
    transactions: Array<{ date: string; description: string; amount: number; balance?: number }>;
  };
  assert.equal(result.format, 'csv');
  assert.equal(result.count, 2);
  assert.deepEqual(result.totals, { in: 25000, out: -50, net: 24950 });
  assert.equal(result.transactions[0]!.date, '2026-02-01');
  assert.equal(result.transactions[0]!.description, 'กาแฟ, เช้า');
  assert.equal(result.transactions[0]!.amount, -50);
  assert.equal(result.transactions[0]!.balance, 1950);
  assert.equal(result.transactions[1]!.amount, 25000);
});

test('ofx and qif statements are detected from their contents', async () => {
  const ofx = path.join(dir, 'bank.dat');
  fs.writeFileSync(
    ofx,
    `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>THB
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260201120000[+7:THB]<TRNAMT>-120.50<FITID>abc<NAME>Coffee</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260202<TRNAMT>500.00<NAME>Refund &amp; bonus</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`,
  );
  const ofxResult = JSON.parse(await statementReadTool.execute({ path: ofx }, context)) as {
    format: string;
    currency?: string;
    count: number;
    transactions: Array<{ date: string; amount: number; description: string; reference?: string }>;
  };
  assert.equal(ofxResult.format, 'ofx');
  assert.equal(ofxResult.currency, 'THB');
  assert.equal(ofxResult.count, 2);
  assert.equal(ofxResult.transactions[0]!.date, '2026-02-01');
  assert.equal(ofxResult.transactions[0]!.amount, -120.5);
  assert.equal(ofxResult.transactions[0]!.reference, 'abc');
  assert.equal(ofxResult.transactions[1]!.description, 'Refund & bonus');

  const qif = path.join(dir, 'card.qif');
  fs.writeFileSync(qif, `!Type:Bank\nD02/01/2026\nT-25.00\nPCoffee\n^\nD02/03/2026\nT1,200.00\nPClient\nMPayment\n^\n`);
  const qifResult = JSON.parse(await statementReadTool.execute({ path: qif }, context)) as {
    format: string;
    transactions: Array<{ date: string; amount: number; description: string }>;
  };
  assert.equal(qifResult.format, 'qif');
  assert.equal(qifResult.transactions.length, 2);
  assert.equal(qifResult.transactions[0]!.date, '2026-02-01');
  assert.equal(qifResult.transactions[1]!.amount, 1200);
  assert.equal(qifResult.transactions[1]!.description, 'Client');
});

test('statement limit keeps the newest rows and paths stay inside the allowed folders', async () => {
  const parsed = parseCsvStatement('date,description,amount\n2026-02-01,a,-1\n2026-02-02,b,2\n');
  assert.equal(parsed.transactions.length, 2);
  const file = path.join(dir, 'limit.csv');
  fs.writeFileSync(file, 'date,description,amount\n2026-02-01,a,-1\n2026-02-02,b,2\n');
  const result = JSON.parse(await statementReadTool.execute({ path: file, limit: 1 }, context)) as {
    count: number;
    returned: number;
    transactions: Array<{ description: string }>;
  };
  assert.equal(result.count, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.transactions[0]!.description, 'b');

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-statement-outside-'));
  try {
    const other = path.join(outside, 'x.csv');
    fs.writeFileSync(other, 'date,description,amount\n2026-02-01,a,1\n');
    await assert.rejects(statementReadTool.execute({ path: other }, context), PathNotAllowedError);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('statement parsers skip rows they cannot read', () => {
  const ofx = parseOfxStatement('<STMTTRN><DTPOSTED>20260101<TRNAMT>oops<NAME>x</STMTTRN>');
  assert.equal(ofx.transactions.length, 0);
  assert.equal(ofx.skipped, 1);
  const qif = parseQifStatement('D13/45/2026\nT5\nPBad\n^\n');
  assert.equal(qif.transactions.length, 0);
  assert.equal(qif.skipped, 1);
});
