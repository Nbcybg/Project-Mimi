import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { resolveAllowedPath } from './path-guard.ts';

const JOURNAL_DIR = '.mimi-organize';
const DEFAULT_MAX_FILES = 500;
const MAX_FILES = 2_000;
const EXAMPLE_LIMIT = 5;

type Policy = 'rename' | 'skip' | 'overwrite';
type MoveStatus = 'planned' | 'moved' | 'skipped' | 'failed' | 'restored';

interface JournalMove {
  from: string;
  to: string;
  status: MoveStatus;
  reason?: string;
}

interface JournalBackup {
  from: string;
  to: string;
  status: MoveStatus;
  reason?: string;
}

interface Journal {
  version: 1;
  id: string;
  folder: string;
  policy: Policy;
  status: 'planned' | 'applied' | 'undone';
  createdAt: string;
  updatedAt: string;
  moves: JournalMove[];
  backups: JournalBackup[];
  conflicts: JournalBackup[];
  skipped: Array<{ name: string; reason: string }>;
  deferred: number;
}

interface PlanGroup {
  key: string;
  count: number;
  examples: string[];
}

const CATEGORIES: Array<{ key: string; label: string; extensions: string[] }> = [
  {
    key: 'images',
    label: 'Images',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'arw', 'dng'],
  },
  {
    key: 'documents',
    label: 'Documents',
    extensions: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'pages', 'xls', 'xlsx', 'csv', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key'],
  },
  { key: 'audio', label: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff'] },
  { key: 'video', label: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'] },
  { key: 'archives', label: 'Archives', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'] },
  {
    key: 'code',
    label: 'Code',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss', 'sh', 'ps1', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sql'],
  },
  { key: 'installers', label: 'Installers', extensions: ['exe', 'msi', 'dmg', 'pkg', 'appimage', 'deb', 'rpm'] },
];

const CATEGORY_BY_EXTENSION = new Map<string, { key: string; label: string }>();
for (const category of CATEGORIES) {
  for (const extension of category.extensions) CATEGORY_BY_EXTENSION.set(extension, category);
}
const OTHER = { key: 'other', label: 'Other' };

const TEMP_SUFFIXES = ['.part', '.partial', '.crdownload', '.download', '.tmp', '.temp', '.opdownload'];
const TEMP_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function isTemporary(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEMP_NAMES.has(lower) || lower.startsWith('~$') || lower.endsWith('~')) return true;
  return TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function categoryOf(name: string): { key: string; label: string } {
  const extension = path.extname(name).slice(1).toLowerCase();
  return CATEGORY_BY_EXTENSION.get(extension) ?? OTHER;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(target: string): Promise<string> {
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const extension = path.extname(target);
  const base = path.basename(target, extension);
  for (let n = 1; n < 10_000; n++) {
    const candidate = path.join(dir, `${base} (${n})${extension}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free name next to ${target}.`);
}

function journalPathFor(folder: string, id: string): string {
  return path.join(folder, JOURNAL_DIR, `${id}.json`);
}

async function writeJournal(file: string, journal: Journal): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  journal.updatedAt = new Date().toISOString();
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(journal, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

async function readJournal(requested: string, allowedDirs: string[]): Promise<{ file: string; journal: Journal }> {
  const file = resolveAllowedPath(requested, allowedDirs);
  if (path.basename(path.dirname(file)) !== JOURNAL_DIR || path.extname(file).toLowerCase() !== '.json') {
    throw new Error(`"${requested}" is not an organizer journal.`);
  }
  const journal = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Journal>;
  if (journal.version !== 1 || !Array.isArray(journal.moves) || !Array.isArray(journal.backups) || !journal.folder) {
    throw new Error(`"${requested}" is not a valid organizer journal.`);
  }
  journal.conflicts ??= [];
  journal.skipped ??= [];
  journal.deferred ??= 0;
  resolveAllowedPath(journal.folder, allowedDirs);
  return { file, journal: journal as Journal };
}

function groupPlan(moves: JournalMove[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const move of moves) {
    const category = categoryOf(path.basename(move.from));
    const group = groups.get(category.label) ?? { key: category.label, count: 0, examples: [] };
    group.count++;
    if (group.examples.length < EXAMPLE_LIMIT) group.examples.push(path.basename(move.from));
    groups.set(category.label, group);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function plan(folderInput: string | undefined, context: { allowedDirs: string[] }, policy: Policy, maxFiles: number): Promise<string> {
  const folder = resolveAllowedPath(folderInput ?? '.', context.allowedDirs);
  const stat = await fs.stat(folder);
  if (!stat.isDirectory()) throw new Error(`"${folderInput ?? '.'}" is not a folder.`);

  const skipped: Array<{ name: string; reason: string }> = [];
  const candidates: string[] = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (entry.name === JOURNAL_DIR) continue;
    if (entry.name.startsWith('.')) {
      skipped.push({ name: entry.name, reason: 'hidden' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ name: entry.name, reason: 'symlink' });
      continue;
    }
    if (!entry.isFile()) continue;
    if (isTemporary(entry.name)) {
      skipped.push({ name: entry.name, reason: 'temporary or partial download' });
      continue;
    }
    candidates.push(entry.name);
  }
  candidates.sort((a, b) => a.localeCompare(b));

  const planned = candidates.slice(0, maxFiles);
  const deferred = candidates.length - planned.length;
  const id = randomUUID();
  const moves: JournalMove[] = planned.map((name) => {
    const category = categoryOf(name);
    return {
      from: path.join(folder, name),
      to: path.join(folder, category.label, name),
      status: 'planned',
    };
  });
  const journal: Journal = {
    version: 1,
    id,
    folder,
    policy,
    status: 'planned',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    moves,
    backups: [],
    conflicts: [],
    skipped,
    deferred,
  };
  const file = journalPathFor(folder, id);
  await writeJournal(file, journal);

  const groups = groupPlan(moves);
  const summary =
    moves.length === 0
      ? `No files to organize in ${folder}.`
      : `Planned ${moves.length} file(s) in ${folder}: ${groups.map((group) => `${group.key} ${group.count}`).join(', ')}.`;
  return JSON.stringify(
    {
      ok: true,
      mode: 'plan',
      summary,
      folder,
      journal: file,
      policy,
      total: moves.length,
      deferred,
      groups,
      skipped,
    },
    null,
    2,
  );
}

async function apply(requested: string, context: { allowedDirs: string[] }): Promise<string> {
  const { file, journal } = await readJournal(requested, context.allowedDirs);
  if (journal.status === 'applied') {
    return JSON.stringify(
      {
        ok: true,
        mode: 'apply',
        alreadyApplied: true,
        summary: 'This organizer plan was already applied.',
        journal: file,
        moved: journal.moves.filter((move) => move.status === 'moved').length,
      },
      null,
      2,
    );
  }
  if (journal.status === 'undone') throw new Error('This organizer plan was already undone; make a new plan.');

  const folder = resolveAllowedPath(journal.folder, context.allowedDirs);
  let moved = 0;
  let skipped = 0;
  let failed = 0;

  for (const move of journal.moves) {
    if (move.status !== 'planned') continue;
    try {
      const from = resolveAllowedPath(move.from, context.allowedDirs);
      let to = resolveAllowedPath(move.to, context.allowedDirs);
      const source = await fs.lstat(from);
      if (!source.isFile() || source.isSymbolicLink()) {
        move.status = 'skipped';
        move.reason = 'source is no longer a regular file';
        skipped++;
        continue;
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (await exists(to)) {
        if (journal.policy === 'skip') {
          move.status = 'skipped';
          move.reason = 'destination already exists';
          skipped++;
          continue;
        }
        if (journal.policy === 'rename') {
          to = await uniquePath(to);
        } else {
          const backupDir = path.join(folder, JOURNAL_DIR, 'backups', journal.id);
          await fs.mkdir(backupDir, { recursive: true });
          const backup = await uniquePath(path.join(backupDir, path.basename(to)));
          await fs.rename(to, backup);
          journal.backups.push({ from: to, to: backup, status: 'moved' });
        }
      }
      await fs.rename(from, to);
      move.to = to;
      move.status = 'moved';
      moved++;
    } catch (error) {
      move.status = 'failed';
      move.reason = (error as Error).message;
      failed++;
    }
  }

  journal.status = 'applied';
  await writeJournal(file, journal);
  const examples = journal.moves.filter((move) => move.status === 'moved').slice(0, EXAMPLE_LIMIT).map((move) => path.basename(move.to));
  return JSON.stringify(
    {
      ok: failed === 0,
      mode: 'apply',
      summary: `Moved ${moved} file(s) into ${folder}; ${skipped} skipped, ${failed} failed.`,
      folder,
      journal: file,
      policy: journal.policy,
      moved,
      skipped,
      failed,
      deferred: journal.deferred,
      examples,
    },
    null,
    2,
  );
}

async function verify(requested: string, context: { allowedDirs: string[] }): Promise<string> {
  const { file, journal } = await readJournal(requested, context.allowedDirs);
  const missing: string[] = [];
  let checked = 0;
  for (const move of journal.moves) {
    if (journal.status === 'applied' && move.status === 'moved') {
      checked++;
      const from = resolveAllowedPath(move.from, context.allowedDirs);
      const to = resolveAllowedPath(move.to, context.allowedDirs);
      if ((await exists(from)) || !(await exists(to))) missing.push(path.basename(move.from));
    } else if (journal.status === 'undone' && move.status === 'restored') {
      checked++;
      const from = resolveAllowedPath(move.from, context.allowedDirs);
      const to = resolveAllowedPath(move.to, context.allowedDirs);
      if (!(await exists(from)) || (await exists(to))) missing.push(path.basename(move.from));
    }
  }
  return JSON.stringify(
    {
      ok: missing.length === 0,
      mode: 'verify',
      summary:
        missing.length === 0
          ? `Verified ${checked} moved file(s) from the journal.`
          : `${missing.length} of ${checked} file(s) did not match the journal.`,
      journal: file,
      status: journal.status,
      checked,
      missing,
    },
    null,
    2,
  );
}

async function restore(requested: string, context: { allowedDirs: string[] }): Promise<string> {
  const { file, journal } = await readJournal(requested, context.allowedDirs);
  if (journal.status === 'planned') {
    throw new Error('This organizer plan was never applied; there is nothing to undo.');
  }
  if (journal.status === 'undone') {
    return JSON.stringify(
      { ok: true, mode: 'undo', alreadyUndone: true, summary: 'This organizer plan was already undone.', journal: file, restored: 0 },
      null,
      2,
    );
  }

  const folder = resolveAllowedPath(journal.folder, context.allowedDirs);
  const conflictDir = path.join(folder, JOURNAL_DIR, 'undo-conflicts');
  let restored = 0;
  let failed = 0;

  const moveAside = async (target: string): Promise<void> => {
    if (!(await exists(target))) return;
    await fs.mkdir(conflictDir, { recursive: true });
    const aside = await uniquePath(path.join(conflictDir, `${Date.now()}-${path.basename(target)}`));
    await fs.rename(target, aside);
    journal.conflicts.push({ from: target, to: aside, status: 'moved' });
  };

  for (const move of [...journal.moves].reverse()) {
    if (move.status !== 'moved') continue;
    try {
      const from = resolveAllowedPath(move.from, context.allowedDirs);
      const to = resolveAllowedPath(move.to, context.allowedDirs);
      if (!(await exists(to))) {
        move.status = 'failed';
        move.reason = 'the moved file is missing';
        failed++;
        continue;
      }
      await moveAside(from);
      await fs.mkdir(path.dirname(from), { recursive: true });
      await fs.rename(to, from);
      move.status = 'restored';
      restored++;
    } catch (error) {
      move.status = 'failed';
      move.reason = (error as Error).message;
      failed++;
    }
  }

  for (const backup of [...journal.backups].reverse()) {
    if (backup.status !== 'moved') continue;
    try {
      const target = resolveAllowedPath(backup.from, context.allowedDirs);
      const source = resolveAllowedPath(backup.to, context.allowedDirs);
      if (!(await exists(source))) {
        backup.status = 'failed';
        backup.reason = 'the overwritten file backup is missing';
        failed++;
        continue;
      }
      await moveAside(target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(source, target);
      backup.status = 'restored';
    } catch (error) {
      backup.status = 'failed';
      backup.reason = (error as Error).message;
      failed++;
    }
  }

  journal.status = 'undone';
  await writeJournal(file, journal);
  return JSON.stringify(
    {
      ok: failed === 0,
      mode: 'undo',
      summary: `Restored ${restored} file(s) to ${folder}; ${failed} failed.`,
      folder,
      journal: file,
      restored,
      failed,
    },
    null,
    2,
  );
}

/** Plan and verify only read the folder and the journal; apply is the changing action. */
export function isOrganizerReadOnly(input: { journal?: string; dry_run?: boolean; verify?: boolean }): boolean {
  return input.verify === true || !input.journal || input.dry_run === true;
}

const summarize = (input: {
  folder?: string;
  journal?: string;
  dry_run?: boolean;
  verify?: boolean;
  policy?: string;
  max_files?: number;
}): string => {
  if (input.verify) return `Verify organizer journal ${input.journal ?? ''}`.trim();
  if (input.journal && input.dry_run !== true) return `Apply organizer plan ${path.basename(input.journal)}`;
  return `Plan organizing ${input.folder ?? '.'}`;
};

export const organizeFilesTool = defineTool({
  name: 'organize_files',
  description:
    'Plan or apply a safe file organization: top-level files move into type folders (Images, Documents, Audio, Video, Archives, Code, Installers, Other). Dry-run by default and writes a journal; apply requires that journal. Skips hidden files, symlinks and temporary/partial downloads, never deletes, and respects the allowed folders.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    folder: z.string().optional().describe('Folder to organize; defaults to the working folder'),
    dry_run: z.boolean().optional().describe('Plan only (default true). Pass false with a journal to apply.'),
    journal: z.string().optional().describe('Journal path returned by a dry run; required to apply, undo or verify'),
    policy: z.enum(['rename', 'skip', 'overwrite']).optional().describe('Conflict policy; default rename'),
    max_files: z.number().int().min(1).max(MAX_FILES).optional().describe(`Files per run; default ${DEFAULT_MAX_FILES}`),
    verify: z.boolean().optional().describe('Check the journal against the disk instead of changing anything'),
  }),
  summarize,
  async execute(input, context) {
    if (input.verify) {
      if (!input.journal) throw new Error('verify needs the journal returned by a dry run.');
      return verify(input.journal, context);
    }
    if (input.journal && input.dry_run !== true) return apply(input.journal, context);
    const policy: Policy = input.policy === 'skip' || input.policy === 'overwrite' ? input.policy : 'rename';
    return plan(input.folder, context, policy, input.max_files ?? DEFAULT_MAX_FILES);
  },
});

export const undoOrganizeTool = defineTool({
  name: 'undo_organize',
  description:
    'Undo an applied organize_files plan from its journal: every moved file goes back to where it was. Existing files are moved aside, never deleted. Refuses a plan that was never applied.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    journal: z.string().min(1).describe('Journal path returned by organize_files'),
  }),
  summarize: (input) => `Undo organizer journal ${path.basename(input.journal)}`,
  async execute(input, context) {
    return restore(input.journal, context);
  },
});

export const organizeTools = [organizeFilesTool, undoOrganizeTool];
