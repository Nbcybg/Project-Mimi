import path from 'node:path';

export interface CoreConfig {
  rootDir: string;
  /**
   * Everything the user owns and could publish: `user/agents`, `user/tools`,
   * `user/skills`, `user/workflows`, plus the private folders `user/sessions`,
   * `user/memory`, `user/history` and `user/data`.
   */
  userDir: string;
  /** Machine-local state: database, secrets, caches, attachments, the app window profile. */
  dataDir: string;
  dbPath: string;
  /** One folder per agent: `agents/<name>/agent.md` (and its pictures). */
  agentsDir: string;
  /** opencode-style settings file: models, providers, compaction, memory. */
  settingsPath: string;
  /** Local copy of the models.dev catalog. */
  catalogCachePath: string;
  /** Never download the catalog; use the cached copy only. */
  catalogOffline: boolean;
  catalogUrl: string | undefined;
  /** One file per skill: `skills/<name>.md`. */
  skillsDir: string;
  /** One file per tool (`tools/<name>.json`) and tool presets (`tools/presets/<name>.json`). */
  toolsDir: string;
  /** Trigger definitions mirrored as `triggers/<id>.json` for syncing. */
  triggersDir: string;
  /** Always-on persona file, injected into every agent's prompt. */
  personaPath: string;
  /** Refresh token saved by `npm run google-auth`. */
  googleTokenPath: string;
  /** Refresh token saved by signing in to Microsoft in the app. */
  microsoftTokenPath: string;
  /** Keys, models and folders chosen inside the app (instead of editing .env). */
  appSettingsPath: string;
  /** Provider definitions as syncable files: `providers/<id>.json` (no secrets). */
  providersDir: string;
  /** API keys entered in the app; machine-local, never synced. */
  secretsPath: string;
  /** The user's own profile fields (`user/profile.json`). */
  userProfilePath: string;
  /** Values of profile fields marked "this machine only". */
  userProfileLocalPath: string;
  /** This server's Web Push (VAPID) key pair; machine-local. */
  pushKeysPath: string;
  /** VAPID contact sent to push services (`mailto:` or `https:`). */
  pushContact: string;
  /** Workflows (`workflows/<agent>/<name>.json`) and the state of their mail triggers. */
  workflowsDir: string;
  workflowStatePath: string;
  /** Provider credentials created by connecting a provider, in opencode's auth.json shape. */
  authPath: string;
  /** Files the user sent in chats. */
  filesDir: string;
  /** Readable mirrors of the database, kept for sync and backup. */
  sessionsDir: string;
  memoryDir: string;
  historyDir: string;
  /** Folder allowlist for file/shell tools. */
  allowedDirs: string[];
  /**
   * Run file/shell tools inside the core process when no PC agent is connected.
   * Right for a core running on the user's own machine, wrong for one in the cloud.
   */
  localPcTools: boolean;
  /** WebSocket/HTTP server. */
  host: string;
  port: number;
  /** Shared secret every client and the PC agent must present. */
  token: string | undefined;
  timezone: string;
  permissionTimeoutMs: number;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const rootDir = env.MIMI_ROOT ? path.resolve(env.MIMI_ROOT) : REPO_ROOT;
  // The user workspace: what a person can carry to another machine or publish.
  const userDir = path.resolve(rootDir, env.MIMI_USER ?? 'user');
  // Machine-local state lives inside it, so one folder is the whole install.
  const dataDir = path.join(userDir, 'data');
  const allowedDirs = (env.ALLOWED_DIRS ?? '')
    .split(';')
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.resolve(rootDir, dir));

  return {
    rootDir,
    userDir,
    dataDir,
    dbPath: env.MIMI_DB === ':memory:' ? ':memory:' : path.resolve(rootDir, env.MIMI_DB ?? path.join(userDir, 'data/mimi.db')),
    agentsDir: path.join(userDir, 'agents'),
    settingsPath: path.resolve(rootDir, env.MIMI_CONFIG ?? 'mimi.json'),
    catalogCachePath: path.join(dataDir, 'models-dev.json'),
    catalogOffline: env.MIMI_MODELS_OFFLINE === '1' || env.MIMI_MODELS_OFFLINE === 'true',
    catalogUrl: env.MIMI_MODELS_URL || undefined,
    skillsDir: path.join(userDir, 'skills'),
    toolsDir: path.join(userDir, 'tools'),
    triggersDir: path.join(userDir, 'triggers'),
    personaPath: path.join(userDir, 'persona.md'),
    googleTokenPath: path.join(dataDir, 'google-token.json'),
    microsoftTokenPath: path.join(dataDir, 'microsoft-token.json'),
    appSettingsPath: path.join(dataDir, 'app-settings.json'),
    providersDir: path.join(userDir, 'providers'),
    secretsPath: path.join(dataDir, 'secrets.json'),
    userProfilePath: path.join(userDir, 'profile.json'),
    userProfileLocalPath: path.join(dataDir, 'profile-local.json'),
    pushKeysPath: path.join(dataDir, 'push-vapid.json'),
    pushContact: env.MIMI_PUSH_CONTACT ?? 'mailto:mimi@localhost',
    workflowsDir: path.join(userDir, 'workflows'),
    workflowStatePath: path.join(dataDir, 'workflow-state.json'),
    authPath: path.join(dataDir, 'auth.json'),
    filesDir: path.join(dataDir, 'files'),
    sessionsDir: path.join(userDir, 'sessions'),
    memoryDir: path.join(userDir, 'memory'),
    historyDir: path.join(userDir, 'history'),
    allowedDirs: allowedDirs.length > 0 ? allowedDirs : [path.join(userDir, 'workspace')],
    localPcTools: env.MIMI_LOCAL_PC_TOOLS !== '0' && env.MIMI_LOCAL_PC_TOOLS !== 'false',
    host: env.MIMI_HOST ?? '127.0.0.1',
    port: positiveInt(env.PORT ?? env.MIMI_PORT, 8787),
    token: env.MIMI_TOKEN || undefined,
    timezone: env.MIMI_TIMEZONE ?? 'Asia/Bangkok',
    permissionTimeoutMs: positiveInt(env.PERMISSION_TIMEOUT_MS, 120_000),
  };
}
