import fs from 'node:fs';
import path from 'node:path';
import type { UserProfileField, UserProfileView } from '@mimi/shared';
import { z } from 'zod';

export const PROFILE_KEY = /^[a-z][a-z0-9_]*$/;
const MAX_FIELDS = 100;
const MAX_VALUE = 2000;

const fieldSchema = z.strictObject({
  key: z.string().regex(PROFILE_KEY, 'lowercase letters, digits or "_", starting with a letter (e.g. "home_address")'),
  label: z.string().trim().max(80).default(''),
  value: z.string().max(MAX_VALUE, `a value may be at most ${MAX_VALUE} characters`).default(''),
  /** "*" = every agent; otherwise the names of the agents that may see it. */
  visibleTo: z.union([z.literal('*'), z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/))]).default('*'),
  localOnly: z.boolean().optional(),
});

const profileSchema = z.strictObject({
  fields: z.array(fieldSchema).max(MAX_FIELDS).default([]),
});

/**
 * The user's own profile: key/value fields they fill in Settings, each visible to
 * every agent or only to the agents named. Stored as `user/profile.json`, so it is
 * readable, editable by hand and moves with the rest of the user folder.
 */
export class UserProfileStore {
  private readonly file: string;
  /** Values of "this machine only" fields, kept outside the user folder's synced files. */
  private readonly localFile: string | undefined;

  constructor(file: string, localFile?: string) {
    this.file = file;
    this.localFile = localFile;
  }

  private localValues(): Record<string, string> {
    if (!this.localFile || !fs.existsSync(this.localFile)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.localFile, 'utf8')) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value ?? '')]));
    } catch {
      return {};
    }
  }

  get(): UserProfileView {
    if (!fs.existsSync(this.file)) return { fields: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`${this.file}: not valid JSON: ${(error as Error).message}`);
    }
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${this.file}: invalid profile:\n${z.prettifyError(parsed.error)}`);
    const local = this.localValues();
    const fields = (parsed.data.fields as UserProfileField[]).map((field) => (field.localOnly ? { ...field, value: local[field.key] ?? '' } : field));
    return { fields };
  }

  /** Replaces the whole profile; rows without a key or value are dropped, keys must be unique. */
  save(view: UserProfileView, knownAgents: string[]): UserProfileView {
    const rows = (Array.isArray(view?.fields) ? view.fields : []).filter(
      (field) => String(field?.key ?? '').trim() !== '' || String(field?.value ?? '').trim() !== '',
    );
    const parsed = profileSchema.safeParse({
      fields: rows.map((field) => ({
        key: String(field.key ?? '').trim().toLowerCase(),
        label: String(field.label ?? '').trim(),
        value: String(field.value ?? '').trim(),
        visibleTo: Array.isArray(field.visibleTo) ? [...new Set(field.visibleTo.map(String))] : '*',
        ...(field.localOnly ? { localOnly: true } : {}),
      })),
    });
    if (!parsed.success) throw new Error(`Profile: ${z.prettifyError(parsed.error)}`);
    const fields = parsed.data.fields as UserProfileField[];
    const seen = new Set<string>();
    for (const field of fields) {
      if (seen.has(field.key)) throw new Error(`Profile: the key "${field.key}" is used twice.`);
      seen.add(field.key);
      if (Array.isArray(field.visibleTo)) {
        const unknown = field.visibleTo.filter((name) => !knownAgents.includes(name));
        if (unknown.length > 0) throw new Error(`Profile "${field.key}": no agent named ${unknown.join(', ')}.`);
      }
    }
    const result: UserProfileView = { fields };
    if (fields.some((field) => field.localOnly) && !this.localFile) throw new Error('Profile: this setup has no machine-local store.');
    // "This machine only" values go to the local file; the shared file keeps the field without its value.
    const local: Record<string, string> = {};
    const shared = fields.map((field) => {
      if (!field.localOnly) return field;
      local[field.key] = field.value;
      return { ...field, value: '' };
    });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ fields: shared }, null, 2)}\n`, 'utf8');
    if (this.localFile) {
      fs.mkdirSync(path.dirname(this.localFile), { recursive: true });
      fs.writeFileSync(this.localFile, `${JSON.stringify(local, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    return result;
  }

  /** The fields this agent may see, with a value. */
  visibleTo(agent: string): UserProfileField[] {
    return this.get().fields.filter(
      (field) => field.value.trim() !== '' && (field.visibleTo === '*' || field.visibleTo.includes(agent)),
    );
  }

  /** The prompt block for an agent; empty when it may see nothing. */
  render(agent: string): string {
    const fields = this.visibleTo(agent);
    if (fields.length === 0) return '';
    const lines = fields.map((field) => `- ${field.label || field.key} (${field.key}): ${field.value.replace(/\s*\n\s*/g, ' / ')}`);
    return [
      '<user_profile>',
      'Facts the user entered about themselves in Settings. They are current and override anything older in memory. Use them when they help; do not repeat them back unprompted.',
      ...lines,
      '</user_profile>',
    ].join('\n');
  }

  /** An agent was renamed: fields limited to it follow the new name. */
  renameAgent(from: string, to: string): void {
    this.rewrite((names) => names.map((name) => (name === from ? to : name)));
  }

  /** An agent was deleted: it drops out of every limited field. */
  forgetAgent(name: string): void {
    this.rewrite((names) => names.filter((entry) => entry !== name));
  }

  private rewrite(change: (names: string[]) => string[]): void {
    if (!fs.existsSync(this.file)) return;
    const profile = this.get();
    let touched = false;
    for (const field of profile.fields) {
      if (!Array.isArray(field.visibleTo)) continue;
      const next = change(field.visibleTo);
      if (next.join('\n') !== field.visibleTo.join('\n')) {
        field.visibleTo = next;
        touched = true;
      }
    }
    if (touched) {
      const shared = profile.fields.map((field) => (field.localOnly ? { ...field, value: '' } : field));
      fs.writeFileSync(this.file, `${JSON.stringify({ fields: shared }, null, 2)}\n`, 'utf8');
    }
  }
}
