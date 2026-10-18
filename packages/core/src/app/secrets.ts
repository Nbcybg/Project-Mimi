import fs from 'node:fs';
import path from 'node:path';

const SECRET_NAME = /^[A-Za-z0-9._-]{1,80}$/;

/** The key under which a preset's `secret`-type setting is stored. */
export function presetSecretKey(preset: string, field: string): string {
  return `preset.${preset}.${field}`;
}

/**
 * API keys and other values that must never travel with a synced folder. Stored in
 * `data/secrets.json` on this machine only. Tools read them with `{{secret.NAME}}`,
 * and preset forms with `secret`-type settings save here through `preset.<name>.<key>`.
 */
export class SecretStore {
  private readonly file: string;
  private data: Record<string, string>;

  constructor(file: string) {
    this.file = file;
    this.data = {};
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [name, value] of Object.entries(stored)) {
        if (SECRET_NAME.test(name) && typeof value === 'string') this.data[name] = value;
      }
    } catch {
      // first start or an unreadable file: begin empty
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  names(): string[] {
    return Object.keys(this.data).sort();
  }

  has(name: string): boolean {
    return Boolean(this.data[name]);
  }

  get(name: string): string | undefined {
    return this.data[name];
  }

  /** Only the tail of a value, for showing that it is set without revealing it. */
  hint(name: string): string {
    const value = this.data[name];
    if (!value) return '';
    return value.length <= 4 ? '•'.repeat(value.length) : `••••${value.slice(-4)}`;
  }

  set(name: string, value: string): void {
    if (!SECRET_NAME.test(name)) throw new Error(`Invalid secret name "${name}".`);
    if (value.trim()) this.data[name] = value.trim();
    else delete this.data[name];
    this.persist();
  }

  /** Stores what is given, removes what is empty; unknown names are simply new names. */
  save(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) {
      if (!SECRET_NAME.test(name)) throw new Error(`Invalid secret name "${name}".`);
      if (typeof value === 'string' && value.trim()) this.data[name] = value.trim();
      else delete this.data[name];
    }
    this.persist();
  }

  remove(name: string): void {
    delete this.data[name];
    this.persist();
  }

  /** Removes every value a preset stored (`preset.<name>.<field>`). */
  removePreset(preset: string): void {
    const prefix = `preset.${preset}.`;
    for (const name of Object.keys(this.data)) {
      if (name.startsWith(prefix)) delete this.data[name];
    }
    this.persist();
  }
}
