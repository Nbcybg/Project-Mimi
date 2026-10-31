import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { accountOf, accountSetting } from '../oauth/settings.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { mimeOf } from '../tools/mime.ts';
import { allowedPath } from '../workflows/file-nodes.ts';
import { microsoftAuthResolver, type MicrosoftAuthSource } from './auth.ts';

const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-ndjson))/;
const READ_LIMIT_BYTES = 512 * 1024;
const OUTPUT_LIMIT = 12_000;

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { path?: string };
}

function itemLine(item: DriveItem): string {
  const kind = item.folder ? `folder (${item.folder.childCount ?? 0} items)` : (item.file?.mimeType ?? 'file');
  const size = item.size !== undefined ? ` · ${Math.round(item.size / 1024)} KB` : '';
  const when = item.lastModifiedDateTime ? ` · ${item.lastModifiedDateTime.slice(0, 16)}` : '';
  return `[id ${item.id}] ${item.name ?? '(no name)'} · ${kind}${size}${when}`;
}

/**
 * OneDrive through Microsoft Graph. Files are written by other people (and by the
 * user), so the reading tools are untrusted input: an agent that has them cannot
 * also have a shell.
 */
export function createDriveTools(source: MicrosoftAuthSource): ToolDefinition<any>[] {
  const resolve = microsoftAuthResolver(source);
  const client = (settings?: { account?: unknown }) => resolve(accountOf(settings));

  const onedriveSearch = defineTool({
    name: 'onedrive_search',
    description: 'Search the user\'s OneDrive by file or folder name. Returns id, name, type, size and modified time per item.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().positive().max(25).optional(),
    }),
    summarize: (input) => `Search OneDrive: ${input.query}`,
    async execute(input, _context, settings) {
      const found = await client(settings).request<{ value?: DriveItem[] }>(
        `/me/drive/root/search(q='${encodeURIComponent(input.query.replaceAll("'", "''"))}')?$top=${input.max_results ?? 10}&$select=id,name,size,webUrl,lastModifiedDateTime,file,folder`,
      );
      if (!found.value?.length) return 'No files match.';
      return found.value.map(itemLine).join('\n');
    },
  });

  const onedriveList = defineTool({
    name: 'onedrive_list',
    description:
      'List the files and folders in a OneDrive folder. Without a path it lists the root; use a path like "Documents/Projects" otherwise.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      path: z.string().optional().describe('Folder path from the OneDrive root, e.g. "Documents/Projects"'),
      max_results: z.number().int().positive().max(50).optional(),
    }),
    summarize: (input) => (input.path ? `List OneDrive folder ${input.path}` : 'List the OneDrive root'),
    async execute(input, _context, settings) {
      const base = input.path?.trim()
        ? `/me/drive/root:/${input.path
            .split('/')
            .filter(Boolean)
            .map(encodeURIComponent)
            .join('/')}:/children`
        : '/me/drive/root/children';
      const found = await client(settings).request<{ value?: DriveItem[] }>(
        `${base}?$top=${input.max_results ?? 25}&$select=id,name,size,webUrl,lastModifiedDateTime,file,folder&$orderby=name`,
      );
      if (!found.value?.length) return '(this folder is empty)';
      return found.value.map(itemLine).join('\n');
    },
  });

  const onedriveRead = defineTool({
    name: 'onedrive_read',
    description:
      'Read a file from OneDrive (id from onedrive_search or onedrive_list). Text-like files come back as text; other types show their metadata and download link.',
    risk: 'read',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      item_id: z.string().min(1),
    }),
    summarize: (input) => `Read OneDrive file ${input.item_id}`,
    async execute(input, context, settings) {
      const auth = client(settings);
      const item = await auth.request<DriveItem>(
        `/me/drive/items/${encodeURIComponent(input.item_id)}?$select=id,name,size,webUrl,file,folder,lastModifiedDateTime,parentReference`,
      );
      if (item.folder) return `${itemLine(item)}\n(this is a folder; use onedrive_list)`;
      const mime = item.file?.mimeType ?? '';
      if (!TEXT_MIME.test(mime) && mime !== 'application/octet-stream') {
        return `${itemLine(item)}${item.webUrl ? `\n${item.webUrl}` : ''}`;
      }
      if ((item.size ?? 0) > READ_LIMIT_BYTES) {
        return `${itemLine(item)}\n(too large to read here; open it with the link${item.webUrl ? `: ${item.webUrl}` : ''})`;
      }
      const response = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(item.id)}/content`, {
        headers: { authorization: `Bearer ${await auth.accessToken()}` },
        signal: context.signal,
      });
      if (!response.ok) throw new Error(`Microsoft Graph error ${response.status}: could not download the file`);
      const text = await response.text();
      return `${item.name ?? item.id}:\n${text.slice(0, OUTPUT_LIMIT)}${text.length > OUTPUT_LIMIT ? '\n… (truncated)' : ''}`;
    },
  });

  const onedriveUpload = defineTool({
    name: 'onedrive_upload',
    description:
      'Upload a file from the allowed folders to OneDrive. `destination` is a path from the OneDrive root ("Documents/report.pdf"); ending it with "/" keeps the local file name. Files up to 50 MB use the simple upload.',
    risk: 'write',
    target: 'core',
    settings: [accountSetting('microsoft')],
    inputSchema: z.object({
      path: z.string().min(1).describe('Local file inside the allowed folders'),
      destination: z.string().min(1).describe('OneDrive path, e.g. "Documents/2026/report.pdf"'),
      content_type: z.string().optional().describe('MIME type; inferred when omitted'),
    }),
    summarize: (input) => `Upload ${input.path} to OneDrive ${input.destination}`,
    async execute(input, context, settings) {
      const file = allowedPath(input.path, context.allowedDirs);
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`"${input.path}" is not a file.`);
      if (stat.size > 50 * 1024 * 1024) throw new Error('OneDrive simple upload stops at 50 MB.');
      const localName = path.basename(file);
      const remote = input.destination.endsWith('/') ? `${input.destination}${localName}` : input.destination;
      const encoded = remote.split('/').filter(Boolean).map(encodeURIComponent).join('/');
      const item = await client(settings).request<DriveItem>(`/me/drive/root:/${encoded}:/content`, {
        method: 'PUT',
        bodyBytes: await fs.readFile(file),
        headers: { 'content-type': input.content_type?.trim() || mimeOf(localName) },
      });
      return `Uploaded: ${itemLine(item)}${item.webUrl ? `\n${item.webUrl}` : ''}`;
    },
  });

  return [onedriveSearch, onedriveList, onedriveRead, onedriveUpload];
}
