import fs from 'node:fs';
import path from 'node:path';

export class PathNotAllowedError extends Error {
  constructor(requested: string, allowedDirs: string[]) {
    super(
      `Path "${requested}" is outside the allowed folders (${allowedDirs.join('; ') || 'none configured'})`,
    );
    this.name = 'PathNotAllowedError';
  }
}

/** The path is inside an allowed folder but outside every approved project root. */
export class ProjectNotAllowedError extends Error {
  constructor(requested: string, projectRoots: string[]) {
    super(
      `Path "${requested}" is outside the approved project folders (${projectRoots.join('; ') || 'none'}). Ask the user to add this project in Mimi's settings, or run outside a project.`,
    );
    this.name = 'ProjectNotAllowedError';
  }
}

/**
 * Resolves symlinks for the part of the path that exists, so a link inside an
 * allowed folder cannot be used to reach outside of it.
 */
function realpathDeep(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...rest);
}

function isInside(target: string, dir: string): boolean {
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(fold(dir), fold(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves `requested` (relative paths against `baseDir`) and returns the absolute
 * path only if it lies inside one of `allowedDirs`. Throws PathNotAllowedError otherwise.
 */
export function resolveAllowedPath(
  requested: string,
  allowedDirs: string[],
  baseDir: string = allowedDirs[0] ?? process.cwd(),
): string {
  if (requested.includes('\0')) throw new PathNotAllowedError(requested, allowedDirs);
  const target = realpathDeep(path.resolve(baseDir, requested));
  const allowed = allowedDirs.some((dir) => isInside(target, realpathDeep(path.resolve(dir))));
  if (!allowed) throw new PathNotAllowedError(requested, allowedDirs);
  return target;
}

/**
 * Resolves a folder a shell command may run in. The folder allowlist always applies;
 * when `projectRoots` were approved the path must also lie inside one of them. Roots
 * that are not inside the local allowlist are dropped, so the core can narrow the
 * scope but can never widen it. An empty list keeps the older behaviour (any allowed
 * folder), which is what a machine without project settings expects.
 */
export function resolveProjectPath(
  requested: string,
  allowedDirs: string[],
  projectRoots: string[] | undefined,
  baseDir: string = allowedDirs[0] ?? process.cwd(),
): string {
  const resolved = resolveAllowedPath(requested, allowedDirs, baseDir);
  if (!projectRoots || projectRoots.length === 0) return resolved;
  const roots: string[] = [];
  for (const root of projectRoots) {
    try {
      roots.push(resolveAllowedPath(root, allowedDirs));
    } catch (error) {
      // A root this machine does not allow is ignored: local folders stay authoritative.
      if (!(error instanceof PathNotAllowedError)) throw error;
    }
  }
  if (roots.length === 0) {
    throw new Error(
      `No approved project folder is inside this computer's allowed folders (${allowedDirs.join('; ') || 'none configured'}). Add the project on this computer, or clear the project folders in Mimi's settings.`,
    );
  }
  if (!roots.some((root) => isInside(resolved, realpathDeep(root)))) {
    throw new ProjectNotAllowedError(requested, roots);
  }
  return resolved;
}

/**
 * Rewords the file-system errors of the read tools (ENOENT / ENOTDIR) so the agent sees
 * where the path was resolved: relative paths start from the working folder, which is
 * not obvious to sub-agents that name folders after the user's mental layout.
 */
export function missingPathError(error: unknown, resolved: string, allowedDirs: string[]): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'ENOENT' && code !== 'ENOTDIR') return error as Error;
  const root = allowedDirs[0];
  const hint = root
    ? ` Relative paths resolve against the working folder (${root}); "${resolved}" does not exist.`
    : ` "${resolved}" does not exist.`;
  return new Error(`${code}: no such file or directory, stat '${resolved}'.${hint}`);
}
