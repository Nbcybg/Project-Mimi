import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Accounts of the gateway: who may sign in, and where each person's own core runs.
 * Every person has a separate core (a Railway service with its own volume); this store
 * only holds the way in: a password hash, sessions, and the token of that core.
 *
 * - Passwords: scrypt with a random salt per account; never stored or logged in clear.
 * - Sessions: random tokens handed to the device; only their SHA-256 is stored, so a copy
 *   of the database cannot be used to sign in. They lapse after `idleDays` without use.
 * - Core tokens: needed in clear to reach the core, so they are encrypted with a key
 *   derived from the gateway secret (MIMI_GATEWAY_SECRET), which is not in the database.
 */

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 256;
/** A session's expiry is pushed forward at most this often, to keep writes rare. */
const TOUCH_EVERY_MS = 10 * 60_000;

export interface AccountView {
  username: string;
  coreUrl: string;
  /** Path prefix of this person's webhooks on the gateway: `/h/<id>`. */
  webhookBase: string;
  createdAt: string;
  disabled: boolean;
  sessions: number;
}

/** What a valid session opens: the person's core and how to talk to it. */
export interface SessionTarget {
  sessionId: string;
  username: string;
  coreUrl: string;
  coreToken: string;
  webhookBase: string;
  expiresAt: string;
}

export class AccountError extends Error {}

function hashScrypt(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT.keylen, { N: cost, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** `cost` is scrypt's N; only tests lower it. The cost is stored with each hash. */
export async function hashPassword(password: string, cost: number = SCRYPT.N): Promise<string> {
  const salt = randomBytes(16);
  const key = await hashScrypt(password, salt, cost);
  return `scrypt$${cost}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export function normalizeUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (!USERNAME.test(username)) {
    throw new AccountError('A username is 3-32 characters: a-z, 0-9, ".", "_" or "-", starting with a letter or digit.');
  }
  return username;
}

export function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD) throw new AccountError(`A password needs at least ${MIN_PASSWORD} characters.`);
  if (password.length > MAX_PASSWORD) throw new AccountError(`A password has at most ${MAX_PASSWORD} characters.`);
}

/** Only an origin: scheme, host and port (e.g. http://mimi-alice.railway.internal:8080). */
export function normalizeCoreUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AccountError(`"${raw}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AccountError('The core URL must start with http:// or https://.');
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new AccountError('The core URL is only scheme, host and port, e.g. http://mimi-alice.railway.internal:8080');
  }
  return url.origin;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  core_url: string;
  core_token: string;
  route_id: string;
  created_at: string;
  disabled_at: string | null;
}

export class AccountStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly passwordCost: number;
  /** Compared against when a username is unknown, so both cases take as long. */
  private dummyHash: Promise<string> | undefined;

  /** `passwordCost`: scrypt N for new hashes; leave it alone outside tests. */
  constructor(file: string, secret: string, options: { idleDays?: number; now?: () => number; passwordCost?: number } = {}) {
    if (secret.length < 32) throw new AccountError('MIMI_GATEWAY_SECRET must be at least 32 characters.');
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Created owner-only; better-sqlite3 keeps the mode of an existing file.
      if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
    }
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        core_url TEXT NOT NULL,
        core_token TEXT NOT NULL,
        route_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        disabled_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    `);
    this.key = Buffer.from(hkdfSync('sha256', secret, 'mimi-gateway', 'core-token', 32));
    this.idleMs = (options.idleDays ?? 30) * 86_400_000;
    this.now = options.now ?? Date.now;
    this.passwordCost = options.passwordCost ?? SCRYPT.N;
  }

  close(): void {
    this.db.close();
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now() + offsetMs).toISOString();
  }

  private seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  }

  private open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(':');
    if (version !== 'v1' || !iv || !tag || !data) throw new AccountError('Unreadable core token.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // Wrong MIMI_GATEWAY_SECRET or a damaged row; the token itself never appears in the message.
      throw new AccountError('The core token cannot be decrypted (was MIMI_GATEWAY_SECRET changed?).');
    }
  }

  private row(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  private mustRow(raw: string): UserRow {
    const row = this.row(normalizeUsername(raw));
    if (!row) throw new AccountError(`No account "${raw}".`);
    return row;
  }

  /** Creates an account; returns the token its core must be started with (shown once). */
  async create(rawUsername: string, password: string, coreUrl: string): Promise<{ coreToken: string; webhookBase: string }> {
    const username = normalizeUsername(rawUsername);
    checkPassword(password);
    const url = normalizeCoreUrl(coreUrl);
    if (this.row(username)) throw new AccountError(`The account "${username}" already exists.`);
    const coreToken = newToken();
    const routeId = randomBytes(12).toString('base64url');
    this.db
      .prepare('INSERT INTO users (id, username, password_hash, core_url, core_token, route_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomBytes(12).toString('hex'), username, await hashPassword(password, this.passwordCost), url, this.seal(coreToken), routeId, this.iso());
    return { coreToken, webhookBase: `/h/${routeId}` };
  }

  list(): AccountView[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[];
    const live = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?');
    return rows.map((row) => ({
      username: row.username,
      coreUrl: row.core_url,
      webhookBase: `/h/${row.route_id}`,
      createdAt: row.created_at,
      disabled: row.disabled_at !== null,
      sessions: (live.get(row.id, this.iso()) as { n: number }).n,
    }));
  }

  /** A new password also signs out every device. */
  async setPassword(rawUsername: string, password: string): Promise<void> {
    const row = this.mustRow(rawUsername);
    checkPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password, this.passwordCost), row.id);
    this.revokeAll(row.username);
  }

  setCoreUrl(rawUsername: string, coreUrl: string): void {
    const row = this.mustRow(rawUsername);
    this.db.prepare('UPDATE users SET core_url = ? WHERE id = ?').run(normalizeCoreUrl(coreUrl), row.id);
  }

  /** A fresh core token; the core must be restarted with it. */
  rotateCoreToken(rawUsername: string): string {
    const row = this.mustRow(rawUsername);
    const coreToken = newToken();
    this.db.prepare('UPDATE users SET core_token = ? WHERE id = ?').run(this.seal(coreToken), row.id);
    return coreToken;
  }

  setDisabled(rawUsername: string, disabled: boolean): void {
    const row = this.mustRow(rawUsername);
    this.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabled ? this.iso() : null, row.id);
    if (disabled) this.revokeAll(row.username);
  }

  /** Signs out every device of an account; returns how many sessions ended. */
  revokeAll(rawUsername: string): number {
    const row = this.mustRow(rawUsername);
    return this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.iso(), row.id).changes;
  }

  /** Checks a password; on success opens a session. Unknown, disabled and wrong all look the same. */
  async login(rawUsername: string, password: string): Promise<{ token: string; target: SessionTarget } | null> {
    let username: string;
    try {
      username = normalizeUsername(rawUsername);
    } catch {
      username = '';
    }
    const row = username ? this.row(username) : undefined;
    if (!row || row.disabled_at !== null || typeof password !== 'string' || password.length > MAX_PASSWORD) {
      this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'), this.passwordCost);
      await verifyPassword(String(password).slice(0, MAX_PASSWORD), await this.dummyHash);
      return null;
    }
    if (!(await verifyPassword(password, row.password_hash))) return null;
    const token = newToken();
    const id = randomBytes(12).toString('hex');
    this.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, row.id, sha256(token), this.iso(), this.iso(), this.iso(this.idleMs));
    return { token, target: this.target(row, id, this.iso(this.idleMs)) };
  }

  private target(row: UserRow, sessionId: string, expiresAt: string): SessionTarget {
    return {
      sessionId,
      username: row.username,
      coreUrl: row.core_url,
      coreToken: this.open(row.core_token),
      webhookBase: `/h/${row.route_id}`,
      expiresAt,
    };
  }

  /** The session behind a token, or null when it is unknown, revoked, expired or its account is disabled. */
  session(token: unknown): SessionTarget | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const found = this.db
      .prepare(
        `SELECT s.id AS session_id, s.last_used_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
      )
      .get(sha256(token)) as (UserRow & { session_id: string; last_used_at: string; expires_at: string }) | undefined;
    if (!found || found.disabled_at !== null || Date.parse(found.expires_at) <= this.now()) return null;
    let expiresAt = found.expires_at;
    if (this.now() - Date.parse(found.last_used_at) > TOUCH_EVERY_MS) {
      expiresAt = this.iso(this.idleMs);
      this.db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(this.iso(), expiresAt, found.session_id);
    }
    return this.target(found, found.session_id, expiresAt);
  }

  /** True while a session id (of a connection already open) may go on. */
  sessionLive(sessionId: string): boolean {
    const found = this.db
      .prepare('SELECT s.expires_at, u.disabled_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.revoked_at IS NULL')
      .get(sessionId) as { expires_at: string; disabled_at: string | null } | undefined;
    return !!found && found.disabled_at === null && Date.parse(found.expires_at) > this.now();
  }

  /** Logs out one device. */
  revoke(token: string): boolean {
    if (typeof token !== 'string') return false;
    return this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(this.iso(), sha256(token)).changes > 0;
  }

  /** Where webhooks under `/h/<id>` go; null for an unknown or disabled account. */
  route(routeId: string): { coreUrl: string } | null {
    const row = this.db.prepare('SELECT core_url, disabled_at FROM users WHERE route_id = ?').get(routeId) as
      | { core_url: string; disabled_at: string | null }
      | undefined;
    return row && row.disabled_at === null ? { coreUrl: row.core_url } : null;
  }

  /**
   * A consistent copy of the database while the gateway runs (copying the file itself can catch
   * it mid-write). Core tokens in it stay encrypted: the copy is useless without MIMI_GATEWAY_SECRET.
   */
  async backupTo(file: string): Promise<void> {
    if (fs.existsSync(file)) throw new AccountError(`${file} already exists.`);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    await this.db.backup(file);
  }

  /** Removes sessions that ended more than a day ago. */
  prune(): void {
    const cutoff = this.iso(-86_400_000);
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(cutoff, cutoff);
  }
}
