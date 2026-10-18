import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveAllowedPath } from './path-guard.ts';
import { defineTool } from '@mimi/shared';

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file inside the allowed folders. Parent folders are created as needed.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('File path, absolute or relative to the working folder'),
    content: z.string().describe('Full new content of the file'),
  }),
  summarize: (input) => `Write ${Buffer.byteLength(input.content)} bytes to ${input.path}`,
  async execute(input, context) {
    const file = resolveAllowedPath(input.path, context.allowedDirs);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, input.content, 'utf8');
    return `Wrote ${Buffer.byteLength(input.content)} bytes to ${file}`;
  },
});
