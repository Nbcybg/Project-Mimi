/**
 * Placeholders in prompt text:
 *   {{user}}      the person the agent talks to
 *   {{char}}      the agent itself
 *   {{<agent id>}} another agent, by its id (e.g. {{tim}})
 * More names (wardrobe ids) join the same table. A placeholder with no value is left
 * as written, so text that merely looks like one (a template for an email, a code
 * sample) is never damaged.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

/** Names an agent (or a wardrobe outfit) may not take, because the prompt already gives them a meaning. */
export const RESERVED_NAMES = ['user', 'char'] as const;

export type PromptVars = ReadonlyMap<string, string>;

export function renderPromptVars(text: string, vars: PromptVars): string {
  if (!text.includes('{{')) return text;
  return text.replace(PLACEHOLDER, (whole, key: string) => vars.get(key.toLowerCase()) ?? vars.get(key) ?? whole);
}

/** The table for one agent: `{{user}}`, `{{char}}`, then one entry per agent id. */
export function buildPromptVars(parts: {
  userName: string;
  self: { name: string; displayName: string };
  agents: Array<{ name: string; displayName: string }>;
  /** Extra entries (wardrobe outfits); they never override the names above. */
  extra?: Record<string, string>;
}): Map<string, string> {
  const vars = new Map<string, string>();
  for (const [key, value] of Object.entries(parts.extra ?? {})) vars.set(key.toLowerCase(), value);
  for (const agent of parts.agents) vars.set(agent.name.toLowerCase(), agent.displayName || agent.name);
  vars.set('user', parts.userName);
  vars.set('char', parts.self.displayName || parts.self.name);
  return vars;
}
