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

  constructor(file: string) {
    this.file = file;
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
    return parsed.data as UserProfileView;
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
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
    if (touched) fs.writeFileSync(this.file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  }
}
