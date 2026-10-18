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
