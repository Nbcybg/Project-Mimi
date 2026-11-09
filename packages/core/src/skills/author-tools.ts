import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import { saveSkill, type Skill } from './skills.ts';

export interface SkillAuthorDeps {
  /** The skills that exist now (built-in ones included). */
  skills: () => Skill[];
  skillsDir: string;
  /** Adds the skill to the agent's own list, so it shows in that agent's skill index from its next message. */
  attach: (agent: string, skill: string) => void;
  /** Tells the app a skill file was added or changed (the skill hub refreshes). */
  changed: () => void;
}

const SKILL_NAME = /^[a-z][a-z0-9-]*$/;
const BODY_LIMIT = 20_000;
const DESCRIPTION_LIMIT = 200;

/**
 * Models write in the user's language: a Thai title, spaces, capitals, an underscore. The file name has to be
 * lowercase letters, digits and "-", so the name is cleaned up instead of refused (a refusal the model cannot
 * fix, for a Thai title, looks like "the tool does not work"). A name with nothing usable left gets a stable
 * one made from it (skill-ab12cd); the title the model gave stays in the description.
 */
export function skillFileName(raw: string): string {
  const cleaned = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return SKILL_NAME.test(cleaned) ? cleaned : `skill-${createHash('sha1').update(raw.trim()).digest('hex').slice(0, 6)}`;
}

/** true / false, also when a model sends them as text. */
const flag = z.union([z.boolean(), z.enum(['true', 'false'])]).optional();
const isOn = (value: boolean | 'true' | 'false' | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value === true || value === 'true';

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * `skill_create`: any agent that lists it may write a skill file (skills/<name>.md), not only the
 * Overseer. A skill is instructions another run will follow as if they were its own, so this is
 * kept narrow on purpose: plain instructions only (no model, no tools of its own: a skill that
 * runs as a separate job with tools is set up in the hub), a built-in or hub-configured skill is
 * never overwritten, replacing needs an explicit flag, and the tool is a "write": the user is
 * asked before every save and sees the name, the description and the full instructions.
 */
export function createSkillAuthorTools(deps: SkillAuthorDeps): ToolDefinition<any>[] {
  const skillCreate = defineTool({
    name: 'skill_create',
    description:
      'Save a new skill: a reusable set of instructions for a kind of task, written as skills/<name>.md. Use it when the user asks you to turn a procedure into a skill, or after you worked out a repeatable way to do something and the user agrees. The skill is added to your own skill list (use_skill) from your next message. Plain instructions only. The user is asked to approve every save.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Short name; lowercase letters, digits and "-" (anything else is cleaned up for the file name).'),
      description: z.string().min(1).max(600).describe('One line: when to use it. This is all other runs see in the skill index.'),
      body: z.string().min(1).max(BODY_LIMIT).describe('The instructions, in Markdown: the steps to follow and what to check.'),
      replace: flag.describe('Overwrite a skill of the same name that this tool can write (default: refuse).'),
      use: flag.describe('Add it to your own skill list (default true).'),
    }),
    summarize: (input) =>
      `${isOn(input.replace, false) ? 'Replace' : 'Create'} skill "${skillFileName(input.name)}": ${oneLine(input.description).slice(0, 120)}`,
    async execute(input, context) {
      const name = skillFileName(input.name);
      const renamed = name !== input.name.trim();
      // A title that could not be a file name is kept where people read it: in the description.
      const description = oneLine(renamed && !SKILL_NAME.test(input.name.trim().toLowerCase()) && !input.description.includes(input.name.trim()) ? `${input.name.trim()} — ${input.description}` : input.description).slice(0, DESCRIPTION_LIMIT);
      const existing = deps.skills().find((skill) => skill.name === name);
      if (existing?.builtin) {
        throw new Error(`"${name}" is a built-in skill and cannot be replaced. Pick another name.`);
      }
      if (existing && !isOn(input.replace, false)) {
        const names = deps.skills().map((skill) => skill.name).join(', ');
        throw new Error(
          `A skill named "${name}" already exists (${existing.description}). Read it with load_skill, then call skill_create again with replace: true to overwrite it, or choose another name. Existing skills: ${names}.`,
        );
      }
      if (existing && (existing.model || existing.tools.length > 0)) {
        throw new Error(
          `Skill "${name}" has its own model or tools, set in the skill hub; this tool only writes plain instructions. Edit that one in the hub, or choose another name.`,
        );
      }
      saveSkill(deps.skillsDir, { name, description, body: input.body });
      const attach = isOn(input.use, true);
      if (attach) deps.attach(context.agent, name);
      deps.changed();
      return `Saved skill "${name}" (skills/${name}.md)${renamed ? ` — the name was cleaned up from "${input.name.trim()}" because a file name takes only a-z, 0-9 and "-"` : ''}.${attach ? ' It is in your skill list from your next message: call use_skill(name) to follow it.' : ''}`;
    },
  });
  return [skillCreate];
}
