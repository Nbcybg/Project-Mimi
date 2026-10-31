import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { missingPathError, resolveAllowedPath } from './path-guard.ts';

const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.mimi-trash', '.mimi-organize', '.mimi-workspace']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;

/** `*.ts`, `src/**`, a bare extension; case-insensitive. */
function globRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll('\\', '/');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function isProbablyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return !sample.includes(0);
}

/**
 * Finds a phrase or regular expression inside text files, like a small rg: path, line
 * number and the matching line. It never leaves the allowed folders.
 */
export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search inside text files under a folder (path, line, matching text). Supports a regular expression, an include glob such as "*.ts" or "src/**", ignore_case and a result limit. Skips node_modules, .git and hidden Mimi state folders.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Text or regular expression to find'),
    path: z.string().optional().describe('Folder to search; defaults to the working folder'),
    glob: z.string().optional().describe('Only files whose path matches, e.g. *.ts or src/**'),
    literal: z.boolean().optional().describe('Treat the pattern as plain text (default false = regex)'),
    ignore_case: z.boolean().optional().describe('Default false'),
    max_results: z.number().int().min(1).max(1000).optional().describe('Default 200'),
    max_depth: z.number().int().min(1).max(20).optional().describe('Default 12'),
    max_file_bytes: z.number().int().min(1024).max(20 * 1024 * 1024).optional().describe('Default 2 MB'),
  }),
  summarize: (input) => `grep ${input.literal ? 'text' : 'regex'} "${input.pattern}"${input.glob ? ` in ${input.glob}` : ''} under ${input.path ?? '.'}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error(`"${input.path}" is not a folder.`);
    } catch (error) {
      throw missingPathError(error, root, context.allowedDirs);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(input.literal ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : input.pattern, input.ignore_case ? 'i' : '');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${(error as Error).message}`);
    }
    const include = input.glob?.trim() ? globRegExp(input.glob.trim()) : undefined;
    const maxDepth = input.max_depth ?? 12;
    const maxBytes = input.max_file_bytes ?? MAX_FILE_BYTES;
    const limit = input.max_results ?? DEFAULT_MAX_RESULTS;
    const found: string[] = [];
    let scanned = 0;
    let capped = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (capped || depth > maxDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (capped) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name)) await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = path.relative(root, full).replaceAll('\\', '/');
        if (include && !include.test(relative) && !include.test(entry.name)) continue;
        let buffer: Buffer;
        try {
          const stat = await fs.stat(full);
          if (stat.size > maxBytes) continue;
          buffer = await fs.readFile(full);
        } catch {
          continue;
        }
        if (!isProbablyText(buffer)) continue;
        scanned++;
        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (!regex.test(line)) continue;
          // Reset state for global/sticky expressions the caller may have provided.
          regex.lastIndex = 0;
          found.push(`${relative}:${index + 1}: ${line.trim().slice(0, 500)}`);
          if (found.length >= limit) {
            capped = true;
            return;
          }
        }
      }
    };
    await walk(root, 1);
    if (found.length === 0) return `No matches in ${scanned} text file(s) under ${root}.`;
    return `${found.length}${capped ? '+' : ''} match(es) in ${scanned} file(s) under ${root}:\n${found.join('\n')}`;
  },
});
