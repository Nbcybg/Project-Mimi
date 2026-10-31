import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { runCommand, runProcess, sanitizedEnv } from '../process.ts';
import { resolveAllowedPath } from './path-guard.ts';

const existsSync = fsSync.existsSync;
const STATE_DIR = '.mimi-workspace';
const CHECKPOINT_REF = 'refs/mimi/checkpoints/';
const GIT_TIMEOUT_MS = 60_000;
const DEFAULT_DIFF_CHARS = 40_000;
const MAX_DIFF_CHARS = 200_000;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const MAX_RUN_TIMEOUT_MS = 600_000;

interface GitInfo {
  repo: boolean;
  root?: string;
  branch?: string;
  initialized?: boolean;
  error?: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function statDirectory(target: string): Promise<void> {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error(`"${target}" is not a folder.`);
}

function relative(root: string, target: string): string {
  const value = path.relative(root, target);
  if (!value || value.startsWith('..') || path.isAbsolute(value)) throw new Error(`"${target}" is outside the workspace.`);
  return value;
}

function safeJoin(root: string, rel: string): string {
  const target = path.resolve(root, rel);
  relative(root, target);
  return target;
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ output: string; code: number | null }> {
  let result;
  try {
    result = await runProcess('git', ['--no-pager', ...args], {
      cwd,
      env: sanitizedEnv({
        GIT_AUTHOR_NAME: 'Mimi',
        GIT_AUTHOR_EMAIL: 'mimi@localhost',
        GIT_COMMITTER_NAME: 'Mimi',
        GIT_COMMITTER_EMAIL: 'mimi@localhost',
        ...options.env,
      }),
      timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxOutput: 2 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new Error(`Git is not available on this computer: ${(error as Error).message}. Install Git and try again.`);
  }
  return { output: result.output.trimEnd(), code: result.exitCode };
}

async function gitOrThrow(cwd: string, args: string[], options: { env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.output.trim() || `exit code ${result.code}`}`);
  return result.output;
}

async function addExclude(root: string, signal?: AbortSignal): Promise<void> {
  const gitDir = (await gitOrThrow(root, ['rev-parse', '--git-dir'], { signal })).trim();
  const dir = path.resolve(root, gitDir, 'info');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  if (current.split(/\r?\n/).includes(`${STATE_DIR}/`)) return;
  await fs.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${STATE_DIR}/\n`, 'utf8');
}

/** Finds (or creates) the git repository and refuses a root outside the allowed folders. */
async function ensureGit(root: string, allowedDirs: string[], signal?: AbortSignal): Promise<GitInfo> {
  const top = await git(root, ['rev-parse', '--show-toplevel'], { signal });
  let repoRoot = root;
  let initialized = false;
  if (top.code !== 0 || !top.output.trim()) {
    await gitOrThrow(root, ['init'], { signal });
    initialized = true;
    repoRoot = (await gitOrThrow(root, ['rev-parse', '--show-toplevel'], { signal })).trim();
  } else {
    repoRoot = top.output.trim();
  }
  resolveAllowedPath(repoRoot, allowedDirs);
  await addExclude(repoRoot, signal);
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal });
  return { repo: true, root: repoRoot, initialized, ...(branch.code === 0 && branch.output !== 'HEAD' ? { branch: branch.output } : {}) };
}

async function gitInfo(root: string, allowedDirs: string[], signal?: AbortSignal): Promise<GitInfo> {
  const top = await git(root, ['rev-parse', '--show-toplevel'], { signal });
  if (top.code !== 0 || !top.output.trim()) return { repo: false };
  const repoRoot = top.output.trim();
  try {
    resolveAllowedPath(repoRoot, allowedDirs);
  } catch {
    return { repo: false, error: 'the git repository root is outside the allowed folders' };
  }
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal });
  return { repo: true, root: repoRoot, ...(branch.code === 0 && branch.output !== 'HEAD' ? { branch: branch.output } : {}) };
}

function packageManager(root: string): string {
  if (fsSync.existsSync(path.join(root, 'pnpm-lock.yaml'))) return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  if (fsSync.existsSync(path.join(root, 'yarn.lock'))) return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
  if (fsSync.existsSync(path.join(root, 'bun.lockb')) || fsSync.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

async function testCommandFor(root: string): Promise<{ command: string; source: string } | null> {
  const packageFile = path.join(root, 'package.json');
  if (await exists(packageFile)) {
    try {
      const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8')) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.test;
      if (script && !/no test specified/i.test(script)) {
        return { command: `${packageManager(root)} test`, source: 'package.json scripts.test' };
      }
    } catch {
      // an unreadable package.json is not a test command
    }
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) return { command: 'cargo test', source: 'Cargo.toml' };
  if (existsSync(path.join(root, 'go.mod'))) return { command: 'go test ./...', source: 'go.mod' };
  if (existsSync(path.join(root, 'pytest.ini')) || existsSync(path.join(root, 'tox.ini')) || existsSync(path.join(root, 'pyproject.toml'))) {
    return { command: 'pytest -q', source: 'pytest configuration' };
  }
  if (existsSync(path.join(root, 'Makefile'))) return { command: 'make test', source: 'Makefile' };
  return null;
}

function commandBlock(command: string): string | null {
  const hard = [
    /\bgit\s+push\b/i,
    /\bgit\s+merge\b/i,
    /\bgit\s+rebase\b/i,
    /\bgit\s+commit\b/i,
    /\bgh\s+pr\s+merge\b/i,
    /\bgh\s+release\b/i,
    /\b(?:npm|pnpm|yarn)\s+publish\b/i,
    /\bdocker\s+push\b/i,
  ];
  for (const pattern of hard) {
    if (pattern.test(command)) return 'Mimi never pushes, merges, publishes or commits in a workspace; the user does that.';
  }
  const destructive = [
    /\brm\s+-[a-z]*r[a-z]*f\b/i,
    /\brm\s+-[a-z]*f[a-z]*r\b/i,
    /\brmdir\s+\/s\b/i,
    /\bdel\s+\/[a-z]*[sq]\b/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[a-z]*f/i,
    /\bgit\s+checkout\s+--\s+\./i,
    /\bgit\s+restore\b/i,
    /\bformat\s+[a-z]:/i,
    /\bmkfs\b/i,
    /^(?:shutdown|reboot|halt)\b/i,
    /\b(?:shutdown|Restart-Computer|Stop-Computer)\b/i,
    /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force/i,
  ];
  for (const pattern of destructive) {
    if (pattern.test(command)) return 'This command is destructive; pass allow_destructive: true only after the user approved it.';
  }
  return null;
}

export function isWorkspaceDestructive(command: string): boolean {
  return commandBlock(command)?.includes('destructive') === true;
}

export function isWorkspaceCommandBlocked(command: string): boolean {
  return commandBlock(command)?.includes('never pushes') === true;
}

async function createWorkspace(root: string, allowedDirs: string[], initGit: boolean, signal?: AbortSignal) {
  await fs.mkdir(root, { recursive: true });
  await statDirectory(root);
  const gitInfoResult = initGit ? await ensureGit(root, allowedDirs, signal) : await gitInfo(root, allowedDirs, signal);
  const test = await testCommandFor(root);
  const summary = `Workspace ${root} ready${gitInfoResult.repo ? ` (git: ${gitInfoResult.root}${gitInfoResult.branch ? `, ${gitInfoResult.branch}` : ''})` : ''}${test ? `; test: ${test.command}` : '; no test command detected'}.`;
  return JSON.stringify({ ok: true, path: root, git: gitInfoResult, testCommand: test, summary }, null, 2);
}

async function inspectWorkspace(root: string, allowedDirs: string[], signal?: AbortSignal) {
  await statDirectory(root);
  const gitInfoResult = await gitInfo(root, allowedDirs, signal);
  const test = await testCommandFor(root);
  let status: { branch?: string; clean: boolean; changes: string[] } | undefined;
  if (gitInfoResult.repo && gitInfoResult.root) {
    const raw = await git(gitInfoResult.root, ['status', '--porcelain=v1', '--branch'], { signal });
    const lines = raw.code === 0 ? raw.output.split(/\r?\n/).filter(Boolean) : [];
    const branchLine = lines.find((line) => line.startsWith('## '));
    const changes = lines.filter((line) => !line.startsWith('## '));
    status = {
      ...(branchLine ? { branch: branchLine.slice(3).split('...')[0] } : {}),
      clean: changes.length === 0,
      changes: changes.slice(0, 40),
    };
  }
  let files = 0;
  if (gitInfoResult.repo && gitInfoResult.root) {
    const listed = await git(gitInfoResult.root, ['ls-files'], { signal });
    if (listed.code === 0) files = listed.output.split(/\r?\n/).filter(Boolean).length;
  } else {
    files = (await fs.readdir(root)).length;
  }
  const summary = `Workspace ${root}${status ? `: ${status.clean ? 'clean' : `${status.changes.length} change(s)`}` : ' (not a git repository)'}; ${files} file(s)${test ? `; test: ${test.command}` : '; no test command detected'}.`;
  return JSON.stringify({ ok: true, path: root, git: gitInfoResult, status, files, testCommand: test, summary }, null, 2);
}

async function runInWorkspace(
  root: string,
  command: string,
  options: { timeoutMs: number; allowDestructive: boolean; signal?: AbortSignal },
) {
  const block = commandBlock(command);
  if (block) {
    if (block.includes('never pushes') || !options.allowDestructive) throw new Error(block);
  }
  const result = await runCommand(command, {
    cwd: root,
    env: sanitizedEnv(),
    timeoutMs: options.timeoutMs,
    maxOutput: 30_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
  const summary = ok
    ? `Command passed: ${command}`
    : `Command ${result.cancelled ? 'was stopped' : result.timedOut ? 'timed out' : `failed (exit ${result.exitCode})`}: ${command}`;
  return JSON.stringify(
    {
      ok,
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
      output: result.output,
      summary,
    },
    null,
    2,
  );
}

async function checkpoint(
  root: string,
  allowedDirs: string[],
  label: string | undefined,
  signal?: AbortSignal,
) {
  const info = await ensureGit(root, allowedDirs, signal);
  await fs.mkdir(path.join(root, STATE_DIR, 'checkpoints'), { recursive: true });
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const stateIndex = path.join(root, STATE_DIR, 'checkpoints', `${id}.index`);
  const env = { GIT_INDEX_FILE: stateIndex.replaceAll('\\', '/') };
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'], { signal });
  if (head.code === 0) await gitOrThrow(root, ['read-tree', 'HEAD'], { env, signal });
  else await gitOrThrow(root, ['read-tree', '--empty'], { env, signal });
  await gitOrThrow(root, ['add', '-A'], { env, signal });
  const tree = (await gitOrThrow(root, ['write-tree'], { env, signal })).trim();
  const message = `mimi checkpoint${label ? `: ${label}` : ''}`;
  const commit = (
    await gitOrThrow(root, head.code === 0 ? ['commit-tree', tree, '-p', 'HEAD', '-m', message] : ['commit-tree', tree, '-m', message], {
      env,
      signal,
    })
  ).trim();
  await gitOrThrow(root, ['update-ref', `${CHECKPOINT_REF}${id}`, commit], { signal });
  await fs.rm(stateIndex, { force: true });
  const meta = { id, commit, createdAt: new Date().toISOString(), label: label ?? '', path: root };
  await fs.writeFile(path.join(root, STATE_DIR, 'checkpoints', `${id}.json`), JSON.stringify(meta, null, 2), 'utf8');
  return JSON.stringify(
    {
      ok: true,
      id,
      commit,
      path: root,
      repository: info.root,
      summary: `Checkpoint ${id} saved${label ? ` (${label})` : ''}.`,
    },
    null,
    2,
  );
}

async function diff(
  root: string,
  allowedDirs: string[],
  checkpointId: string | undefined,
  maxChars: number,
  expectClean: boolean,
  signal?: AbortSignal,
) {
  const info = await gitInfo(root, allowedDirs, signal);
  if (!info.repo || !info.root) throw new Error('Not a git repository; run workspace_create first.');
  let ref = '';
  let env: Record<string, string> = {};
  let tempIndex: string | undefined;
  try {
    if (checkpointId) {
      ref = `${CHECKPOINT_REF}${checkpointId}`;
      const verify = await git(info.root, ['rev-parse', '--verify', ref], { signal });
      if (verify.code !== 0) throw new Error(`No checkpoint "${checkpointId}".`);
      // The checkpoint may hold files the real index never tracked. A temporary
      // index at the checkpoint makes status/diff compare like with like.
      await fs.mkdir(path.join(root, STATE_DIR, 'checkpoints'), { recursive: true });
      tempIndex = path.join(root, STATE_DIR, 'checkpoints', `diff-${randomUUID()}.index`);
      env = { GIT_INDEX_FILE: tempIndex.replaceAll('\\', '/') };
      await gitOrThrow(info.root, ['read-tree', ref], { env, signal });
    }
    const statusResult = await git(info.root, ['status', '--porcelain=v1', '--branch'], { env, signal });
    const statusLines = statusResult.code === 0 ? statusResult.output.split(/\r?\n/).filter(Boolean) : [];
    const changes = statusLines.filter((line) => !line.startsWith('## '));
    const untrackedResult = await git(info.root, ['ls-files', '--others', '--exclude-standard'], { env, signal });
    const untracked = untrackedResult.code === 0 ? untrackedResult.output.split(/\r?\n/).filter(Boolean) : [];
    const diffResult = await git(
      info.root,
      ref ? ['diff', '--no-color', ref, '--'] : ['diff', '--no-color', '--'],
      { env, signal },
    );
    const text = diffResult.output.slice(0, maxChars);
    // Against a checkpoint only the diff and untracked files matter: status also
    // compares the index with HEAD, which is unrelated to the checkpoint.
    const clean = untracked.length === 0 && text.trim() === '' && (ref ? true : changes.length === 0);
    const ok = expectClean ? clean : diffResult.code === 0;
    const summary = expectClean
      ? clean
        ? 'The workspace matches the checkpoint.'
        : `The workspace differs from the checkpoint (${changes.length} change(s), ${untracked.length} untracked).`
      : `${changes.length} change(s), ${untracked.length} untracked file(s).`;
    return JSON.stringify(
      {
        ok,
        checkpoint: checkpointId ?? null,
        summary,
        clean,
        status: changes,
        untracked,
        diff: text,
        truncated: diffResult.output.length > text.length,
      },
      null,
      2,
    );
  } finally {
    if (tempIndex) await fs.rm(tempIndex, { force: true });
  }
}

async function undo(root: string, allowedDirs: string[], checkpointId: string, signal?: AbortSignal) {
  await ensureGit(root, allowedDirs, signal);
  const ref = `${CHECKPOINT_REF}${checkpointId}`;
  await gitOrThrow(root, ['rev-parse', '--verify', ref], { signal });
  const backupDir = path.join(root, STATE_DIR, 'undo', new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(backupDir, { recursive: true });

  const checkpointFiles = new Set(
    (await gitOrThrow(root, ['ls-tree', '-r', '--name-only', '-z', ref], { signal })).split('\0').filter(Boolean),
  );
  const tracked = (await gitOrThrow(root, ['ls-files', '-z'], { signal })).split('\0').filter(Boolean);
  const untracked = (await gitOrThrow(root, ['ls-files', '--others', '--exclude-standard', '-z'], { signal })).split('\0').filter(Boolean);
  const changed = (await gitOrThrow(root, ['diff', '--name-only', '-z', ref, '--'], { signal })).split('\0').filter(Boolean);
  const backUp = new Set([...changed, ...untracked, ...tracked.filter((file) => !checkpointFiles.has(file))]);

  let backedUp = 0;
  for (const rel of backUp) {
    try {
      const source = safeJoin(root, rel);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const destination = path.join(backupDir, rel);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      backedUp++;
    } catch {
      // deleted or unreadable: nothing to copy
    }
  }

  const removeFiles = new Set([...untracked, ...tracked.filter((file) => !checkpointFiles.has(file))]);
  let removed = 0;
  for (const rel of removeFiles) {
    try {
      const target = safeJoin(root, rel);
      if (target === backupDir || target.startsWith(`${backupDir}${path.sep}`)) continue;
      await fs.rm(target, { force: true });
      removed++;
    } catch {
      // already gone
    }
  }

  await gitOrThrow(root, ['read-tree', ref], { signal });
  await gitOrThrow(root, ['checkout-index', '-a', '-f'], { signal });
  const summary = `Restored ${checkpointFiles.size} file(s) from checkpoint ${checkpointId}; ${removed} file(s) added after it were moved to the backup.`;
  return JSON.stringify(
    {
      ok: true,
      checkpoint: checkpointId,
      path: root,
      restored: checkpointFiles.size,
      removed,
      backedUp,
      backupDir,
      summary,
    },
    null,
    2,
  );
}

export const workspaceCreateTool = defineTool({
  name: 'workspace_create',
  description:
    'Create a workspace folder inside the allowed folders and initialize git when it is missing. Detects the test command. Use this before a developer task.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().min(1).describe('Workspace folder (inside the allowed folders)'),
    init_git: z.boolean().optional().describe('Initialize git when missing (default true)'),
  }),
  summarize: (input) => `Create workspace ${input.path}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path, context.allowedDirs);
    return createWorkspace(root, context.allowedDirs, input.init_git !== false, context.signal);
  },
});

export const workspaceInfoTool = defineTool({
  name: 'workspace_info',
  description:
    'Inspect a workspace: git branch and changes, file count, and the test command detected from package.json, Cargo.toml, go.mod, pytest or Makefile.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Workspace folder; defaults to the working folder'),
  }),
  summarize: (input) => `Inspect workspace ${input.path ?? '.'}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    return inspectWorkspace(root, context.allowedDirs, context.signal);
  },
});

export const workspaceRunTool = defineTool({
  name: 'workspace_run',
  description:
    'Run a command in a workspace with the saved environment (no API keys), a timeout, capped output, and a destructive-command policy. Git push, merge, rebase, commit and publish are always blocked; destructive commands need allow_destructive.',
  risk: 'shell',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Workspace folder; defaults to the working folder'),
    command: z.string().min(1).describe('Command to run, e.g. npm test'),
    timeout_ms: z.number().int().min(1_000).max(MAX_RUN_TIMEOUT_MS).optional(),
    allow_destructive: z.boolean().optional().describe('Only after the user approved a destructive command'),
  }),
  summarize: (input) => `Run in workspace ${input.path ?? '.'}: ${input.command}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    await statDirectory(root);
    return runInWorkspace(root, input.command, {
      timeoutMs: input.timeout_ms ?? DEFAULT_RUN_TIMEOUT_MS,
      allowDestructive: input.allow_destructive === true,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  },
});

export const workspaceCheckpointTool = defineTool({
  name: 'workspace_checkpoint',
  description:
    'Save a git checkpoint of the workspace (tracked and untracked files) under refs/mimi/checkpoints without changing HEAD or the index. Use it before edits so workspace_undo can restore everything.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('Workspace folder; defaults to the working folder'),
    label: z.string().max(120).optional(),
  }),
  summarize: (input) => `Checkpoint workspace ${input.path ?? '.'}${input.label ? `: ${input.label}` : ''}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    await statDirectory(root);
    return checkpoint(root, context.allowedDirs, input.label, context.signal);
  },
});

export const workspaceDiffTool = defineTool({
  name: 'workspace_diff',
  description:
    'Show the git diff and status of a workspace, optionally against a checkpoint. With expect_clean it reports whether the workspace matches the checkpoint.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional(),
    checkpoint: z.string().optional().describe('Checkpoint id from workspace_checkpoint'),
    max_chars: z.number().int().min(1_000).max(MAX_DIFF_CHARS).optional(),
    expect_clean: z.boolean().optional(),
  }),
  summarize: (input) => `Diff workspace ${input.path ?? '.'}${input.checkpoint ? ` from ${input.checkpoint}` : ''}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    await statDirectory(root);
    return diff(root, context.allowedDirs, input.checkpoint, input.max_chars ?? DEFAULT_DIFF_CHARS, input.expect_clean === true, context.signal);
  },
});

export const workspaceUndoTool = defineTool({
  name: 'workspace_undo',
  description:
    'Restore a workspace to a checkpoint. Files added or changed after the checkpoint are first copied to .mimi-workspace/undo; nothing is permanently deleted. HEAD is not moved.',
  risk: 'delete',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional(),
    checkpoint: z.string().min(1).describe('Checkpoint id from workspace_checkpoint'),
  }),
  summarize: (input) => `Undo workspace ${input.path ?? '.'} to ${input.checkpoint}`,
  async execute(input, context) {
    const root = resolveAllowedPath(input.path ?? '.', context.allowedDirs);
    await statDirectory(root);
    return undo(root, context.allowedDirs, input.checkpoint, context.signal);
  },
});

export const workspaceTools = [
  workspaceCreateTool,
  workspaceInfoTool,
  workspaceRunTool,
  workspaceCheckpointTool,
  workspaceDiffTool,
  workspaceUndoTool,
];
