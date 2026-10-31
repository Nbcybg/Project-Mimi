import type { TaskReceiptView, TaskVerificationView } from '@mimi/shared';
import { z } from 'zod';
import type { TaskRecipe, TaskStepContext } from './types.ts';
import { TaskStoppedError, parseToolJson } from './util.ts';

const inputSchema = z.object({
  path: z.string().min(1).describe('Video or audio file inside the allowed folders'),
  title: z.string().min(1).max(100),
  description: z.string().max(5_000).optional(),
  visibility: z.enum(['private', 'unlisted', 'public']).optional(),
  made_for_kids: z.boolean().optional(),
  tags: z.array(z.string().max(100)).max(30).optional(),
  audio_only: z.boolean().optional().describe('Mux the audio with a cover image into an MP4'),
  cover: z.string().optional().describe('Cover image for audio_only'),
  output: z.string().optional().describe('Muxed MP4 path for audio_only'),
});

type YouTubeInput = z.infer<typeof inputSchema>;

interface YouTubeState {
  upload?: string;
  url?: string;
  handoff?: string;
  visibility?: 'private' | 'unlisted' | 'public';
}

interface BrowserCheck {
  ok: boolean;
  url: string;
  title: string;
  handoff: { kind: string; detail: string } | null;
  summary: string;
}

const UPLOAD_URL = 'https://www.youtube.com/upload';

function refFor(text: string, pattern: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!pattern.test(line)) continue;
    const found = /\[(e\d+)\]/.exec(line);
    if (found) return found[1];
  }
  return undefined;
}

function isHandoff(text: string): boolean {
  return /^Handoff:/m.test(text) || /Do not try to bypass it/i.test(text);
}

async function check(context: TaskStepContext<YouTubeInput>): Promise<BrowserCheck> {
  return parseToolJson<BrowserCheck>(await context.runPc('browser_check', {}));
}

async function snapshot(context: TaskStepContext<YouTubeInput>): Promise<string> {
  return context.runPc('browser_snapshot', {});
}

async function clickLabel(context: TaskStepContext<YouTubeInput>, pattern: RegExp): Promise<boolean> {
  const page = await snapshot(context);
  const ref = refFor(page, pattern);
  if (!ref) return false;
  const result = await context.runPc('browser_click', { ref });
  if (isHandoff(result)) throw new TaskStoppedError('The page asked for the user; the upload stopped.');
  return true;
}

async function typeLabel(context: TaskStepContext<YouTubeInput>, pattern: RegExp, text: string): Promise<boolean> {
  const page = await snapshot(context);
  const ref = refFor(page, pattern);
  if (!ref) return false;
  const result = await context.runPc('browser_type', { ref, text, clear: true });
  if (isHandoff(result)) throw new TaskStoppedError('The page asked for the user; the upload stopped.');
  return true;
}

async function setVisibility(context: TaskStepContext<YouTubeInput>, visibility: 'private' | 'unlisted' | 'public'): Promise<boolean> {
  const label = visibility === 'private' ? /private|ส่วนตัว/i : visibility === 'public' ? /public|สาธารณะ/i : /unlisted|ไม่ระบุ/i;
  const page = await snapshot(context);
  const select = /\[(e\d+)\]\s+select\b.*visibility/i.exec(page) ?? /\[(e\d+)\]\s+select\b/i.exec(page);
  if (select) {
    try {
      const result = await context.runPc('browser_select', { ref: select[1], value: visibility });
      if (!isHandoff(result)) return true;
    } catch {
      // fall through to radio/button
    }
  }
  const radio = refFor(page, label);
  if (radio) {
    const result = await context.runPc('browser_click', { ref: radio });
    if (isHandoff(result)) throw new TaskStoppedError('The page asked for the user; the upload stopped.');
    return true;
  }
  // A visibility picker: open it and choose the option on the next snapshot.
  if (await clickLabel(context, /visibility|การมองเห็น/i)) {
    const next = await snapshot(context);
    const option = refFor(next, label);
    if (option) {
      const result = await context.runPc('browser_click', { ref: option });
      if (isHandoff(result)) throw new TaskStoppedError('The page asked for the user; the upload stopped.');
      return true;
    }
  }
  return false;
}

function videoUrl(text: string): string | undefined {
  const direct = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/i.exec(text);
  if (direct) return `https://youtu.be/${direct[1]}`;
  const studio = /\/video\/([\w-]{11})(?:\/|$)/i.exec(text);
  if (studio) return `https://youtu.be/${studio[1]}`;
  return undefined;
}

/**
 * Upload a video to YouTube through the assistant's own browser. The user signs in;
 * Mimi never types a password, OTP or CAPTCHA, and a public publish needs a second
 * explicit confirmation. The file and the browser are local; no YouTube API is used.
 */
export const youtubeUploadRecipe: TaskRecipe<YouTubeInput> = {
  name: 'youtube-upload',
  description:
    'Validate a local video, optionally mux audio with a cover, open YouTube upload, hand off login/2FA/CAPTCHA to the user, upload, fill title/description/visibility/audience, ask again before a public publish, verify the video URL and leave a receipt. No password is ever typed.',
  level: 'L3',
  inputSchema,
  interfaces: ['pc', 'browser'],
  steps: [
    {
      id: 'validate',
      title: 'Validate the file',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        const input = context.input;
        const visibility = input.visibility ?? 'unlisted';
        if (visibility !== 'private' && visibility !== 'unlisted' && visibility !== 'public') throw new Error('visibility must be private, unlisted or public.');
        state.visibility = visibility;
        if (!/\.(mp4|mov|mkv|webm|avi|mp3|wav|m4a|aac|flac)$/i.test(input.path)) {
          throw new Error('The file must be a video or audio file Mimi can upload.');
        }
        if (input.audio_only) {
          if (!input.cover) throw new Error('audio_only needs a cover image.');
          const output = input.output ?? input.path.replace(/\.[^.]+$/, '') + '.mp4';
          const muxed = parseToolJson<{ ok: boolean; output: string; summary: string }>(
            await context.runPc('media_mux_cover', { audio: input.path, cover: input.cover, output }),
          );
          if (!muxed.ok) throw new Error(muxed.summary || 'The cover could not be muxed.');
          state.upload = muxed.output;
        } else {
          state.upload = input.path;
        }
        const info = await context.runPc('file_info', { path: state.upload });
        if (!/type:\s*file/i.test(info)) throw new Error('The upload path is not a file.');
        return `${state.upload}: ${visibility}${input.audio_only ? ' (muxed with cover)' : ''}`;
      },
    },
    {
      id: 'confirm',
      title: 'Ask before uploading',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        const visibility = state.visibility ?? 'unlisted';
        const decision = await context.confirm({
          tool: 'browser_upload',
          risk: 'write',
          summary: `อัปโหลด "${context.input.title}" ไป YouTube เป็น ${visibility.toUpperCase()}${visibility === 'public' ? ' (เผยแพร่สาธารณะ)' : ''} — ไม่มีการพิมพ์รหัสผ่านแทนคุณ`,
          input: { path: state.upload, title: context.input.title, visibility },
        });
        if (!decision.allow) {
          throw new TaskStoppedError(
            decision.reason === 'timeout' ? 'The confirmation timed out; nothing was uploaded.' : 'The user did not approve the upload.',
          );
        }
        return 'Approved.';
      },
    },
    {
      id: 'open',
      title: 'Open YouTube upload',
      async run(context) {
        const page = await context.runPc('browser_open', { url: UPLOAD_URL });
        if (isHandoff(page)) {
          const status = await check(context);
          throw new TaskStoppedError(`${status.handoff?.detail ?? 'The user must sign in to YouTube.'} Ask the user to sign in in the Mimi browser, then run the task again.`);
        }
        const status = await check(context);
        if (status.handoff) {
          throw new TaskStoppedError(`${status.handoff.detail} Ask the user to complete it in the Mimi browser, then run the task again.`);
        }
        return `Opened ${status.url}`;
      },
    },
    {
      id: 'upload',
      title: 'Choose the file',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        let page = await snapshot(context);
        let fileRef = refFor(page, /input\(file\)/i);
        if (!fileRef && (await clickLabel(context, /select files|choose files|upload/i))) {
          page = await snapshot(context);
          fileRef = refFor(page, /input\(file\)/i);
        }
        if (!fileRef) throw new TaskStoppedError('No file input was found on YouTube. Ask the user to open the upload dialog in the Mimi browser and run the task again.');
        const uploaded = await context.runPc('browser_upload', { ref: fileRef, paths: [state.upload] });
        if (isHandoff(uploaded)) throw new TaskStoppedError('The page asked for the user; nothing else was uploaded.');
        return uploaded.slice(0, 1200);
      },
    },
    {
      id: 'details',
      title: 'Fill the details',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        await typeLabel(context, /title|ชื่อ/i, context.input.title);
        if (context.input.description) await typeLabel(context, /description|tell viewers|รายละเอียด/i, context.input.description);
        if (context.input.tags?.length) await typeLabel(context, /tags|แท็ก/i, context.input.tags.join(', '));
        const visibilitySet = await setVisibility(context, state.visibility ?? 'unlisted');
        if (context.input.made_for_kids !== undefined) {
          const pattern = context.input.made_for_kids ? /yes.*made for kids|made for kids.*yes|ใช่.*เด็ก/i : /no.*not made for kids|not made for kids.*no|ไม่ใช่.*เด็ก/i;
          await clickLabel(context, pattern);
        }
        return visibilitySet ? `Details filled; visibility ${state.visibility}.` : `Details filled; the visibility control was not found — the user must check ${state.visibility} before publishing.`;
      },
    },
    {
      id: 'publish-gate',
      title: 'Confirm a public publish',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        if (state.visibility !== 'public') return 'Not public; no publish gate.';
        const decision = await context.confirm({
          tool: 'browser_click',
          risk: 'write',
          summary: `ยืนยันเผยแพร่วิดีโอ "${context.input.title}" เป็น PUBLIC บน YouTube (ทุกคนเห็นได้)`,
          input: { title: context.input.title, visibility: 'public' },
        });
        if (!decision.allow) throw new TaskStoppedError('The user did not confirm the public publish; the video was not published.');
        return 'Public publish confirmed.';
      },
    },
    {
      id: 'finish',
      title: 'Save or publish',
      async run(context) {
        const clicked = await clickLabel(context, /publish|save|done|เผยแพร่|บันทึก|เสร็จสิ้น/i);
        if (!clicked) return 'No final button was found; YouTube may save the upload automatically.';
        return 'Clicked the final button.';
      },
    },
    {
      id: 'verify',
      title: 'Verify the video URL',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        let waited = '';
        try {
          waited = await context.runPc('browser_wait', { url: '/video/', timeout_ms: 120_000 });
        } catch {
          waited = await snapshot(context);
        }
        const status = await check(context);
        const url = videoUrl(`${status.url}\n${waited}`);
        if (!url) throw new Error('YouTube did not show a video URL; the upload could not be verified.');
        state.url = url;
        context.update({ verification: { ok: true, summary: `Verified ${url}` } });
        return url;
      },
    },
    {
      id: 'report',
      title: 'Report the upload',
      async run(context) {
        const state = context.state.data as unknown as YouTubeState;
        const verification: TaskVerificationView = context.state.verification ?? { ok: false, summary: 'The video URL was not verified.' };
        const receipt: TaskReceiptView = {
          summary: `Uploaded "${context.input.title}" to YouTube as ${state.visibility}: ${state.url}. No password was typed; no undo is offered for an upload.`,
          moved: 0,
          skipped: 0,
          failed: verification.ok ? 0 : 1,
          examples: state.url ? [state.url] : [],
          undoable: false,
        };
        context.update({ receipt });
        return receipt.summary;
      },
    },
  ],
};
