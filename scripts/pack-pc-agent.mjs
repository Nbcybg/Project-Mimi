import fs from 'node:fs';
import path from 'node:path';

const skipTests = (src) =>
  !/\.(test|spec)\.[cm]?[jt]s$/.test(src) && !path.basename(src).startsWith('._') && path.basename(src) !== '.DS_Store';

/**
 * The PC agent runs as TypeScript straight from the app folder. Node 24 refuses to
 * strip types from files under node_modules, so the old packaged layout
 * (node_modules/@mimi/pc-agent/src/main.ts) could not start at all.
 *
 * Copy the PC agent and @mimi/shared outside node_modules, then rewrite the PC
 * agent's bare `@mimi/shared` imports to the copied source. Everything else (zod,
 * pdf-lib) is already plain JavaScript under node_modules.
 */
export function packPcAgent(root, app) {
  for (const pkg of ['shared', 'pc-agent']) {
    const to = path.join(app, pkg);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(path.join(root, 'packages', pkg, 'package.json'), path.join(to, 'package.json'));
    fs.cpSync(path.join(root, 'packages', pkg, 'src'), path.join(to, 'src'), {
      recursive: true,
      filter: skipTests,
    });
  }

  const sharedEntry = path.join(app, 'shared', 'src', 'index.ts');
  const rewrite = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        rewrite(file);
        continue;
      }
      if (!file.endsWith('.ts')) continue;
      const relative = path.relative(path.dirname(file), sharedEntry).replaceAll('\\', '/');
      const specifier = relative.startsWith('.') ? relative : `./${relative}`;
      const source = fs.readFileSync(file, 'utf8');
      const rewritten = source.replace(/(['"])@mimi\/shared\1/g, `$1${specifier}$1`);
      if (rewritten !== source) fs.writeFileSync(file, rewritten);
    }
  };
  rewrite(path.join(app, 'pc-agent', 'src'));
}

/** The outside packages the copied PC agent imports at run time (zod and pdf-lib). */
export const PC_AGENT_PACKAGES = ['zod', 'pdf-lib', 'pako', 'tslib', '@pdf-lib/standard-fonts', '@pdf-lib/upng'];

/** Copies those packages beside the app, where the copied PC agent finds them. */
export function copyPcAgentPackages(root, app) {
  const modules = path.join(app, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  for (const name of PC_AGENT_PACKAGES) {
    const from = path.join(root, 'node_modules', ...name.split('/'));
    const to = path.join(modules, ...name.split('/'));
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
}
