import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveAllowedPath } from './path-guard.ts';

export interface SingleOutputInput {
  path: string;
  output?: string;
  in_place?: boolean;
  backup?: boolean;
}

export interface SingleOutput {
  source: string;
  output: string;
  inPlace: boolean;
}

/** The default backup next to a file replaced in place: photo.mimi-backup.jpg */
export function backupFilePath(source: string): string {
  const extension = path.extname(source);
  const base = path.basename(source, extension);
  return path.join(path.dirname(source), `${base}.mimi-backup${extension}`);
}

/** A source plus the file to write: a new path, or the source itself when in_place is set. */
export function resolveSingleOutput(input: SingleOutputInput, allowedDirs: string[]): SingleOutput {
  const source = resolveAllowedPath(input.path, allowedDirs);
  if (input.in_place) {
    if (input.output?.trim()) {
      const requested = resolveAllowedPath(input.output, allowedDirs);
      if (requested.toLowerCase() !== source.toLowerCase()) {
        throw new Error('With in_place the output must be left out or name the source file.');
      }
    }
    return { source, output: source, inPlace: true };
  }
  if (!input.output?.trim()) {
    throw new Error('Give an output path, or set in_place: true to replace the source (a backup is kept).');
  }
  const output = resolveAllowedPath(input.output, allowedDirs);
  if (output.toLowerCase() === source.toLowerCase()) {
    throw new Error('The output is the source file; set in_place: true to replace it (a backup is kept).');
  }
  return { source, output, inPlace: false };
}

function tempPathFor(output: string): string {
  const extension = path.extname(output);
  return path.join(path.dirname(output), `.mimi-tmp-${randomUUID()}${extension}`);
}

export interface AtomicOutput {
  /** Where the tool writes first. */
  writePath: string;
  /** Replaces the source (when in place) and returns the backup path, if one was made. */
  commit(): Promise<string | undefined>;
  abort(): Promise<void>;
}

/**
 * A new output is written directly. An in-place edit goes to a temporary file in the
 * same folder and replaces the source only after the write succeeded; by default the
 * previous version is kept as `<name>.mimi-backup<ext>`.
 */
export function atomicOutput(target: SingleOutput, keepBackup = true): AtomicOutput {
  if (!target.inPlace) {
    return {
      writePath: target.output,
      commit: async () => undefined,
      abort: async () => {},
    };
  }
  const writePath = tempPathFor(target.output);
  return {
    writePath,
    async commit() {
      const backup = backupFilePath(target.output);
      if (keepBackup) await fs.copyFile(target.output, backup);
      await fs.rename(writePath, target.output);
      return keepBackup ? backup : undefined;
    },
    async abort() {
      await fs.rm(writePath, { force: true });
    },
  };
}
