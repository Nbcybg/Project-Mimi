import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { accountOf, accountSetting } from '../oauth/settings.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { mimeOf } from '../tools/mime.ts';
import { allowedPath } from '../workflows/file-nodes.ts';
import { googleAuthResolver, type GoogleAuthSource } from './auth.ts';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
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
  description?: string;
  starred?: boolean;
  modifiedTime?: string;
}
interface DrivePermission {
  id: string;
  type?: string;
  role?: string;
  emailAddress?: string;
  domain?: string;
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

  const sheetsCreate = defineTool({
    name: 'sheets_create',
    description: 'Create a new Google spreadsheet in the user\'s Drive and return its id (use it in a "Spreadsheet" setting of a preset, or hand it to sheets_info / sheets_write).',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('google')],
    inputSchema: z.object({
      title: z.string().min(1).describe('The name of the new spreadsheet'),
      folder: z.string().optional().describe('Id of the Drive folder to put it in (from drive_search); default: the user\'s Drive root'),
    }),
    summarize: (input) => `Create spreadsheet "${input.title}"`,
    async execute(input, _context, settings) {
      const created = await client(settings).request<{ id: string }>(`${DRIVE}?fields=id`, {
        method: 'POST',
        body: {
          name: input.title,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          ...(input.folder ? { parents: [spreadsheetId(input.folder)] } : {}),
        },
      });
      return `Created spreadsheet "${input.title}" (id ${created.id}).\nhttps://docs.google.com/spreadsheets/d/${created.id}`;
    },
  });

  const sheetsDelete = defineTool({
    name: 'sheets_delete',
    description: 'Move a Google spreadsheet to the Drive trash (id from the "Spreadsheet" setting, or drive_search). The user must have confirmed; there is no undo.',
    risk: 'delete',
    target: 'core',
    settings: [
      { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: false, placeholder: 'ID or https://docs.google.com/spreadsheets/d/…' },
      accountSetting('google'),
    ],
    inputSchema: z.object({
      spreadsheetId: z.string().optional().describe('The spreadsheet to delete; the preset\'s "Spreadsheet" setting when left out'),
    }),
    summarize: (input) => `Delete spreadsheet ${input.spreadsheetId ?? '(configured)'}`,
    async execute(input, _context, settings) {
      const id = spreadsheetId(input.spreadsheetId ?? settings?.spreadsheetId);
      if (!id) throw new Error('Give the spreadsheet id, or make a preset with the "Spreadsheet" setting.');
      await client(settings).request(`${DRIVE}/${id}`, { method: 'DELETE' });
      return `Moved spreadsheet ${id} to the Drive trash.`;
    },
  });

  const driveUpload = defineTool({
    name: 'drive_upload',
    description:
      'Upload a file from the allowed folders to Google Drive. The account needs Drive access (the app requests the full drive scope); files the app uploads stay manageable by it. `folder` is a folder id from drive_search, or omit for My Drive.',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('google')],
    inputSchema: z.object({
      path: z.string().min(1).describe('Local file inside the allowed folders'),
      name: z.string().optional().describe('Name in Drive; defaults to the local file name'),
      folder: z.string().optional().describe('Drive folder id from drive_search'),
      mime_type: z.string().optional().describe('MIME type; inferred when omitted'),
    }),
    summarize: (input) => `Upload ${input.path} to Google Drive${input.name ? ` as ${input.name}` : ''}`,
    async execute(input, context, settings) {
      const file = allowedPath(input.path, context.allowedDirs);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`"${input.path}" is not a file.`);
      if (stat.size > 50 * 1024 * 1024) throw new Error('Drive uploads here stop at 50 MB.');
      const name = input.name?.trim() || path.basename(file);
      const metadata: Record<string, unknown> = { name, mimeType: input.mime_type?.trim() || mimeOf(name) };
      if (input.folder?.trim()) metadata.parents = [input.folder.trim()];
      const boundary = `mimi-${randomUUID()}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${String(metadata.mimeType)}\r\n\r\n`,
        'utf8',
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const body = Buffer.concat([head, await fs.readFile(file), tail]);
      const created = await client(settings).request<DriveFile>(
        `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,mimeType,modifiedTime`,
        {
          method: 'POST',
          bodyBytes: body,
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        },
      );
      return `Uploaded: [id ${created.id}] ${created.name ?? name} · ${created.mimeType ?? String(metadata.mimeType)}`;
    },
  });

  const driveShare = defineTool({
    name: 'drive_share',
    description:
      'Share a Google Drive file or folder (id from drive_search) with a person, a group, a domain, or anyone with the link. Full Drive access is needed for files the app did not create. Returns the permission id.',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('google')],
    inputSchema: z.object({
      file_id: z.string().min(1).describe('Drive file or folder id from drive_search'),
      type: z.enum(['user', 'group', 'domain', 'anyone']).optional().describe('Default user'),
      email: z.string().email().optional().describe('Required for type user or group'),
      domain: z.string().optional().describe('Required for type domain, e.g. example.com'),
      role: z.enum(['reader', 'commenter', 'writer']).optional().describe('Default reader'),
      notify: z.boolean().optional().describe('Send Google\'s share notification e-mail'),
      message: z.string().optional().describe('Note added to the notification'),
    }),
    summarize: (input) => {
      const target = input.type === 'anyone' ? 'anyone with the link' : input.type === 'domain' ? input.domain ?? 'a domain' : input.email ?? 'someone';
      return `Share Drive file ${input.file_id} with ${target} as ${input.role ?? 'reader'}`;
    },
    async execute(input, _context, settings) {
      const type = input.type ?? 'user';
      if ((type === 'user' || type === 'group') && !input.email?.trim()) throw new Error(`Sharing with a ${type} needs an e-mail address.`);
      if (type === 'domain' && !input.domain?.trim()) throw new Error('Sharing with a domain needs its name, e.g. example.com.');
      const role = input.role ?? 'reader';
      const body: Record<string, unknown> = {
        type,
        role,
        ...(input.email?.trim() ? { emailAddress: input.email.trim() } : {}),
        ...(type === 'domain' && input.domain?.trim() ? { domain: input.domain.trim() } : {}),
        ...(input.message?.trim() ? { emailMessage: input.message.trim() } : {}),
      };
      const notify = input.notify === true && (type === 'user' || type === 'group');
      const query = new URLSearchParams({ fields: 'id,type,role,emailAddress,domain', supportsAllDrives: 'true' });
      if (notify) query.set('sendNotificationEmail', 'true');
      const permission = await client(settings).request<DrivePermission>(
        `${DRIVE}/${encodeURIComponent(input.file_id)}/permissions?${query}`,
        { method: 'POST', body },
      );
      const who = permission.emailAddress ?? permission.domain ?? (permission.type === 'anyone' ? 'anyone with the link' : input.email ?? type);
      return `Shared ${input.file_id} with ${who} as ${permission.role ?? role} (permission ${permission.id}).`;
    },
  });

  const driveUpdate = defineTool({
    name: 'drive_update_metadata',
    description: 'Rename a Google Drive file or folder, or change its description or starred flag (id from drive_search). Only the fields you give are changed.',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('google')],
    inputSchema: z.object({
      file_id: z.string().min(1).describe('Drive file or folder id from drive_search'),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      starred: z.boolean().optional(),
    }),
    summarize: (input) => `Update Drive file ${input.file_id}${input.name ? ` -> ${input.name}` : ''}`,
    async execute(input, _context, settings) {
      const body: Record<string, unknown> = {};
      if (input.name !== undefined) body.name = input.name;
      if (input.description !== undefined) body.description = input.description;
      if (input.starred !== undefined) body.starred = input.starred;
      if (Object.keys(body).length === 0) throw new Error('Give at least one field to change: name, description or starred.');
      const updated = await client(settings).request<DriveFile>(
        `${DRIVE}/${encodeURIComponent(input.file_id)}?fields=id,name,mimeType,description,starred,modifiedTime&supportsAllDrives=true`,
        { method: 'PATCH', body },
      );
      return `Updated: [id ${updated.id}] ${updated.name ?? input.file_id}${updated.description ? ` — ${updated.description}` : ''}${updated.starred ? ' ★' : ''}${updated.modifiedTime ? ` · ${updated.modifiedTime}` : ''}`;
    },
  });

  return [
    sheetsInfo,
    sheetsRead,
    sheetsWrite,
    sheetsAppend,
    sheetsCreate,
    sheetsDelete,
    driveSearch,
    driveUpload,
    driveShare,
    driveUpdate,
  ];
}
