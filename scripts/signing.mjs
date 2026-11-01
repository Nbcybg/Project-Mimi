import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Code signing for the desktop builds. Every step is optional: without the variables below
// the builds stay unsigned (Windows) or ad hoc signed (macOS), as before. Secrets come from the
// environment only (CI secrets); nothing here writes them to the repository or the logs.
//
// Windows (Authenticode, signtool from the Windows SDK):
//   WIN_CSC_FILE      path to a .pfx, or WIN_CSC_BASE64 with the .pfx as base64
//   WIN_CSC_PASSWORD  its password
//   SIGNTOOL          optional path to signtool.exe; else PATH and the Windows Kits folders
//   WIN_TIMESTAMP_URL optional; default http://timestamp.digicert.com
// macOS (Developer ID + notarization; the certificate must already be in a keychain):
//   APPLE_SIGN_IDENTITY  e.g. "Developer ID Application: Example Co (ABCDE12345)"
//   APPLE_ID, APPLE_APP_PASSWORD (app-specific password), APPLE_TEAM_ID  for notarytool

const log = (line) => console.log(`[sign] ${line}`);

function findSigntool(env = process.env) {
  const candidates = [env.SIGNTOOL, ...String(env.PATH ?? '').split(path.delimiter).map((dir) => dir && path.join(dir, 'signtool.exe'))];
  for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles]) {
    const kits = base && path.join(base, 'Windows Kits', '10', 'bin');
    if (!kits || !fs.existsSync(kits)) continue;
    // Newest SDK first.
    const versions = fs.readdirSync(kits).filter((name) => /^10\./.test(name)).sort().reverse();
    for (const version of versions) candidates.push(path.join(kits, version, 'x64', 'signtool.exe'));
  }
  return candidates.find((file) => file && fs.existsSync(file)) ?? null;
}

/** Signs Windows executables in place; returns false (and signs nothing) when no certificate is set. */
export function signWindows(files, env = process.env) {
  if (!env.WIN_CSC_FILE && !env.WIN_CSC_BASE64) {
    log('no WIN_CSC_FILE / WIN_CSC_BASE64: Windows files stay unsigned (SmartScreen will warn)');
    return false;
  }
  const signtool = findSigntool(env);
  if (!signtool) throw new Error('a signing certificate is set but signtool.exe was not found (install the Windows SDK or set SIGNTOOL)');
  let pfx = env.WIN_CSC_FILE;
  let temp = null;
  if (!pfx) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-sign-'));
    pfx = path.join(temp, 'cert.pfx');
    fs.writeFileSync(pfx, Buffer.from(env.WIN_CSC_BASE64, 'base64'), { mode: 0o600 });
  }
  try {
    const timestamp = env.WIN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
    for (const file of files) {
      // stdio is not inherited: signtool would echo nothing secret, but the command line holds the password.
      execFileSync(signtool, ['sign', '/fd', 'sha256', '/tr', timestamp, '/td', 'sha256', '/f', pfx, '/p', env.WIN_CSC_PASSWORD ?? '', file], { stdio: 'pipe' });
      execFileSync(signtool, ['verify', '/pa', file], { stdio: 'pipe' });
      log(`signed ${path.basename(file)}`);
    }
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
  return true;
}

/**
 * Signs the app bundle: with a Developer ID and the hardened runtime when APPLE_SIGN_IDENTITY
 * is set, else ad hoc. Returns whether it carries a Developer ID.
 */
export function signMac(bundle, entitlements, env = process.env) {
  const identity = env.APPLE_SIGN_IDENTITY;
  if (!identity) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    log('signed ad hoc (no APPLE_SIGN_IDENTITY): macOS asks the user to confirm the first start');
    return false;
  }
  execFileSync(
    'codesign',
    ['--force', '--deep', '--options', 'runtime', '--timestamp', '--entitlements', entitlements, '--sign', identity, bundle],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], { stdio: 'inherit' });
  log(`signed with ${identity}`);
  return true;
}

/**
 * Sends the zipped bundle to Apple's notary service and staples the ticket to the bundle.
 * Returns false when the Apple ID variables are not set. The caller zips again afterwards.
 */
export function notarizeMac(bundle, zip, env = process.env) {
  if (!env.APPLE_ID || !env.APPLE_APP_PASSWORD || !env.APPLE_TEAM_ID) {
    log('no APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID: not notarized');
    return false;
  }
  log('notarizing (this can take a few minutes)...');
  execFileSync(
    'xcrun',
    ['notarytool', 'submit', zip, '--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_PASSWORD, '--team-id', env.APPLE_TEAM_ID, '--wait'],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  execFileSync('xcrun', ['stapler', 'staple', bundle], { stdio: 'inherit' });
  execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose', bundle], { stdio: 'inherit' });
  log('notarized and stapled');
  return true;
}
