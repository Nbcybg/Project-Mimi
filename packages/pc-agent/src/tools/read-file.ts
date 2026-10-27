import fs from 'node:fs/promises';
import { z } from 'zod';
import { missingPathError, resolveAllowedPath } from './path-guard.ts';
import { defineTool } from '@mimi/shared';

const MAX_BYTES = 100_000;

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the allowed folders. Relative paths resolve against the working folder. Long files are truncated.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('File path, absolute or relative to the working folder'),
  }),
  summarize: (input) => `Read ${input.path}`,
  async execute(input, context) {
    const file = resolveAllowedPath(input.path, context.allowedDirs);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch (error) {
      throw missingPathError(error, file, context.allowedDirs);
    }
    if (buffer.byteLength <= MAX_BYTES) return buffer.toString('utf8');
    return `${buffer.subarray(0, MAX_BYTES).toString('utf8')}\n\n[truncated: showing first ${MAX_BYTES} of ${buffer.byteLength} bytes]`;
  },
});
