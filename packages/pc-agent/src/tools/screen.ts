import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { resolveAllowedPath } from './path-guard.ts';

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout),
    ),
  );
}

/**
 * The command that puts a picture of the current screen into `target` (PNG). Screenshots
 * can hold passwords on the screen, so every call needs the user's approval.
 */
function captureInvocation(target: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;` +
          `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;` +
          `$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);` +
          `$g=[System.Drawing.Graphics]::FromImage($bmp);` +
          `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);` +
          `$bmp.Save('${target.replaceAll("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png);` +
          `$g.Dispose();$bmp.Dispose()`,
      ],
    };
  }
  if (process.platform === 'darwin') return { file: 'screencapture', args: ['-x', target] };
  return { file: 'gnome-screenshot', args: ['-f', target] };
}

export const screenshotTool = defineTool({
  name: 'screenshot',
  description:
    'Take a picture of the computer\'s current screen (all monitors) and save it as a PNG in the working folder. The file name is chosen so nothing is overwritten; the result can be sent with send_file. Screens may show passwords — the user is asked before every shot.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    filename: z.string().optional().describe('File name, e.g. shot.png (default: screenshot-<time>.png)'),
  }),
  summarize: (input) => `Screenshot${input.filename ? ` → ${input.filename}` : ''}`,
  async execute(input, context) {
    const dir = resolveAllowedPath('.', context.allowedDirs);
    const name = input.filename?.trim() || `screenshot-${Date.now()}.png`;
    if (!/^[\w\-. ]+\.png$/i.test(name)) throw new Error('The file name must end in .png and contain no path separators.');
    const target = path.join(dir, name);
    try {
      await run(...Object.values(captureInvocation(target)) as [string, string[]]);
    } catch (error) {
      if (process.platform === 'linux') {
        // gnome-screenshot is often missing; ImageMagick is a common fallback.
        try {
          await run('import', ['-window', 'root', target]);
        } catch {
          throw new Error(`Screenshot failed: ${(error as Error).message}. Install gnome-screenshot or imagemagick, or use run_shell.`);
        }
      } else {
        throw error;
      }
    }
    const size = fs.statSync(target).size;
    return `Saved screenshot to ${target} (${Math.round(size / 1024)} KB).\nSend it with send_file, or read it with read_document.`;
  },
});

/** What reads the clipboard per platform; an empty answer means there is no text. */
function clipboardInvocation(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', '(Get-Clipboard -Raw) -join "`n"'] };
  }
  if (process.platform === 'darwin') return { file: 'pbpaste', args: [] };
  return { file: 'xclip', args: ['-selection', 'clipboard', '-o'] };
}

export const clipboardTool = defineTool({
  name: 'clipboard_read',
  description:
    'Read the text currently in the computer\'s clipboard (copied with Ctrl/Cmd+C). Use it when the user says "ที่ก๊อปไว้" or pastes a link/code. The user is asked before every read; passwords on the clipboard may be seen.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({}),
  summarize: () => 'Read the clipboard',
  async execute() {
    try {
      const text = await run(...Object.values(clipboardInvocation()) as [string, string[]]);
      const trimmed = text.replace(/\r/g, '').trimEnd();
      if (!trimmed) return '(the clipboard has no text)';
      return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n[truncated: ${trimmed.length - 4000} more characters]` : trimmed;
    } catch (error) {
      throw new Error(
        `Clipboard read failed: ${(error as Error).message}${process.platform === 'linux' ? '. Install xclip or xsel.' : ''}`,
      );
    }
  },
});

export const screenTools = [screenshotTool, clipboardTool];
