import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { PROFILE_KEY, type UserProfileStore } from './user-profile.ts';

/**
 * Lets an agent keep the user's profile current ("I moved to Chiang Mai"). It is a
 * write tool, so the user approves each change; an agent may only change fields it
 * can see, and a new field is visible to that agent alone unless it says otherwise.
 */
export function createProfileTools(profile: UserProfileStore, agentNames: () => string[]): ToolDefinition[] {
  const update = defineTool({
    name: 'profile_update',
    description:
      'Save or change one lasting fact about the user in their profile (Settings → โปรไฟล์ของฉัน), e.g. after they tell you their new address or the name they want to be called. The user approves the change. Use a short lowercase key such as "home_address"; an empty value clears it.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      key: z.string().regex(PROFILE_KEY, 'lowercase letters, digits or "_"'),
      label: z.string().max(80).optional(),
      value: z.string().max(2000),
      /** Who may see a new field: only the asking agent (default) or every agent. */
      visible_to: z.enum(['me', 'everyone']).optional(),
    }),
    summarize: (input) => `Profile: set "${input.label || input.key}" to "${input.value}"`,
    async execute(input, context) {
      const current = profile.get();
      const existing = current.fields.find((field) => field.key === input.key);
      if (existing && existing.visibleTo !== '*' && !existing.visibleTo.includes(context.agent)) {
        return `The field "${input.key}" is not shared with you, so you cannot change it. Ask the user to edit it in Settings.`;
      }
      const fields = existing
        ? current.fields.map((field) =>
            field.key === input.key
              ? {
                  ...field,
                  value: input.value,
                  ...(input.label ? { label: input.label } : {}),
                  ...(input.visible_to ? { visibleTo: input.visible_to === 'everyone' ? ('*' as const) : [context.agent] } : {}),
                }
              : field,
          )
        : [...current.fields, { key: input.key, label: input.label ?? input.key, value: input.value, visibleTo: input.visible_to === 'everyone' ? ('*' as const) : [context.agent] }];
      profile.save({ fields }, agentNames());
      return existing ? `Updated "${input.label || existing.label || input.key}".` : `Added "${input.label || input.key}" to the profile.`;
    },
  });
  return [update as ToolDefinition];
}
