import fs from 'node:fs';
import path from 'node:path';

interface Credential {
  type: 'api';
  key: string;
}

/**
 * Stored provider credentials, in the same shape as opencode's `auth.json`:
 * `{ "<provider id>": { "type": "api", "key": "..." } }`. A credential is created
 * when the user connects a provider and is what makes that provider usable.
 */
export class AuthStore {
  private readonly file: string;
  private credentials: Record<string, Credential>;

  constructor(file: string) {
    this.file = file;
    this.credentials = {};
    try {
      const stored: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored && typeof stored === 'object') {
        for (const [id, value] of Object.entries(stored as Record<string, Partial<Credential>>)) {
          if (value?.type === 'api' && typeof value.key === 'string' && value.key) {
            this.credentials[id] = { type: 'api', key: value.key };
          }
        }
      }
    } catch {
      // no credentials yet
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.credentials, null, 2), { mode: 0o600 });
  }

  get(provider: string): string | undefined {
    return this.credentials[provider]?.key;
  }

  has(provider: string): boolean {
    return provider in this.credentials;
  }

  providers(): string[] {
    return Object.keys(this.credentials);
  }

  set(provider: string, key: string): void {
    this.credentials[provider] = { type: 'api', key: key.trim() };
    this.save();
  }

  remove(provider: string): void {
    if (!(provider in this.credentials)) return;
    delete this.credentials[provider];
    this.save();
  }
}
