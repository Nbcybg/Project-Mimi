import type { PreferencesView } from '@mimi/shared';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelPreset } from '../providers/routing.ts';
import type { ProviderDef } from '../providers/settings.ts';

/** Environment variables the settings screen may write. Nothing else is accepted from a client. */
export const SETTABLE_KEYS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT',
  'SERPER_API_KEY',
  'OPENWEATHER_API_KEY',
] as const;

/** The model keys of the settings file and of agent files: one per capability. */
export const MODEL_KEYS = ['model', 'small_model', 'vision_model', 'transcript_model', 'image_model', 'speech_model', 'video_model'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];
export type ModelDefaults = Partial<Record<ModelKey, string>>;

/** A provider connected in the app: its definition and the model ids it reported. */
export interface ConnectedProvider {
  def: ProviderDef;
  models: string[];
}

interface StoredSettings {
  /** Shared secret of the local server; created on first start so the user never types one. */
  token: string;
  keys: Record<string, string>;
  providers: Record<string, ConnectedProvider>;
  /** Default model per capability, for agents that do not choose their own. */
  defaults: ModelDefaults;
  /** The model pool: named presets (model + sampling settings) that agents and skills refer to by name. */
  presets: Record<string, ModelPreset>;
  allowedDirs: string[];
  preferences: PreferencesView;
}

/**
 * What the user sets inside the app instead of editing files: connected providers,
 * the default model per capability, the allowed folders, the Google OAuth client. Stored in
 * `user/data/app-settings.json` (git-ignored). Provider API keys live in `user/data/auth.json`.
 */
export class AppSettings {
  private readonly file: string;
  private data: StoredSettings;

  private constructor(file: string, data: StoredSettings) {
    this.file = file;
    this.data = data;
  }

  static load(file: string): AppSettings {
    let stored: Partial<StoredSettings> = {};
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredSettings>;
    } catch {
      // first start, or an unreadable file: begin with defaults
    }
    const settings = new AppSettings(file, {
      token: typeof stored.token === 'string' && stored.token ? stored.token : randomBytes(24).toString('base64url'),
      keys: { ...stored.keys },
      providers: { ...stored.providers },
      defaults: { ...stored.defaults },
      presets: { ...stored.presets },
      allowedDirs: Array.isArray(stored.allowedDirs) ? stored.allowedDirs.map(String) : [],
      preferences: { ...stored.preferences },
    });
    if (stored.token !== settings.data.token) settings.save();
    return settings;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get token(): string {
    return this.data.token;
  }

  get defaults(): ModelDefaults {
    return this.data.defaults;
  }

  get allowedDirs(): string[] {
    return this.data.allowedDirs;
  }

  get providers(): Record<string, ConnectedProvider> {
    return this.data.providers;
  }

  get preferences(): PreferencesView {
    return this.data.preferences;
  }

  setPreferences(preferences: PreferencesView): void {
    this.data.preferences = preferences;
    this.save();
  }

  get presets(): Record<string, ModelPreset> {
    return this.data.presets;
  }

  setPreset(name: string, preset: ModelPreset): void {
    this.data.presets[name] = preset;
    this.save();
  }

  /** Removes a preset; defaults that used it are cleared. */
  removePreset(name: string): void {
    delete this.data.presets[name];
    for (const key of MODEL_KEYS) {
      if (this.data.defaults[key] === name) delete this.data.defaults[key];
    }
    this.save();
  }

  /** Provider definitions for the registry's top layer. */
  providerDefs(): Record<string, ProviderDef> {
    return Object.fromEntries(Object.entries(this.data.providers).map(([id, provider]) => [id, provider.def]));
  }

  /** Model ids each connected provider reported; these are the ones offered to the user. */
  listedModels(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.data.providers).map(([id, provider]) => [id, provider.models]));
  }

  setProvider(id: string, provider: ConnectedProvider): void {
    this.data.providers[id] = provider;
    this.save();
  }

  removeProvider(id: string): void {
    delete this.data.providers[id];
    // Defaults pointing at the removed provider are cleared.
    for (const key of MODEL_KEYS) {
      if (this.data.defaults[key]?.startsWith(`${id}/`)) delete this.data.defaults[key];
    }
    this.save();
  }

  /**
   * Copies the stored values into the environment the core reads. A value saved in
   * the app wins over `.env`, so what the settings screen shows is what is used.
   */
  applyToEnv(env: NodeJS.ProcessEnv): void {
    for (const name of SETTABLE_KEYS) {
      const value = this.data.keys[name];
      if (value) env[name] = value;
    }
    if (this.data.allowedDirs.length > 0) env.ALLOWED_DIRS = this.data.allowedDirs.join(';');
  }

  /** Stores keys; an empty value removes one. Unknown names are ignored. */
  setKeys(keys: Record<string, string>, env: NodeJS.ProcessEnv): void {
    for (const name of SETTABLE_KEYS) {
      const value = keys[name];
      if (typeof value !== 'string') continue;
      if (value.trim()) {
        this.data.keys[name] = value.trim();
        env[name] = value.trim();
      } else {
        delete this.data.keys[name];
        delete env[name];
      }
    }
    this.save();
  }

  /** Sets default models; an empty value clears one. */
  setDefaults(defaults: Partial<Record<ModelKey, string>>): void {
    for (const key of MODEL_KEYS) {
      const value = defaults[key];
      if (typeof value !== 'string') continue;
      if (value.trim()) this.data.defaults[key] = value.trim();
      else delete this.data.defaults[key];
    }
    this.save();
  }

  setAllowedDirs(dirs: string[]): void {
    this.data.allowedDirs = dirs.map((dir) => String(dir).trim()).filter(Boolean);
    this.save();
  }
}
