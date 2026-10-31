import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { missingPathError, resolveAllowedPath } from './path-guard.ts';

interface Planned {
  file: string;
  before: string;
  after: string;
  replacements: number;
}

/**
 * Changes several text files in one call. Every hunk is checked before anything is
 * written, so a wrong `old_string` cannot leave half the patch applied; if a write
 * later fails, the files already written are restored.
 */
export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description:
    'Apply exact replacements to several files at once. Each patch is {path, old_string, new_string, replace_all?}. All hunks are validated first; nothing is written if one does not match. Use this for a change that spans multiple files.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    patches: z
      .array(
        z.object({
          path: z.string().min(1),
          old_string: z.string().min(1),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(50),
    dry_run: z.boolean().optional().describe('Only report what would change'),
  }),
  summarize: (input) => `Patch ${input.patches.length} file(s): ${input.patches.map((patch) => patch.path).join(', ').slice(0, 300)}${input.dry_run ? ' (dry run)' : ''}`,
  async execute(input, context) {
    const planned: Planned[] = [];
    const seen = new Map<string, string>();
    for (const patch of input.patches) {
      const file = resolveAllowedPath(patch.path, context.allowedDirs);
      let before: string;
      try {
        before = await fs.readFile(file, 'utf8');
      } catch (error) {
        throw missingPathError(error, file, context.allowedDirs);
      }
      const count = before.split(patch.old_string).length - 1;
      if (count === 0) throw new Error(`"${patch.path}": old_string was not found.`);
      if (count > 1 && !patch.replace_all) {
        throw new Error(`"${patch.path}": old_string appears ${count} times; add context or pass replace_all: true.`);
      }
      const base = seen.get(file) ?? before;
      if (!base.includes(patch.old_string)) throw new Error(`"${patch.path}": an earlier patch removed this old_string.`);
      const after = base.split(patch.old_string).join(patch.new_string);
      seen.set(file, after);
      const existing = planned.find((entry) => entry.file === file);
      if (existing) {
        existing.after = after;
        existing.replacements += count;
      } else {
        planned.push({ file, before, after, replacements: count });
      }
    }
    if (input.dry_run) {
      return planned.map((entry) => `${path.relative(context.allowedDirs[0] ?? process.cwd(), entry.file) || entry.file}: ${entry.replacements} replacement(s)`).join('\n');
    }
    const written: Planned[] = [];
    try {
      for (const entry of planned) {
        await fs.writeFile(entry.file, entry.after, 'utf8');
        written.push(entry);
      }
    } catch (error) {
      for (const entry of written.reverse()) {
        await fs.writeFile(entry.file, entry.before, 'utf8').catch(() => {});
      }
      throw new Error(`Patch failed and was rolled back: ${(error as Error).message}`);
    }
    return planned.map((entry) => `${entry.file}: ${entry.replacements} replacement(s)`).join('\n');
  },
});
