import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentView } from '@mimi/shared';
import { experimental_generateVideo, generateImage, generateSpeech, type ImageModel, type SpeechModel } from 'ai';
import { z } from 'zod';
import type { Attachment, AttachmentStore } from '../chat/attachments.ts';
import { MAX_ATTACHMENT_BYTES } from '../chat/attachments.ts';
import type { ModelInfo, ModelRef } from '../providers/registry.ts';
import type { MediaKind, ModelSelection, ModelService, VideoModel } from '../providers/routing.ts';
import type { UsageLogger } from '../usage/logger.ts';
import { allowedPath, kindOfFile } from '../workflows/file-nodes.ts';
import { assertPublicUrl } from '../workflows/net-guard.ts';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.ts';

/**
 * What an agent gives the user besides text: a file it has (send_file) or one it makes
 * (generate_image, text_to_speech, generate_video). Every file becomes a chat attachment
 * shown under the agent's message, and the tool's answer names its attachment id, so a
 * workflow can pass it on (the chat node's `files`).
 */
export interface MediaToolDeps {
  attachments: AttachmentStore;
  models: ModelService;
  usage: UsageLogger;
  /** The models an agent picked, per capability. */
  modelsOf(agent: string): ModelSelection;
  /** A message when today's spending limit is reached. */
  budgetCheck?: () => string | null;
  fetchFn?: typeof fetch;
}

const MAX_REDIRECTS = 3;

const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/pcm': 'pcm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** A file name for made media: a slug of the prompt plus the type's extension. */
export function mediaFileName(prompt: string, mime: string, fallback: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || fallback}.${EXTENSION[mime] ?? mime.split('/')[1]?.replace(/[^\w]/g, '') ?? 'bin'}`;
}

const viewOf = ({ id, kind, name, mime, size, text }: Attachment): AttachmentView => ({ id, kind, name, mime, size, text });

/** Model metadata for the usage log; a model the catalog does not list is logged without a price. */
function infoOf(models: ModelService, ref: ModelRef): ModelInfo {
  try {
    return models.info(ref);
  } catch {
    return {
      ref,
      name: ref.model,
      npm: '',
      baseURL: undefined,
      contextLimit: 0,
      outputLimit: undefined,
      cost: null,
      imageInput: false,
      toolCall: false,
      textOutput: false,
      options: {},
    };
  }
}

export function createMediaTools(deps: MediaToolDeps): ToolDefinition<any>[] {
  /** Stores a file as the agent's attachment, shows it in the chat, and says what was sent. */
  const deliver = (context: ToolContext, file: { name: string; mime: string; data: Buffer; text: string }): string => {
    const saved = deps.attachments.save(file);
    deps.attachments.setText(saved.id, file.text);
    if (context.messageId !== undefined) deps.attachments.link([saved.id], context.messageId);
    const attachment = deps.attachments.get(saved.id)!;
    context.emit?.({ type: 'attachment', attachment: viewOf(attachment) });
    return `Sent ${attachment.kind} "${attachment.name}" (${Math.ceil(attachment.size / 1024)} KB) to the chat; the user sees it under your message. attachment id: ${attachment.id}`;
  };

  /** The model an agent uses for a kind of media, ready to call. */
  const modelFor = async <T>(kind: MediaKind, context: ToolContext): Promise<{ model: T; ref: ModelRef }> => {
    const overBudget = deps.budgetCheck?.();
    if (overBudget) throw new Error(overBudget);
    const ref = deps.models.resolve(kind, deps.modelsOf(context.agent));
    if (!deps.models.mediaModel) throw new Error('Making media is not available here.');
    return { model: (await deps.models.mediaModel(kind, ref)) as T, ref };
  };

  const logMedia = (kind: MediaKind, ref: ModelRef, context: ToolContext, startedAt: number) =>
    deps.usage.logCall({
      runId: null,
      traceId: context.traceId,
      agent: context.agent,
      kind,
      model: infoOf(deps.models, ref),
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: Date.now() - startedAt,
    });

  /** Downloads a public link (no local network), following a few redirects by hand. */
  const download = async (url: string, signal?: AbortSignal): Promise<{ data: Buffer; mime: string; name: string }> => {
    const fetchFn = deps.fetchFn ?? fetch;
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new Error('Only http(s) links can be sent.');
      if (!deps.fetchFn) await assertPublicUrl(current.toString());
      const response = await fetchFn(current, { redirect: 'manual', signal: signal ?? AbortSignal.timeout(60_000) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`${current.host} answered HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_ATTACHMENT_BYTES) throw new Error('The file is larger than 25 MB.');
      const data = Buffer.from(await response.arrayBuffer());
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
      const name = decodeURIComponent(fromHeader ?? path.basename(current.pathname)) || 'download';
      return { data, mime: mime || kindOfFile(name).mime, name };
    }
    throw new Error('Too many redirects.');
  };

  const sendFile = defineTool({
    name: 'send_file',
    description:
      'Send a file to the user in this chat: a picture, audio, video or any document. Give exactly one source: `path` (a file in the allowed folders, e.g. one you wrote or a saved mail attachment), `attachment_id` (a file already in the chat, or one another tool made) or `url` (a public link, e.g. a picture or video a tool returned). The user sees it under your message; say in your reply what it is.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      path: z.string().optional().describe('File in the allowed folders'),
      attachment_id: z.string().optional().describe('Id of a file already in the chat'),
      url: z.string().optional().describe('Public http(s) link to download and send'),
      name: z.string().optional().describe('File name to show (optional)'),
    }),
    summarize: (input) => `Send ${input.path ?? input.url ?? input.attachment_id ?? '?'} to the chat`,
    async execute(input, context) {
      const sources = [input.path, input.attachment_id, input.url].filter((value) => value?.trim());
      if (sources.length !== 1) throw new Error('Give exactly one of path, attachment_id or url.');
      let file: { data: Buffer; mime: string; name: string };
      let text = '';
      if (input.path?.trim()) {
        const resolved = allowedPath(input.path, context.allowedDirs);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) throw new Error(`"${input.path}" is not a file.`);
        if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('The file is larger than 25 MB.');
        file = { data: fs.readFileSync(resolved), mime: kindOfFile(resolved).mime, name: path.basename(resolved) };
        // An unknown extension reads as "text"; say nothing about its type then.
        if (kindOfFile(resolved).kind === 'text' && !/\.(txt|md|csv|log)$/i.test(resolved)) file.mime = 'application/octet-stream';
      } else if (input.attachment_id?.trim()) {
        const source = deps.attachments.get(input.attachment_id.trim());
        const data = source && deps.attachments.read(source.id);
        if (!source || !data) throw new Error(`No file with attachment id "${input.attachment_id}".`);
        file = { data, mime: source.mime, name: source.name };
        text = source.text;
      } else {
        file = await download(input.url!.trim(), context.signal);
      }
      return deliver(context, { ...file, name: input.name?.trim() || file.name, text: text || `(sent by ${context.agent})` });
    },
  });

  const image = defineTool({
    name: 'generate_image',
    description:
      'Make a picture from a description and send it to the user in this chat (uses the agent\'s image model). Write the prompt in English for best results; describe subject, style, composition and any text to draw. Costs money per picture.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('What to draw'),
      aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe('Default 1:1'),
      count: z.number().int().min(1).max(4).optional().describe('How many pictures (default 1)'),
    }),
    summarize: (input) => `Make ${input.count ?? 1} picture(s): ${input.prompt.slice(0, 100)}`,
    async execute(input, context) {
      const { model, ref } = await modelFor<ImageModel>('image', context);
      const startedAt = Date.now();
      const result = await generateImage({
        model,
        prompt: input.prompt,
        n: input.count ?? 1,
        aspectRatio: (input.aspect_ratio ?? '1:1') as `${number}:${number}`,
        abortSignal: context.signal,
      });
      logMedia('image', ref, context, startedAt);
      if (result.images.length === 0) throw new Error('The image model returned no picture.');
      return result.images
        .map((made, index) =>
          deliver(context, {
            name: mediaFileName(input.prompt, made.mediaType, `image-${index + 1}`),
            mime: made.mediaType,
            data: Buffer.from(made.uint8Array),
            text: `Picture made from the prompt: ${input.prompt}`,
          }),
        )
        .join('\n');
    },
  });

  const speech = defineTool({
    name: 'text_to_speech',
    description:
      'Speak text aloud as an audio file and send it to the user in this chat (uses the agent\'s speech model). Use it when the user asks for a voice message or to hear something.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      text: z.string().min(1).max(5000).describe('What to say, in the language it should be spoken'),
      voice: z.string().optional().describe('Voice name of the speech model (optional)'),
      instructions: z.string().optional().describe('How to say it: tone, speed, emotion (optional)'),
    }),
    summarize: (input) => `Speak: ${input.text.slice(0, 100)}`,
    async execute(input, context) {
      const { model, ref } = await modelFor<SpeechModel>('speech', context);
      const startedAt = Date.now();
      const result = await generateSpeech({
        model,
        text: input.text,
        ...(input.voice ? { voice: input.voice } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        abortSignal: context.signal,
      });
      logMedia('speech', ref, context, startedAt);
      const mime = result.audio.mediaType || 'audio/wav';
      return deliver(context, {
        name: mediaFileName(input.text, mime, 'speech'),
        mime,
        data: Buffer.from(result.audio.uint8Array),
        text: input.text,
      });
    },
  });

  const video = defineTool({
    name: 'generate_video',
    description:
      'Make a short video from a description and send it to the user in this chat (uses the agent\'s video model). It can take several minutes and costs much more than a picture; use it only when the user asks for a video.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('What happens in the video, camera and style'),
      aspect_ratio: z.enum(['16:9', '9:16']).optional().describe('Default 16:9'),
      duration: z.number().int().min(2).max(10).optional().describe('Seconds (the model may round it)'),
    }),
    summarize: (input) => `Make a video: ${input.prompt.slice(0, 100)}`,
    async execute(input, context) {
      const { model, ref } = await modelFor<VideoModel>('video', context);
      const startedAt = Date.now();
      const result = await experimental_generateVideo({
        model,
        prompt: input.prompt,
        aspectRatio: (input.aspect_ratio ?? '16:9') as `${number}:${number}`,
        ...(input.duration ? { duration: input.duration } : {}),
        abortSignal: context.signal,
      });
      logMedia('video', ref, context, startedAt);
      const made = result.video;
      return deliver(context, {
        name: mediaFileName(input.prompt, made.mediaType, 'video'),
        mime: made.mediaType,
        data: Buffer.from(made.uint8Array),
        text: `Video made from the prompt: ${input.prompt}`,
      });
    },
  });

  return [sendFile, image, speech, video];
}
