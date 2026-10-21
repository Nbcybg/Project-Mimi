import { z } from 'zod';
import { accountOf, accountSetting } from '../oauth/settings.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { googleAuthResolver, type GoogleAuthSource } from './auth.ts';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const CELL_LIMIT = 500;

/** The spreadsheet may be given as its id or as the whole URL copied from the browser. */
export function spreadsheetId(raw: unknown): string {
  const value = String(raw ?? '').trim();
  const match = /\/spreadsheets\/d\/([\w-]+)/.exec(value);
  return match ? match[1]! : value;
}

function render(rows: Array<Array<string | number | boolean>>): string {
  const lines = rows.slice(0, CELL_LIMIT).map((row) => row.map((cell) => String(cell)).join('\t'));
  const extra = rows.length > CELL_LIMIT ? `\n… (${rows.length - CELL_LIMIT} more rows)` : '';
  return lines.join('\n') + extra;
}

interface ValueRange {
  range?: string;
  values?: Array<Array<string | number | boolean>>;
}
interface SpreadsheetInfo {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
}
interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
}

const cell = z.union([z.string(), z.number(), z.boolean()]);
const grid = z.array(z.array(cell)).min(1).describe('Rows of cells, e.g. [["January", 1200], ["February", 900]]');

/**
 * Google Sheets and Drive. The spreadsheet is a *setting*: an agent usually gets a
 * preset (e.g. "manager_sheet") that already knows which file to work in, and the model
 * only provides the range and values. Sheet content is untrusted input.
 */
export function createSheetTools(source: GoogleAuthSource): ToolDefinition<any>[] {
  const resolve = googleAuthResolver(source);
  const client = (settings?: { account?: unknown }) => resolve(accountOf(settings));
  const file = (settings: { spreadsheetId?: unknown } | undefined): string => {
    const id = spreadsheetId(settings?.spreadsheetId);
    if (!id) throw new Error('This tool needs its "Spreadsheet" setting: make a tool preset on the Tools screen and give the agent that.');
    return id;
  };

  const sheetsRead = defineTool({
    name: 'sheets_read',
    description:
      'Read a range from the configured Google spreadsheet. Give the range the way Sheets shows it, e.g. "Sheet1!A1:D20" or just "A1:D20" for the first tab.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [
      { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true, placeholder: 'ID or https://docs.google.com/spreadsheets/d/…' },
      accountSetting('google'),
    ],
    inputSchema: z.object({
      range: z.string().min(1).describe('e.g. Sheet1!A1:D20'),
    }),
    summarize: (input) => `Read spreadsheet range ${input.range}`,
    async execute(input, _context, settings) {
      const found = await client(settings).request<ValueRange>(`${SHEETS}/${file(settings)}/values/${encodeURIComponent(input.range)}`);
      if (!found.values?.length) return `(${found.range ?? input.range} is empty)`;
      return `${found.range ?? input.range}:\n${render(found.values)}`;
    },
  });

  const sheetsWrite = defineTool({
    name: 'sheets_write',
    description: 'Replace the cells of a range in the configured Google spreadsheet with new rows (values, not formulas).',
    risk: 'write',
    target: 'core',
    settings: [
      { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true, placeholder: 'ID or https://docs.google.com/spreadsheets/d/…' },
      accountSetting('google'),
    ],
    inputSchema: z.object({
      range: z.string().min(1).describe('e.g. Sheet1!A1:B2'),
      values: grid,
    }),
    summarize: (input) => `Write ${input.values.length} row(s) to ${input.range}`,
    async execute(input, _context, settings) {
      const result = await client(settings).request<{ updatedRange?: string; updatedCells?: number }>(
        `${SHEETS}/${file(settings)}/values/${encodeURIComponent(input.range)}?valueInputOption=USER_ENTERED`,
        { method: 'PUT', body: { values: input.values } },
      );
      return `Updated ${result.updatedCells ?? 0} cell(s) in ${result.updatedRange ?? input.range}.`;
    },
  });

  const sheetsAppend = defineTool({
    name: 'sheets_append',
    description: 'Append rows after the last row of a table in the configured Google spreadsheet, e.g. to add a new expense or log line.',
    risk: 'write',
    target: 'core',
    settings: [
      { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true, placeholder: 'ID or https://docs.google.com/spreadsheets/d/…' },
      accountSetting('google'),
    ],
    inputSchema: z.object({
      range: z.string().min(1).describe('The sheet or table to append to, e.g. Sheet1!A1 or "Expenses"'),
      values: grid,
    }),
    summarize: (input) => `Append ${input.values.length} row(s) to ${input.range}`,
    async execute(input, _context, settings) {
      const result = await client(settings).request<{ updates?: { updatedRange?: string; updatedCells?: number } }>(
        `${SHEETS}/${file(settings)}/values/${encodeURIComponent(input.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: { values: input.values } },
      );
      return `Appended ${input.values.length} row(s) at ${result.updates?.updatedRange ?? input.range}.`;
    },
  });

  const sheetsInfo = defineTool({
    name: 'sheets_info',
    description: 'Show the title and the tab names of the configured Google spreadsheet. Call this first when unsure which tabs exist.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [
      { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true, placeholder: 'ID or https://docs.google.com/spreadsheets/d/…' },
      accountSetting('google'),
    ],
    inputSchema: z.object({}),
    summarize: () => 'Show the spreadsheet info',
    async execute(_input, _context, settings) {
      const info = await client(settings).request<SpreadsheetInfo>(`${SHEETS}/${file(settings)}?fields=properties.title,sheets.properties`);
      const tabs = (info.sheets ?? []).map((sheet) => sheet.properties?.title ?? '?');
      return `${info.properties?.title ?? '(untitled)'}\ntabs: ${tabs.join(', ') || '(none)'}`;
    },
  });

  const driveSearch = defineTool({
    name: 'drive_search',
    description:
      'Search the user\'s Google Drive. Accepts plain words or a Drive query (e.g. "name contains \'report\'", "mimeType = \'application/vnd.google-apps.spreadsheet\'"). Returns id, name and type per file.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('google')],
    inputSchema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().positive().max(25).optional(),
    }),
    summarize: (input) => `Search Drive: ${input.query}`,
    async execute(input, _context, settings) {
      const raw = input.query.trim();
      const q = /[=<>]|contains/i.test(raw) ? raw : `fullText contains '${raw.replaceAll("'", '')}'`;
      const found = await client(settings).request<{ files?: DriveFile[] }>(
        `${DRIVE}?q=${encodeURIComponent(q)}&pageSize=${input.max_results ?? 10}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc`,
      );
      if (!found.files?.length) return 'No files match.';
      return found.files
        .map((entry) => `[id ${entry.id}] ${entry.name ?? '(no name)'} · ${entry.mimeType ?? '?'}${entry.modifiedTime ? ` · ${entry.modifiedTime}` : ''}`)
        .join('\n');
    },
  });

  return [sheetsInfo, sheetsRead, sheetsWrite, sheetsAppend, driveSearch];
}
