import fs from 'node:fs';
import { z } from 'zod';
import type { AttachmentStore } from '../chat/attachments.ts';
import type { StatusStore } from '../chat/state-store.ts';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { allowedPath, kindOfFile } from '../workflows/file-nodes.ts';
import type { GalleryStore } from './gallery-store.ts';

const MAX_RESULTS = 20;

/**
 * An agent's own situation gallery: look for a picture that fits the moment, lay it over
 * the chat (gallery_show) or take it away, and add pictures it made or was given. The
 * picture on show is the agent's `situation` status, so every client sees it at once.
 */
export function createGalleryTools(gallery: GalleryStore, status: StatusStore, attachments: AttachmentStore): ToolDefinition<any>[] {
  const search = defineTool({
    name: 'gallery_search',
    description:
      'Look through your situation gallery (pictures you may show over the chat, like the event pictures of a visual novel). Give a few words to match against titles, tags and descriptions; with no words you get the newest. Returns each picture\'s id, title, tags and description.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      query: z.string().optional().describe('Words to look for, e.g. "rain cafe"'),
      limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`Default 10, at most ${MAX_RESULTS}`),
    }),
    summarize: (input) => `Search gallery: ${input.query ?? '(newest)'}`,
    async execute(input, context) {
      const { total, items } = gallery.list(context.agent, { query: input.query, limit: input.limit ?? 10 });
      if (total === 0) return input.query ? `Nothing in your gallery matches "${input.query}".` : 'Your gallery is empty.';
      const lines = items.map((item) => `- ${item.id}: ${item.title}${item.tags.length ? ` [${item.tags.join(', ')}]` : ''}${item.description ? ` - ${item.description.slice(0, 160)}` : ''}`);
      return `${total} match${total === 1 ? '' : 'es'}${total > items.length ? `, showing ${items.length}` : ''}:\n${lines.join('\n')}`;
    },
  });

  const show = defineTool({
    name: 'gallery_show',
    description:
      'Lay one picture of your gallery over the chat, like an event picture in a visual novel. It stays until you show another or call gallery_hide; the user can also minimise or close it. Use it for a moment that deserves a picture, not for every message.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ id: z.string().min(1).describe('Picture id from gallery_search, e.g. g12') }),
    summarize: (input) => `Show gallery picture ${input.id}`,
    async execute(input, context) {
      const item = gallery.get(context.agent, input.id.trim());
      if (!item) throw new Error(`No picture "${input.id}" in your gallery. Use gallery_search to find ids.`);
      status.set(context.agent, 'situation', item.id);
      return `Showing ${item.id}: ${item.title}`;
    },
  });

  const hide = defineTool({
    name: 'gallery_hide',
    description: 'Take the picture you put over the chat away.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Hide the gallery picture',
    async execute(_input, context) {
      status.set(context.agent, 'situation', '');
      return 'The picture is hidden.';
    },
  });

  const add = defineTool({
    name: 'gallery_add',
    description:
      'Put a picture into your gallery so you can show it later. Give exactly one source: `attachment_id` (a picture in the chat, or one generate_image made) or `path` (an image in the allowed folders). Write a short title, tags and a description of the situation it fits - that text is how you find it again.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      attachment_id: z.string().optional().describe('Id of a picture already in the chat'),
      path: z.string().optional().describe('Image file in the allowed folders'),
      title: z.string().min(1).describe('Short name'),
      tags: z.array(z.string()).optional().describe('A few lowercase keywords'),
      description: z.string().optional().describe('When this picture fits'),
    }),
    summarize: (input) => `Add to gallery: ${input.title}`,
    async execute(input, context) {
      const sources = [input.attachment_id, input.path].filter((value) => value?.trim());
      if (sources.length !== 1) throw new Error('Give exactly one of attachment_id or path.');
      let data: Buffer;
      let mime: string;
      if (input.attachment_id?.trim()) {
        const source = attachments.get(input.attachment_id.trim());
        const bytes = source && attachments.read(source.id);
        if (!source || !bytes) throw new Error(`No file with attachment id "${input.attachment_id}".`);
        data = bytes;
        mime = source.mime;
      } else {
        const resolved = allowedPath(input.path!, context.allowedDirs);
        if (!fs.statSync(resolved).isFile()) throw new Error(`"${input.path}" is not a file.`);
        data = fs.readFileSync(resolved);
        mime = kindOfFile(resolved).mime;
      }
      const item = gallery.add(context.agent, { title: input.title, tags: input.tags, description: input.description, mime, data, source: 'agent' });
      return `Added to your gallery as ${item.id}: ${item.title}. Show it with gallery_show.`;
    },
  });

  return [search, show, hide, add];
}
