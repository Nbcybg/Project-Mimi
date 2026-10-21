import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { googleAuthResolver, type GoogleAuthSource } from '../google/auth.ts';
import { microsoftAuthResolver, type MicrosoftAuthSource } from '../microsoft/auth.ts';
import { accountOf, accountSetting } from '../oauth/settings.ts';
import { defineTool, type ToolDefinition } from './registry.ts';

/**
 * Mail attachments: list them, or save them into the first allowed folder
 * (`mail-attachments/<source>-<message id>/`) where read_document and workflows can
 * read them. Saving writes files, so the user approves it.
 */

const MAX_BYTES = 25 * 1024 * 1024;

interface Attachment {
  name: string;
  mime: string;
  size: number;
  /** Fetches the bytes (only when saving). */
  load(): Promise<Buffer>;
}

/** A file name that is safe on Windows and cannot climb out of its folder. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 150);
  return cleaned || 'attachment';
}

async function saveAll(attachments: Attachment[], folder: string, only?: string): Promise<string[]> {
  const picked = only ? attachments.filter((attachment) => attachment.name.toLowerCase().includes(only.toLowerCase())) : attachments;
  if (picked.length === 0) return [];
  fs.mkdirSync(folder, { recursive: true });
  const saved: string[] = [];
  for (const attachment of picked) {
    if (attachment.size > MAX_BYTES) {
      saved.push(`(skipped ${attachment.name}: over 25 MB)`);
      continue;
    }
    const data = await attachment.load();
    const target = path.join(folder, safeFileName(attachment.name));
    fs.writeFileSync(target, data);
    saved.push(target);
  }
  return saved;
}

function describe(attachments: Attachment[]): string {
  if (attachments.length === 0) return 'This message has no attachments.';
  return attachments.map((attachment, index) => `${index + 1}. ${attachment.name} (${attachment.mime}, ${Math.ceil(attachment.size / 1024)} KB)`).join('\n');
}

const input = z.object({
  id: z.string().min(1).describe('Message id (from the search / read tool)'),
  save: z.boolean().optional().describe('true = save them to the allowed folder so read_document can open them'),
  only: z.string().optional().describe('Save only attachments whose name contains this'),
});

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export function createMailAttachmentTools(googleSource: GoogleAuthSource, microsoftSource: MicrosoftAuthSource): ToolDefinition[] {
  const resolveGoogle = googleAuthResolver(googleSource);
  const resolveMicrosoft = microsoftAuthResolver(microsoftSource);
  const gmail = defineTool({
    name: 'gmail_attachments',
    description: 'List the attachments of a Gmail message, or save them (save: true) into the allowed folder so read_document can read them (receipts, invoices, PDFs, images).',
    risk: 'write',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('google')],
    inputSchema: input,
    summarize: (args) => `${args.save ? 'Save' : 'List'} attachments of Gmail message ${args.id}`,
    async execute(args, context, settings) {
      const google = resolveGoogle(accountOf(settings));
      const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
      const message = await google.request<{ payload?: GmailPart }>(`${base}/${encodeURIComponent(args.id)}?format=full`);
      const attachments: Attachment[] = [];
      const walk = (part: GmailPart | undefined) => {
        if (!part) return;
        if (part.filename && part.body?.attachmentId) {
          const attachmentId = part.body.attachmentId;
          attachments.push({
            name: part.filename,
            mime: part.mimeType ?? 'application/octet-stream',
            size: part.body.size ?? 0,
            load: async () => {
              const body = await google.request<{ data: string }>(`${base}/${encodeURIComponent(args.id)}/attachments/${encodeURIComponent(attachmentId)}`);
              return Buffer.from(body.data, 'base64url');
            },
          });
        }
        for (const child of part.parts ?? []) walk(child);
      };
      walk(message.payload);
      if (!args.save) return describe(attachments);
      if (context.allowedDirs.length === 0) return 'No allowed folder is set, so attachments cannot be saved. Ask the user to add one in Settings.';
      const saved = await saveAll(attachments, path.join(context.allowedDirs[0]!, 'mail-attachments', `gmail-${safeFileName(args.id)}`), args.only);
      return saved.length ? `Saved:\n${saved.join('\n')}` : 'Nothing matched to save.';
    },
  });

  const outlook = defineTool({
    name: 'outlook_attachments',
    description: 'List the attachments of an Outlook message, or save them (save: true) into the allowed folder so read_document can read them.',
    risk: 'write',
    target: 'core',
    untrustedInput: true,
    settings: [accountSetting('microsoft')],
    inputSchema: input,
    summarize: (args) => `${args.save ? 'Save' : 'List'} attachments of Outlook message ${args.id}`,
    async execute(args, context, settings) {
      const microsoft = resolveMicrosoft(accountOf(settings));
      const list = await microsoft.request<{ value?: Array<{ id: string; name?: string; contentType?: string; size?: number; '@odata.type'?: string }> }>(
        `/me/messages/${encodeURIComponent(args.id)}/attachments?$select=id,name,contentType,size`,
      );
      const attachments: Attachment[] = (list.value ?? [])
        .filter((entry) => entry['@odata.type'] === undefined || entry['@odata.type'] === '#microsoft.graph.fileAttachment')
        .map((entry) => ({
          name: entry.name ?? 'attachment',
          mime: entry.contentType ?? 'application/octet-stream',
          size: entry.size ?? 0,
          load: async () => {
            const full = await microsoft.request<{ contentBytes?: string }>(`/me/messages/${encodeURIComponent(args.id)}/attachments/${encodeURIComponent(entry.id)}`);
            return Buffer.from(full.contentBytes ?? '', 'base64');
          },
        }));
      if (!args.save) return describe(attachments);
      if (context.allowedDirs.length === 0) return 'No allowed folder is set, so attachments cannot be saved. Ask the user to add one in Settings.';
      const saved = await saveAll(attachments, path.join(context.allowedDirs[0]!, 'mail-attachments', `outlook-${safeFileName(args.id).slice(0, 40)}`), args.only);
      return saved.length ? `Saved:\n${saved.join('\n')}` : 'Nothing matched to save.';
    },
  });
  return [gmail as ToolDefinition, outlook as ToolDefinition];
}
