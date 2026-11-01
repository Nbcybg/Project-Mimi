import fs from 'node:fs';
import path from 'node:path';

// The Workspace terminal (packages/desktop/workspace.cjs) needs a pseudo-terminal in the main
// process (node-pty, with the prebuilt binary for this system: N-API, so the same file runs on
// Electron's Node) and the terminal emulator in the page (xterm.js and its fit addon). Only the
// files they load at run time are copied; without them the terminal falls back to a pipe.

const keep = (file) => !/\.(map|pdb|ts)$/.test(file) && !/\.test\.js$/.test(file);

function copyFiltered(from, to) {
  fs.cpSync(from, to, { recursive: true, filter: (source) => fs.statSync(source).isDirectory() || keep(path.basename(source)) });
}

export function copyTerminalPackages(root, app, platform = process.platform, arch = process.arch) {
  const from = (name) => path.join(root, 'node_modules', ...name.split('/'));
  const to = (name) => path.join(app, 'node_modules', ...name.split('/'));

  const pty = from('node-pty');
  const prebuilt = path.join(pty, 'prebuilds', `${platform}-${arch}`);
  if (!fs.existsSync(prebuilt)) {
    console.warn(`[build] node-pty has no prebuilt binary for ${platform}-${arch}: the Workspace terminal will use a pipe`);
  } else {
    fs.rmSync(to('node-pty'), { recursive: true, force: true });
    fs.mkdirSync(to('node-pty'), { recursive: true });
    fs.copyFileSync(path.join(pty, 'package.json'), path.join(to('node-pty'), 'package.json'));
    copyFiltered(path.join(pty, 'lib'), path.join(to('node-pty'), 'lib'));
    copyFiltered(prebuilt, path.join(to('node-pty'), 'prebuilds', `${platform}-${arch}`));
    // npm does not keep the executable bit of the macOS helper that starts the shell.
    const helper = path.join(to('node-pty'), 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }

  for (const [name, files] of [
    ['@xterm/xterm', ['package.json', 'lib/xterm.js', 'css/xterm.css']],
    ['@xterm/addon-fit', ['package.json', 'lib/addon-fit.js']],
  ]) {
    fs.rmSync(to(name), { recursive: true, force: true });
    for (const file of files) {
      const target = path.join(to(name), ...file.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(from(name), ...file.split('/')), target);
    }
  }
}
