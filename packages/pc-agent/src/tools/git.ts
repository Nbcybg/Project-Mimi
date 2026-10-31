import fs from 'node:fs/promises';
import { defineTool } from '@mimi/shared';
import { z } from 'zod';
import { runProcess, sanitizedEnv } from '../process.ts';
import { resolveAllowedPath } from './path-guard.ts';

const MAX_DIFF_CHARS = 200_000;
const MAX_OUTPUT = 2 * 1024 * 1024;

/** Files that should not be committed by accident. `.env.example` and friends stay allowed. */
const SECRET_FILE =
  /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.[^/]*)?|secrets?\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const ENV_TEMPLATE = /(^|\/)\.env\.(?:example|sample|template|dist)$/i;

function isSecretPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return !ENV_TEMPLATE.test(normalized) && SECRET_FILE.test(normalized);
}

/** What `git add -A` would touch, plus what is already staged. */
async function pendingPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const lists = await Promise.all([
    git(root, ['diff', '--name-only', '--diff-filter=ACMR'], signal),
    git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], signal),
    git(root, ['ls-files', '--others', '--exclude-standard'], signal),
  ]);
  for (const list of lists) {
    if (list.code !== 0) throw new Error(list.output || `git could not list changes (${list.code})`);
  }
  return [...new Set(lists.flatMap((list) => list.output.split(/\r?\n/).filter(Boolean)))];
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<{ output: string; code: number | null }> {
  let result;
  try {
    result = await runProcess('git', ['--no-pager', ...args], {
      cwd,
      env: sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' }),
      timeoutMs: 60_000,
      maxOutput: MAX_OUTPUT,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new Error(`Git is not available on this computer: ${(error as Error).message}`);
  }
  return { output: result.output.trimEnd(), code: result.exitCode };
}

async function repoRoot(requested: string | undefined, allowedDirs: string[], signal?: AbortSignal): Promise<{ root: string; cwd: string }> {
  const cwd = resolveAllowedPath(requested ?? '.', allowedDirs);
  const stat = await fs.stat(cwd);
  if (!stat.isDirectory()) throw new Error(`"${requested ?? '.'}" is not a folder.`);
  const top = await git(cwd, ['rev-parse', '--show-toplevel'], signal);
  if (top.code !== 0 || !top.output.trim()) throw new Error('This folder is not a git repository.');
  const root = top.output.trim();
  // The repository may sit above the folder the user allowed; never step outside the allowlist.
  resolveAllowedPath(root, allowedDirs);
  return { root, cwd };
}

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'Show a git repository\'s branch and changed files (porcelain status). The folder must be inside the allowed folders.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('A folder in the repository; defaults to the working folder'),
  }),
  summarize: (input) => `git status in ${input.path ?? '.'}`,
  async execute(input, context) {
    const { root } = await repoRoot(input.path, context.allowedDirs, context.signal);
    const result = await git(root, ['status', '--porcelain=v1', '--branch'], context.signal);
    if (result.code !== 0) throw new Error(result.output || `git status exited with ${result.code}`);
    return result.output || 'working tree clean';
  },
});

export const gitDiffTool = defineTool({
  name: 'git_diff',
  description: 'Show the git diff of a repository, optionally staged only or for one path, capped at max_chars.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('A folder in the repository; defaults to the working folder'),
    staged: z.boolean().optional().describe('Show the index instead of the working tree'),
    file: z.string().optional().describe('Limit to one path inside the repository'),
    max_chars: z.number().int().min(100).max(MAX_DIFF_CHARS).optional(),
  }),
  summarize: (input) => `git diff${input.staged ? ' --staged' : ''} in ${input.path ?? '.'}${input.file ? ` (${input.file})` : ''}`,
  async execute(input, context) {
    const { root } = await repoRoot(input.path, context.allowedDirs, context.signal);
    const args = ['diff', '--no-color', ...(input.staged ? ['--cached'] : []), '--'];
    if (input.file?.trim()) args.push(input.file.trim());
    const result = await git(root, args, context.signal);
    if (result.code !== 0) throw new Error(result.output || `git diff exited with ${result.code}`);
    const limit = input.max_chars ?? 80_000;
    return result.output ? result.output.slice(0, limit) + (result.output.length > limit ? `\n[truncated: ${result.output.length - limit} more characters]` : '') : '(no changes)';
  },
});

export const gitLogTool = defineTool({
  name: 'git_log',
  description: 'Show recent commits of a git repository (one line each), optionally for one path.',
  risk: 'read',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('A folder in the repository; defaults to the working folder'),
    limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
    file: z.string().optional(),
  }),
  summarize: (input) => `git log in ${input.path ?? '.'}${input.file ? ` (${input.file})` : ''}`,
  async execute(input, context) {
    const { root } = await repoRoot(input.path, context.allowedDirs, context.signal);
    const args = ['log', `-${input.limit ?? 20}`, '--oneline', '--decorate'];
    if (input.file?.trim()) args.push('--', input.file.trim());
    const result = await git(root, args, context.signal);
    if (result.code !== 0) throw new Error(result.output || `git log exited with ${result.code}`);
    return result.output || '(no commits yet)';
  },
});

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description:
    'Stage every change in a repository (unless add is false) and create one commit with the given message. It never pushes or merges, and it refuses to stage secret-looking files (.env, keys, credentials) unless allow_secrets is true. The user does the push.',
  risk: 'write',
  target: 'pc',
  inputSchema: z.object({
    path: z.string().optional().describe('A folder in the repository; defaults to the working folder'),
    message: z.string().min(1).max(500).describe('Commit message'),
    add: z.boolean().optional().describe('Stage all changes first (default true)'),
    allow_empty: z.boolean().optional().describe('Create a commit even when nothing changed'),
    allow_secrets: z.boolean().optional().describe('Also stage .env, key and credential files (default false)'),
  }),
  summarize: (input) => `git commit in ${input.path ?? '.'}: ${input.message.slice(0, 100)}`,
  async execute(input, context) {
    const { root } = await repoRoot(input.path, context.allowedDirs, context.signal);
    const secrets = (await pendingPaths(root, context.signal)).filter(isSecretPath);
    if (secrets.length > 0 && input.allow_secrets !== true) {
      const shown = secrets.slice(0, 10).join(', ');
      throw new Error(
        `Refusing to commit secret-looking files: ${shown}${secrets.length > 10 ? ` (+${secrets.length - 10} more)` : ''}. Add them to .gitignore, unstage them, or pass allow_secrets: true if they are meant to be committed.`,
      );
    }
    if (input.add !== false) {
      const staged = await git(root, ['add', '-A'], context.signal);
      if (staged.code !== 0) throw new Error(staged.output || `git add exited with ${staged.code}`);
    }
    const args = ['commit', '-m', input.message.trim()];
    if (input.allow_empty) args.push('--allow-empty');
    const result = await git(root, args, context.signal);
    if (result.code !== 0) throw new Error(result.output || `git commit exited with ${result.code}`);
    return result.output;
  },
});

export const gitTools = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool];
