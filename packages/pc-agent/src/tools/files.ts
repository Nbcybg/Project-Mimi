import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { PathNotAllowedError, missingPathError, resolveAllowedPath } from './path-guard.ts';

const SKIPPED_FOLDERS = new Set(['node_modules', '.git', '.mimi-trash']);
const MAX_SEARCH_FILE = 1024 * 1024;

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const stamp = (date: Date): string => date.toISOString().slice(0, 16).replace('T', ' ');

/** `*` any run of characters, `?` one character; case-insensitive; the whole name must match. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function entriesOf(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
}

export const listDirTool = defineTool({
  name: 'list_dir',
  description: 'List the files and folders inside a folder (folders first, with sizes and modified times). `depth` 2-3 also lists what is inside the sub-folders.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Folder; defaults to the working folder'),
    depth: z.number().int().min(1).max(3).optional().describe('How many levels to show (default 1)'),
    limit: z.number().int().min(1).max(500).optional().describe('Most entries to return (default 200)'),
  }),
  summarize: (input) => `List ${input.path ?? '.'}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    let rootStat;
    try {
      rootStat = await fs.stat(root);
    } catch (error) {
      throw missingPathError(error, root, context.allowedDirs);
    }
    if (!rootStat.isDirectory()) throw new Error(`"${input.path}" is not a folder.`);
    const limit = input.limit ?? 200;
    const lines: string[] = [];
    let more = 0;
    const walk = async (dir: string, level: number): Promise<void> => {
      for (const entry of await entriesOf(dir)) {
        if (lines.length >= limit) {
          more++;
          continue;
        }
        const full = path.join(dir, entry.name);
        const shown = path.relative(root, full) || entry.name;
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          lines.push(`?  ${shown}`);
          continue;
        }
        if (entry.isDirectory()) {
          lines.push(`d  ${shown}/`);
          if (level < (input.depth ?? 1) && !SKIPPED_FOLDERS.has(entry.name)) await walk(full, level + 1);
        } else {
          lines.push(`f  ${shown}  ${size(stat.size)}  ${stamp(stat.mtime)}`);
        }
      }
    };
    await walk(root, 1);
    if (lines.length === 0) return `${root} is empty.`;
    return `${root}\n${lines.join('\n')}${more > 0 ? `\n[${more} more not shown]` : ''}`;
  },
});

export const fileInfoTool = defineTool({
  name: 'file_info',
  description: 'Size, type and times of one file or folder (for a folder: how many entries it holds).',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({ path: z.string().min(1) }),
  summarize: (input) => `Info ${input.path}`,
  async execute(input, context) {
    const file = resolveAllowedPath(input.path, context.allowedDirs);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (error) {
      throw missingPathError(error, file, context.allowedDirs);
    }
    const lines = [`path: ${file}`, `type: ${stat.isDirectory() ? 'folder' : 'file'}`];
    if (stat.isDirectory()) lines.push(`entries: ${(await fs.readdir(file)).length}`);
    else lines.push(`size: ${size(stat.size)} (${stat.size} bytes)`);
    lines.push(`modified: ${stamp(stat.mtime)}`, `created: ${stamp(stat.birthtime)}`);
    return lines.join('\n');
  },
});

export const findFilesTool = defineTool({
  name: 'find_files',
  description:
    'Find files by name (wildcards: * and ?, e.g. "*.pdf" or "invoice*") under a folder, optionally only those whose text contains a phrase. Skips node_modules and .git.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Folder to search in; defaults to the working folder'),
    name: z.string().optional().describe('File name pattern, e.g. *.csv; default any'),
    contains: z.string().optional().describe('Only text files (under 1 MB) containing this phrase, case-insensitive'),
    max_depth: z.number().int().min(1).max(10).optional().describe('Default 6'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
  }),
  summarize: (input) => `Find ${input.name ?? '*'}${input.contains ? ` containing "${input.contains}"` : ''} in ${input.path ?? '.'}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    try {
      await fs.stat(root);
    } catch (error) {
      throw missingPathError(error, root, context.allowedDirs);
    }
    const pattern = wildcardToRegExp(input.name?.trim() || '*');
    const needle = input.contains?.toLowerCase();
    const maxDepth = input.max_depth ?? 6;
    const limit = input.limit ?? 50;
    const found: string[] = [];
    let capped = false;
    const walk = async (dir: string, level: number): Promise<void> => {
      let entries;
      try {
        entries = await entriesOf(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (capped) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (level < maxDepth && !SKIPPED_FOLDERS.has(entry.name)) await walk(full, level + 1);
          continue;
        }
        if (!pattern.test(entry.name)) continue;
        if (needle) {
          try {
            const stat = await fs.stat(full);
            if (stat.size > MAX_SEARCH_FILE) continue;
            if (!(await fs.readFile(full, 'utf8')).toLowerCase().includes(needle)) continue;
          } catch {
            continue;
          }
        }
        if (found.length >= limit) {
          capped = true;
          return;
        }
        found.push(path.relative(root, full));
      }
    };
    await walk(root, 1);
    if (found.length === 0) return 'No files found.';
    return `${found.length}${capped ? '+' : ''} file(s) under ${root}:\n${found.join('\n')}`;
  },
});

export const makeDirTool = defineTool({
  name: 'make_dir',
  description: 'Create a folder (and any missing parent folders) inside the allowed folders.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({ path: z.string().min(1) }),
  summarize: (input) => `Create folder ${input.path}`,
  async execute(input, context) {
    const dir = resolveAllowedPath(input.path, context.allowedDirs);
    await fs.mkdir(dir, { recursive: true });
    return `Folder ready: ${dir}`;
  },
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export const movePathTool = defineTool({
  name: 'move_path',
  description: 'Move or rename a file or folder. `to` is the new full path (not the folder to put it in). Refuses to replace something that exists unless overwrite is true.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  summarize: (input) => `Move ${input.from} -> ${input.to}`,
  async execute(input, context) {
    const from = resolveAllowedPath(input.from, context.allowedDirs);
    const to = resolveAllowedPath(input.to, context.allowedDirs);
    if (context.allowedDirs.some((dir) => path.resolve(dir).toLowerCase() === from.toLowerCase())) throw new Error('An allowed folder itself cannot be moved.');
    if (!(await exists(from))) throw new Error(`"${input.from}" does not exist.`);
    if ((await exists(to)) && !input.overwrite) throw new Error(`"${input.to}" already exists. Pass overwrite: true to replace it.`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.cp(from, to, { recursive: true, force: Boolean(input.overwrite) });
      await fs.rm(from, { recursive: true, force: true });
    }
    return `Moved ${from} -> ${to}`;
  },
});

export const copyPathTool = defineTool({
  name: 'copy_path',
  description: 'Copy a file or a whole folder to a new full path. Refuses to replace something that exists unless overwrite is true.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    overwrite: z.boolean().optional(),
  }),
  summarize: (input) => `Copy ${input.from} -> ${input.to}`,
  async execute(input, context) {
    const from = resolveAllowedPath(input.from, context.allowedDirs);
    const to = resolveAllowedPath(input.to, context.allowedDirs);
    if (!(await exists(from))) throw new Error(`"${input.from}" does not exist.`);
    if ((await exists(to)) && !input.overwrite) throw new Error(`"${input.to}" already exists. Pass overwrite: true to replace it.`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true, force: Boolean(input.overwrite) });
    return `Copied ${from} -> ${to}`;
  },
});

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Change part of a text file: replace `old_string` with `new_string`. `old_string` must appear exactly once (add more surrounding text to make it unique) unless replace_all is true. Prefer this over write_file for small changes.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  summarize: (input) => `Edit ${input.path}`,
  async execute(input, context) {
    const file = resolveAllowedPath(input.path, context.allowedDirs);
    const text = await fs.readFile(file, 'utf8');
    const count = text.split(input.old_string).length - 1;
    if (count === 0) throw new Error('old_string was not found in the file.');
    if (count > 1 && !input.replace_all) throw new Error(`old_string appears ${count} times; add more context to make it unique, or pass replace_all: true.`);
    await fs.writeFile(file, text.split(input.old_string).join(input.new_string), 'utf8');
    return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${file}`;
  },
});

/** Runs a PowerShell script with the path passed in the environment, so no quoting can break it. */
function powerShell(script: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, MIMI_TARGET: target },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `PowerShell exited with ${code}`))));
  });
}

/**
 * Takes a file or folder out of the way so it can be recovered: the Recycle Bin on Windows,
 * a `.mimi-trash` folder inside the allowed folder everywhere else. Returns where it went.
 */
export async function moveToTrash(
  target: string,
  allowedDirs: string[],
  platform: NodeJS.Platform = process.platform,
  recycle: (target: string, isDirectory: boolean) => Promise<void> = (file, isDirectory) =>
    powerShell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; $p = $env:MIMI_TARGET; ` +
        (isDirectory
          ? `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')`
          : `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')`),
      file,
    ),
): Promise<string> {
  const isDirectory = (await fs.stat(target)).isDirectory();
  if (platform === 'win32') {
    await recycle(target, isDirectory);
    return 'the Recycle Bin';
  }
  const root = allowedDirs.map((dir) => path.resolve(dir)).find((dir) => path.relative(dir, target) !== '' && !path.relative(dir, target).startsWith('..'));
  if (!root) throw new PathNotAllowedError(target, allowedDirs);
  const bin = path.join(root, '.mimi-trash');
  await fs.mkdir(bin, { recursive: true });
  const moved = path.join(bin, `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(target)}`);
  await fs.rename(target, moved);
  return moved;
}

export const deletePathTool = defineTool({
  name: 'delete_path',
  description:
    'Delete a file or a whole folder. By default it goes to the Recycle Bin (or a .mimi-trash folder), so it can be recovered; permanent: true removes it for good. An allowed folder itself cannot be deleted.',
  risk: 'delete',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1),
    permanent: z.boolean().optional().describe('Remove for good instead of the Recycle Bin (default false)'),
  }),
  summarize: (input) => `Delete ${input.path}${input.permanent ? ' PERMANENTLY' : ''}`,
  async execute(input, context) {
    const target = resolveAllowedPath(input.path, context.allowedDirs);
    if (context.allowedDirs.some((dir) => path.resolve(dir).toLowerCase() === target.toLowerCase())) throw new Error('An allowed folder itself cannot be deleted.');
    if (!(await exists(target))) throw new Error(`"${input.path}" does not exist.`);
    if (input.permanent) {
      await fs.rm(target, { recursive: true, force: true });
      return `Deleted ${target} permanently.`;
    }
    return `Moved ${target} to ${await moveToTrash(target, context.allowedDirs)}.`;
  },
});

export const fileTools = [listDirTool, fileInfoTool, findFilesTool, makeDirTool, movePathTool, copyPathTool, editFileTool, deletePathTool];
