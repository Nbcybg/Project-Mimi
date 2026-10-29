import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OAuthAccountInput, OAuthAccountView, OAuthService } from '@mimi/shared';
import type { SecretStore } from '../app/secrets.ts';
import { GoogleAuth } from '../google/auth.ts';
import { startGoogleOAuth, type OAuthFlow } from '../google/oauth-flow.ts';
import type { ReceiverFactory } from './callback.ts';
import { MicrosoftAuth } from '../microsoft/auth.ts';

interface StoredAccount {
  id: string;
  service: OAuthService;
  name: string;
  clientId: string;
  tenant?: string;
  default?: boolean;
  /** Created from the old GOOGLE_OAUTH_* / MICROSOFT_* environment keys, until the user edits it here. */
  legacy?: boolean;
  createdAt: string;
}

interface StoredFile {
  accounts: StoredAccount[];
}

export interface OAuthAccountsOptions {
  /** Folder that holds `accounts.json` and one token file per account: `oauth/<service>/<id>.json`. */
  dir: string;
  secrets: SecretStore;
  env: NodeJS.ProcessEnv;
  /** Where the single-account tokens of older versions live, for the one-time migration. */
  legacyTokenFiles?: Partial<Record<OAuthService, string>>;
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{2,60}$/;

const secretName = (id: string) => `oauth.${id}.client_secret`;

function serviceOf(value: unknown): OAuthService {
  return value === 'microsoft' ? 'microsoft' : 'google';
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<StoredAccount>;
  return (
    typeof entry.id === 'string' &&
    ACCOUNT_ID.test(entry.id) &&
    (entry.service === 'google' || entry.service === 'microsoft') &&
    typeof entry.clientId === 'string' &&
    typeof entry.name === 'string'
  );
}

/**
 * The OAuth account hub: every Google / Microsoft account keeps its own OAuth client
 * (client id, secret and, for Microsoft, tenant) and its own refresh token. Tools,
 * presets and workflows name an account; an empty choice means the account marked
 * default, falling back to the old single-account credentials in the environment.
 */
export class OAuthAccounts {
  private readonly dir: string;
  private readonly secrets: SecretStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly legacyTokenFiles: Partial<Record<OAuthService, string>>;
  private accounts: StoredAccount[];
  private readonly googleCache = new Map<string, GoogleAuth>();
  private readonly microsoftCache = new Map<string, MicrosoftAuth>();
  private readonly legacyGoogle: GoogleAuth;
  private readonly legacyMicrosoft: MicrosoftAuth;

  constructor(options: OAuthAccountsOptions) {
    this.dir = options.dir;
    this.secrets = options.secrets;
    this.env = options.env;
    this.legacyTokenFiles = options.legacyTokenFiles ?? {};
    this.legacyGoogle = GoogleAuth.fromEnv(options.env, this.legacyTokenFiles.google ?? path.join(this.dir, 'legacy-google.json'));
    this.legacyMicrosoft = MicrosoftAuth.fromEnv(
      options.env,
      this.legacyTokenFiles.microsoft ?? path.join(this.dir, 'legacy-microsoft.json'),
    );
    this.accounts = this.load();
    // Only the first start after the upgrade migrates; an account list the user cleared stays empty.
    if (!fs.existsSync(this.file())) this.migrateLegacy();
  }

  private file(): string {
    return path.join(this.dir, 'accounts.json');
  }

  private load(): StoredAccount[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Partial<StoredFile>;
      return Array.isArray(raw.accounts) ? raw.accounts.filter(isStoredAccount) : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const data: StoredFile = { accounts: this.accounts };
    fs.writeFileSync(this.file(), JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  /** Copies the old single-account credentials into an account once, so nothing breaks on upgrade. */
  private migrateLegacy(env: NodeJS.ProcessEnv = this.env): void {
    for (const service of ['google', 'microsoft'] as const) {
      if (this.accounts.some((account) => account.service === service)) continue;
      const clientId = service === 'google' ? env.GOOGLE_OAUTH_CLIENT_ID : env.MICROSOFT_CLIENT_ID;
      if (!clientId?.trim()) continue;
      const id = `${service}-default`;
      if (this.accounts.some((account) => account.id === id)) continue;
      const account: StoredAccount = {
        id,
        service,
        name: service === 'google' ? 'Google (เดิม)' : 'Microsoft (เดิม)',
        clientId: clientId.trim(),
        ...(service === 'microsoft' ? { tenant: env.MICROSOFT_TENANT || 'common' } : {}),
        default: true,
        legacy: true,
        createdAt: new Date().toISOString(),
      };
      if (service === 'google') {
        const secret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
        if (secret) this.secrets.set(secretName(id), secret);
        this.copyLegacyToken(service, env.GOOGLE_OAUTH_REFRESH_TOKEN);
      } else {
        const secret = env.MICROSOFT_CLIENT_SECRET?.trim();
        if (secret) this.secrets.set(secretName(id), secret);
        this.copyLegacyToken(service);
      }
      this.accounts.push(account);
    }
    this.persist();
  }

  private copyLegacyToken(service: OAuthService, refreshToken?: string): void {
    const legacy = this.legacyTokenFiles[service];
    let token = refreshToken?.trim();
    if (!token && legacy && fs.existsSync(legacy)) {
      try {
        token = (JSON.parse(fs.readFileSync(legacy, 'utf8')) as { refresh_token?: string }).refresh_token;
      } catch {
        // unreadable legacy token: the user can connect again in the hub
      }
    }
    if (!token) return;
    const target = path.join(this.dir, `${service}-default.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ refresh_token: token }, null, 2), { mode: 0o600 });
  }

  list(): StoredAccount[] {
    return [...this.accounts];
  }

  find(id: string | undefined): StoredAccount | undefined {
    if (!id) return undefined;
    return this.accounts.find((account) => account.id === id);
  }

  require(id: string): StoredAccount {
    const account = this.find(id);
    if (!account) throw new Error(`No OAuth account "${id}". เปิด Hub → บัญชี แล้วเพิ่มหรือเชื่อมต่อบัญชีก่อน`);
    return account;
  }

  defaultAccount(service: OAuthService): StoredAccount | undefined {
    const ofService = this.accounts.filter((account) => account.service === service);
    return ofService.find((account) => account.default) ?? ofService[0];
  }

  /** The folder that holds the token of an account. */
  private tokenFile(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private googleAuthFor(account: StoredAccount): GoogleAuth {
    const cached = this.googleCache.get(account.id);
    if (cached) return cached;
    const auth = new GoogleAuth({
      credentials: () => {
        const current = this.find(account.id);
        return {
          clientId: current?.clientId,
          clientSecret: this.secrets.get(secretName(account.id)),
          refreshToken: undefined,
        };
      },
      tokenFile: this.tokenFile(account.id),
    });
    this.googleCache.set(account.id, auth);
    return auth;
  }

  private microsoftAuthFor(account: StoredAccount): MicrosoftAuth {
    const cached = this.microsoftCache.get(account.id);
    if (cached) return cached;
    const auth = new MicrosoftAuth({
      credentials: () => {
        const current = this.find(account.id);
        return { clientId: current?.clientId, tenant: current?.tenant || 'common', clientSecret: this.secrets.get(secretName(account.id)) };
      },
      tokenFile: this.tokenFile(account.id),
    });
    this.microsoftCache.set(account.id, auth);
    return auth;
  }

  /** The Google auth of an account; no id means the default account, else the legacy environment. */
  google(id?: string): GoogleAuth {
    if (!id) {
      const account = this.defaultAccount('google');
      return account ? this.googleAuthFor(account) : this.legacyGoogle;
    }
    const account = this.require(id);
    if (account.service !== 'google') throw new Error(`"${account.name}" is a Microsoft account, not Google.`);
    return this.googleAuthFor(account);
  }

  /** The Microsoft auth of an account; no id means the default account, else the legacy environment. */
  microsoft(id?: string): MicrosoftAuth {
    if (!id) {
      const account = this.defaultAccount('microsoft');
      return account ? this.microsoftAuthFor(account) : this.legacyMicrosoft;
    }
    const account = this.require(id);
    if (account.service !== 'microsoft') throw new Error(`"${account.name}" is a Google account, not Microsoft.`);
    return this.microsoftAuthFor(account);
  }

  /** The auth a tool preset named; an unknown account produces a message that explains what to do. */
  resolveGoogle(id: string | undefined): GoogleAuth {
    return this.google(id);
  }

  resolveMicrosoft(id: string | undefined): MicrosoftAuth {
    return this.microsoft(id);
  }

  reset(id?: string): void {
    if (id) {
      this.googleCache.delete(id);
      this.microsoftCache.delete(id);
      return;
    }
    this.googleCache.clear();
    this.microsoftCache.clear();
    this.legacyGoogle.reset();
    this.legacyMicrosoft.reset();
  }

  views(): OAuthAccountView[] {
    return this.list()
      .sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || a.service.localeCompare(b.service) || a.name.localeCompare(b.name))
      .map((account) => ({
        id: account.id,
        service: account.service,
        name: account.name,
        clientId: account.clientId,
        ...(account.tenant ? { tenant: account.tenant } : {}),
        connected:
          account.service === 'google' ? this.googleAuthFor(account).isConfigured : this.microsoftAuthFor(account).isConfigured,
        hasSecret: this.secrets.has(secretName(account.id)),
        default: Boolean(account.default),
        createdAt: account.createdAt,
      }));
  }

  /** Adds an account, or edits one when `id` is given. The client secret stays in the vault. */
  save(input: OAuthAccountInput, id?: string): OAuthAccountView {
    const service = serviceOf(input.service);
    const name = String(input.name ?? '').trim() || (service === 'google' ? 'Google' : 'Microsoft');
    const clientId = String(input.clientId ?? '').trim();
    if (!clientId) throw new Error('ใส่ Client ID ก่อน');
    const existing = id ? this.require(id) : undefined;
    if (existing && existing.service !== service) throw new Error('ย้ายบัญชีข้ามเจ้าไม่ได้: ลบแล้วเพิ่มใหม่');
    const account: StoredAccount = existing ?? {
      id: this.newId(service),
      service,
      name,
      clientId,
      createdAt: new Date().toISOString(),
    };
    account.name = name;
    account.clientId = clientId;
    delete account.legacy;
    if (service === 'microsoft') account.tenant = String(input.tenant ?? '').trim() || 'common';
    const secret = input.clientSecret?.trim();
    if (secret) this.secrets.set(secretName(account.id), secret);
    if (service === 'google' && !this.secrets.has(secretName(account.id))) {
      throw new Error('บัญชี Google ต้องมี Client secret ด้วย');
    }
    if (!existing) {
      account.default = !this.defaultAccount(service);
      this.accounts.push(account);
    }
    this.reset(account.id);
    this.persist();
    return this.view(account.id);
  }

  private newId(service: OAuthService): string {
    for (;;) {
      const id = `${service}-${randomBytes(4).toString('hex')}`;
      if (!this.accounts.some((account) => account.id === id)) return id;
    }
  }

  /** Applies edited GOOGLE_OAUTH_* / MICROSOFT_* keys to accounts the upgrade created from them. */
  syncLegacyEnv(env: NodeJS.ProcessEnv): void {
    // A key entered after the first start still gets its account, just like on upgrade.
    this.migrateLegacy(env);
    let changed = false;
    for (const account of this.accounts) {
      if (!account.legacy) continue;
      if (account.service === 'google') {
        const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
        const secret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
        if (clientId) account.clientId = clientId;
        if (secret) this.secrets.set(secretName(account.id), secret);
      } else {
        const clientId = env.MICROSOFT_CLIENT_ID?.trim();
        const secret = env.MICROSOFT_CLIENT_SECRET?.trim();
        if (clientId) account.clientId = clientId;
        if (secret) this.secrets.set(secretName(account.id), secret);
        account.tenant = env.MICROSOFT_TENANT?.trim() || 'common';
      }
      this.reset(account.id);
      changed = true;
    }
    if (changed) this.persist();
  }

  remove(id: string): void {
    const account = this.require(id);
    this.accounts = this.accounts.filter((entry) => entry.id !== account.id);
    this.secrets.remove(secretName(account.id));
    try {
      fs.rmSync(this.tokenFile(account.id), { force: true });
    } catch {
      // the token file may already be gone
    }
    this.reset(account.id);
    if (account.default) {
      const next = this.accounts.find((entry) => entry.service === account.service);
      if (next) next.default = true;
    }
    this.persist();
  }

  setDefault(id: string): void {
    const account = this.require(id);
    for (const entry of this.accounts) {
      if (entry.service === account.service) entry.default = entry.id === account.id;
    }
    this.persist();
  }

  view(id: string): OAuthAccountView {
    const found = this.views().find((account) => account.id === id);
    if (!found) throw new Error(`No OAuth account "${id}".`);
    return found;
  }

  /**
   * Starts the sign-in for one account. The caller opens `url`; `done` resolves after
   * the refresh token is stored in the account's own token file.
   */
  async startConnect(id: string, receiver?: ReceiverFactory): Promise<OAuthFlow> {
    const account = this.require(id);
    if (account.service === 'google') {
      const secret = this.secrets.get(secretName(account.id));
      if (!account.clientId || !secret) throw new Error('บัญชี Google ยังไม่มี Client ID หรือ secret');
      return startGoogleOAuth({ clientId: account.clientId, clientSecret: secret, tokenFile: this.tokenFile(account.id), receiver });
    }
    return this.microsoftAuthFor(account).startSignIn(receiver);
  }
}
