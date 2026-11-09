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
      name: z.string().regex(SKILL_NAME, 'lowercase letters, digits and "-"; start with a letter (no underscore)'),
      description: z.string().min(1).max(200).describe('One line: when to use it. This is all other runs see in the skill index.'),
      body: z.string().min(1).max(BODY_LIMIT).describe('The instructions, in Markdown: the steps to follow and what to check.'),
      replace: z.boolean().optional().describe('Overwrite a skill of the same name that this tool can write (default: refuse).'),
      use: z.boolean().optional().describe('Add it to your own skill list (default true).'),
    }),
    summarize: (input) => `${input.replace ? 'Replace' : 'Create'} skill "${input.name}": ${input.description.replace(/\s+/g, ' ').slice(0, 120)}`,
    async execute(input, context) {
      const name = input.name;
      const existing = deps.skills().find((skill) => skill.name === name);
      if (existing?.builtin) {
        throw new Error(`"${name}" is a built-in skill and cannot be replaced. Pick another name.`);
      }
      if (existing && !input.replace) {
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
      saveSkill(deps.skillsDir, { name, description: input.description.replace(/\s+/g, ' ').trim(), body: input.body });
      const attach = input.use !== false;
      if (attach) deps.attach(context.agent, name);
      deps.changed();
      return `Saved skill "${name}" (skills/${name}.md).${attach ? ' It is in your skill list from your next message: call use_skill(name) to follow it.' : ''}`;
    },
  });
  return [skillCreate];
}
