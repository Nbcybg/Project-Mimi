import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineTool } from '@mimi/shared';
import { resolveAllowedPath } from './path-guard.ts';

export type StatementFormat = 'csv' | 'ofx' | 'qif';

export interface StatementTransaction {
  date: string;
  description: string;
  /** Positive is money in, negative is money out. */
  amount: number;
  balance?: number;
  reference?: string;
}

export interface ParsedStatement {
  format: StatementFormat;
  transactions: StatementTransaction[];
  skipped: number;
  currency?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TRANSACTIONS = 5_000;

/** Reads "1,234.50", "(45.00)", "45.00-" and Thai statements into a number. */
export function parseAmount(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  let text = raw.replace(/\u00a0/g, ' ').trim();
  if (!text) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-\s*$/.test(text)) {
    negative = !negative;
    text = text.replace(/-\s*$/, '');
  }
  text = text.replace(/[^\d.,+-]/g, '');
  if (!text || text === '-' || text === '+') return undefined;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    text = lastComma > lastDot ? text.replaceAll('.', '').replace(',', '.') : text.replaceAll(',', '');
  } else if (lastComma > -1) {
    const decimals = text.length - lastComma - 1;
    text = decimals > 0 && decimals <= 2 ? text.replace(',', '.') : text.replaceAll(',', '');
  }
  if ((text.match(/\./g) ?? []).length > 1) {
    const index = text.lastIndexOf('.');
    text = text.slice(0, index).replaceAll('.', '') + text.slice(index);
  }
  let value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  if (negative) value = -Math.abs(value);
  return value;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Bank dates are usually day-first; pass "mdy" for QIF files. */
export function parseStatementDate(raw: string, order: 'dmy' | 'mdy' = 'dmy'): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/.exec(text);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    let day: number;
    let month: number;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (second > 12 && first <= 12) {
      month = first;
      day = second;
    } else if (order === 'mdy') {
      month = first;
      day = second;
    } else {
      day = first;
      month = second;
    }
    return isoDate(year, month, day);
  }
  match = /^(\d{1,2})\s+([A-Za-z]{3,9})[,]?\s+(\d{2,4})/.exec(text);
  if (match && MONTHS[match[2]!.toLowerCase()]) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return isoDate(year, MONTHS[match[2]!.toLowerCase()]!, Number(match[1]));
  }
  match = /^([A-Za-z]{3,9})\s+(\d{1,2})[,]?\s+(\d{2,4})/.exec(text);
  if (match && MONTHS[match[1]!.toLowerCase()]) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return isoDate(year, MONTHS[match[1]!.toLowerCase()]!, Number(match[2]));
  }
  return undefined;
}

function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === '') quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

export function csvDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  let best = ',';
  let bestCount = 0;
  for (const delimiter of [',', ';', '\t']) {
    const count = sample.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

const HEADER_ALIASES: Record<string, string[]> = {
  date: ['date', 'transactiondate', 'posteddate', 'valuedate', 'valdate', 'วันที่', 'วันที่ทำรายการ', 'วันที่เดินบัญชี'],
  description: ['description', 'details', 'detail', 'narrative', 'memo', 'payee', 'transaction', 'รายละเอียด', 'รายการ', 'คำอธิบาย', 'ชื่อรายการ'],
  amount: ['amount', 'transactionamount', 'จำนวนเงิน', 'ยอดเงิน', 'มูลค่า'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'debitamount', 'ถอน', 'เดบิต', 'รายจ่าย', 'จำนวนเงินออก'],
  credit: ['credit', 'deposit', 'deposits', 'creditamount', 'ฝาก', 'เครดิต', 'รายรับ', 'จำนวนเงินเข้า'],
  balance: ['balance', 'runningbalance', 'คงเหลือ', 'ยอดคงเหลือ'],
  currency: ['currency', 'สกุลเงิน'],
  reference: ['reference', 'ref', 'referenceid', 'fitid', 'transactionid', 'เลขที่รายการ', 'รหัสอ้างอิง'],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_():-]/g, '');
}

function columnIndex(header: string[], key: string): number {
  const names = HEADER_ALIASES[key]!.map(normalizeHeader);
  return header.findIndex((cell) => names.includes(normalizeHeader(cell)));
}

function looksLikeHeader(row: string[]): boolean {
  const date = columnIndex(row, 'date');
  const amount = columnIndex(row, 'amount');
  const debit = columnIndex(row, 'debit');
  const credit = columnIndex(row, 'credit');
  return date > -1 && (amount > -1 || debit > -1 || credit > -1);
}

export function parseCsvStatement(text: string): ParsedStatement {
  const rows = splitRows(text, csvDelimiter(text));
  const transactions: StatementTransaction[] = [];
  let skipped = 0;
  let currency: string | undefined;
  if (rows.length === 0) return { format: 'csv', transactions, skipped, ...(currency ? { currency } : {}) };
  const header = looksLikeHeader(rows[0]!) ? rows.shift()! : undefined;
  const columns = header
    ? {
        date: columnIndex(header, 'date'),
        description: columnIndex(header, 'description'),
        amount: columnIndex(header, 'amount'),
        debit: columnIndex(header, 'debit'),
        credit: columnIndex(header, 'credit'),
        balance: columnIndex(header, 'balance'),
        currency: columnIndex(header, 'currency'),
        reference: columnIndex(header, 'reference'),
      }
    : undefined;
  const cell = (row: string[], index: number | undefined): string => (index !== undefined && index > -1 ? (row[index] ?? '').trim() : '');

  for (const row of rows) {
    let dateText: string;
    let description: string;
    let amount: number | undefined;
    let balance: number | undefined;
    let reference: string;
    if (columns) {
      dateText = cell(row, columns.date);
      description = cell(row, columns.description);
      balance = parseAmount(cell(row, columns.balance));
      reference = cell(row, columns.reference);
      if (columns.amount > -1) amount = parseAmount(cell(row, columns.amount));
      else {
        const debit = parseAmount(cell(row, columns.debit));
        const credit = parseAmount(cell(row, columns.credit));
        if (debit !== undefined || credit !== undefined) amount = (credit ?? 0) - Math.abs(debit ?? 0);
      }
      if (!currency) currency = cell(row, columns.currency) || undefined;
    } else {
      const cells = row.map((entry) => entry.trim());
      dateText = cells[0] ?? '';
      description = cells[1] ?? '';
      if (cells.length >= 5) {
        const debit = parseAmount(cells[2]);
        const credit = parseAmount(cells[3]);
        amount = debit !== undefined || credit !== undefined ? (credit ?? 0) - Math.abs(debit ?? 0) : parseAmount(cells[2]);
        balance = parseAmount(cells[4]);
      } else if (cells.length === 4) {
        const debit = parseAmount(cells[2]);
        const credit = parseAmount(cells[3]);
        amount = debit !== undefined || credit !== undefined ? (credit ?? 0) - Math.abs(debit ?? 0) : undefined;
      } else {
        amount = parseAmount(cells[2]);
      }
      reference = '';
    }
    const date = parseStatementDate(dateText);
    if (!date || amount === undefined || !description) {
      skipped++;
      continue;
    }
    transactions.push({
      date,
      description: description.replace(/\s+/g, ' ').slice(0, 300),
      amount: Math.round(amount * 100) / 100,
      ...(balance !== undefined ? { balance } : {}),
      ...(reference ? { reference } : {}),
    });
    if (transactions.length >= MAX_TRANSACTIONS) break;
  }
  return { format: 'csv', transactions, skipped, ...(currency ? { currency } : {}) };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function ofxTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
  return match ? decodeEntities(match[1]!.trim()) : '';
}

export function parseOfxStatement(text: string): ParsedStatement {
  const transactions: StatementTransaction[] = [];
  let skipped = 0;
  const currency = ofxTag(text, 'CURDEF') || undefined;
  const parts = text.split(/<STMTTRN>/i).slice(1);
  for (const part of parts) {
    const block = part.split(/<\/STMTTRN>/i)[0]!.split(/<\/BANKTRANLIST>/i)[0]!;
    const amount = parseAmount(ofxTag(block, 'TRNAMT'));
    const date = parseStatementDate(ofxTag(block, 'DTPOSTED'));
    const description = ofxTag(block, 'NAME') || ofxTag(block, 'MEMO') || ofxTag(block, 'TRNTYPE') || 'OFX transaction';
    const reference = ofxTag(block, 'FITID');
    if (amount === undefined || !date) {
      skipped++;
      continue;
    }
    transactions.push({
      date,
      description: description.replace(/\s+/g, ' ').slice(0, 300),
      amount: Math.round(amount * 100) / 100,
      ...(reference ? { reference } : {}),
    });
    if (transactions.length >= MAX_TRANSACTIONS) break;
  }
  return { format: 'ofx', transactions, skipped, ...(currency ? { currency } : {}) };
}

export function parseQifStatement(text: string): ParsedStatement {
  const transactions: StatementTransaction[] = [];
  let skipped = 0;
  let dateText = '';
  let amountText = '';
  let payee = '';
  let memo = '';
  let reference = '';
  const flush = () => {
    if (!dateText && !amountText && !payee && !memo) return;
    const date = parseStatementDate(dateText, 'mdy');
    const amount = parseAmount(amountText);
    const description = payee || memo || 'QIF transaction';
    if (!date || amount === undefined) skipped++;
    else {
      transactions.push({
        date,
        description: description.replace(/\s+/g, ' ').slice(0, 300),
        amount: Math.round(amount * 100) / 100,
        ...(reference ? { reference } : {}),
      });
    }
    dateText = '';
    amountText = '';
    payee = '';
    memo = '';
    reference = '';
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === '^') {
      flush();
      continue;
    }
    const code = line[0];
    const value = line.slice(1).trim();
    if (code === 'D') dateText = value;
    else if (code === 'T') amountText = value;
    else if (code === 'P') payee = value;
    else if (code === 'M') memo = value;
    else if (code === 'N') reference = value;
  }
  flush();
  return { format: 'qif', transactions: transactions.slice(0, MAX_TRANSACTIONS), skipped };
}

export function detectStatementFormat(file: string, text: string): StatementFormat {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.ofx' || extension === '.qfx') return 'ofx';
  if (extension === '.qif') return 'qif';
  if (extension === '.csv' || extension === '.tsv' || extension === '.txt') return 'csv';
  if (/<OFX>|OFXHEADER/i.test(text)) return 'ofx';
  if (/^!Type:/im.test(text)) return 'qif';
  return 'csv';
}

export function parseStatement(text: string, format: StatementFormat): ParsedStatement {
  if (format === 'ofx') return parseOfxStatement(text);
  if (format === 'qif') return parseQifStatement(text);
  return parseCsvStatement(text);
}

export const statementReadTool = defineTool({
  name: 'statement_read',
  description:
    'Read a bank or card statement file (CSV/TSV, OFX/QFX or QIF) and return normalized transactions with money-in, money-out and net totals. Read-only: it never contacts a bank and never changes the file. Amounts are positive for money in and negative for money out.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Statement file inside the allowed folders'),
    format: z.enum(['auto', 'csv', 'ofx', 'qif']).optional().describe('Default auto, from the extension and contents'),
    limit: z.number().int().min(1).max(MAX_TRANSACTIONS).optional().describe('Newest rows to return (default 500)'),
  }),
  summarize: (input) => `Read statement ${path.basename(input.path)}`,
  async execute(input, context) {
    const file = resolveAllowedPath(input.path, context.allowedDirs);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`"${input.path}" is not a file.`);
    if (stat.size > MAX_BYTES) throw new Error(`That statement is ${(stat.size / 1024 / 1024).toFixed(1)} MB; this tool stops at 20 MB.`);
    const text = await fs.readFile(file, 'utf8');
    const format = input.format && input.format !== 'auto' ? input.format : detectStatementFormat(file, text);
    const parsed = parseStatement(text, format);
    if (parsed.transactions.length === 0) {
      throw new Error(`No transactions were found in "${path.basename(file)}" as ${format.toUpperCase()}. Check the format, or export the statement again.`);
    }
    const limit = input.limit ?? 500;
    const returned = parsed.transactions.slice(-limit);
    const moneyIn = parsed.transactions.filter((entry) => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
    const moneyOut = parsed.transactions.filter((entry) => entry.amount < 0).reduce((sum, entry) => sum + entry.amount, 0);
    const round = (value: number) => Math.round(value * 100) / 100;
    return JSON.stringify(
      {
        ok: true,
        file,
        format,
        ...(parsed.currency ? { currency: parsed.currency } : {}),
        count: parsed.transactions.length,
        returned: returned.length,
        skipped: parsed.skipped,
        totals: {
          in: round(moneyIn),
          out: round(moneyOut),
          net: round(moneyIn + moneyOut),
        },
        transactions: returned,
        summary: `${parsed.transactions.length} transaction(s): in ${round(moneyIn)}, out ${round(moneyOut)}, net ${round(moneyIn + moneyOut)}. Showing the newest ${returned.length}.`,
      },
      null,
      2,
    );
  },
});
