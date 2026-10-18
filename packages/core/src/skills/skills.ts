import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { modelRefString } from '../providers/settings.ts';
import { defineTool, type ToolContext, type ToolDefinition } from '../tools/registry.ts';

export interface Skill {
  name: string;
  description: string;
  /**
   * Model (or preset from the model pool) the skill runs on. A skill with its own model
   * runs as a separate job and hands back the result; without one, its instructions are
   * given to the agent, which carries them out itself.
   */
  model?: string;
  /** Tools the skill may use when it runs as a separate job. */
  tools: string[];
  file: string;
}

const SKILL_NAME = /^[a-z][a-z0-9-]*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const SkillFrontmatter = z.object({
  name: z.string().regex(SKILL_NAME, 'lowercase letters, digits and "-"'),
  description: z.string().min(1),
  model: modelRefString.optional(),
  tools: z.array(z.string()).default([]),
});

function parseSkill(source: string, file: string): Skill {
  const match = FRONTMATTER.exec(source);
  const parsed = SkillFrontmatter.safeParse(match ? parseYaml(match[1]!) : undefined);
  if (!parsed.success) {
    throw new Error(`${file}: invalid skill frontmatter:\n${z.prettifyError(parsed.error)}`);
  }
  return { ...parsed.data, file };
}

/** Reads `skills/<name>.md` files. Only the frontmatter is kept in memory. */
export function loadSkills(skillsDir: string): Skill[] {
  if (!fs.existsSync(skillsDir)) return [];
  const skills: Skill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (!SKILL_NAME.test(name)) continue;
    const file = path.join(skillsDir, entry.name);
    const skill = parseSkill(fs.readFileSync(file, 'utf8'), file);
    if (skill.name !== name) {
      throw new Error(`${file}: frontmatter name "${skill.name}" must match the file name`);
    }
    skills.push(skill);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** The instructions of a skill. Read at call time, so edits apply without a restart. */
export function readSkillBody(skill: Skill): string {
  return fs.readFileSync(skill.file, 'utf8').replace(FRONTMATTER, '').trim();
}

/** Creates or replaces one skill file. It is re-parsed first, so an invalid one never reaches disk. */
export function saveSkill(
  skillsDir: string,
  skill: { name: string; description: string; model?: string; tools?: string[]; body: string },
): Skill {
  const frontmatter: Record<string, unknown> = { name: skill.name, description: skill.description.trim() };
  if (skill.model) frontmatter.model = skill.model;
  if (skill.tools && skill.tools.length > 0) frontmatter.tools = skill.tools;
  const body = skill.body.trim();
  if (!body) throw new Error(`Skill "${skill.name}": the instructions are empty`);
  const source = `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${body}\n`;
  const file = path.join(skillsDir, `${skill.name}.md`);
  const parsed = parseSkill(source, file);
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
  return parsed;
}

export function deleteSkill(skillsDir: string, name: string): boolean {
  const file = path.join(skillsDir, `${name}.md`);
  if (!SKILL_NAME.test(name) || !fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** The only part of the skills that is always in the prompt: one line per skill. */
export function renderSkillIndex(skills: Skill[], toolName = 'load_skill'): string {
  if (skills.length === 0) return '';
  const how =
    toolName === 'use_skill'
      ? 'When a task matches, call use_skill(name, input) first. It either returns instructions for you to follow, or does the job and returns the result.'
      : 'When a task matches, call load_skill(name) first and follow what it returns.';
  return [
    '## Skills',
    `Each skill is a set of instructions for one kind of task. ${how}`,
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join('\n');
}

/** The always-on persona file. It is injected by the core on every start, not chosen by the model. */
export function loadPersona(personaPath: string): string {
  return fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8').trim() : '';
}

function findSkill(skills: Skill[], name: string): Skill {
  const skill = skills.find((candidate) => candidate.name === name.trim());
  if (!skill) {
    throw new Error(`No skill "${name}". Available: ${skills.map((candidate) => candidate.name).join(', ') || 'none'}`);
  }
  return skill;
}

/** `load_skill`: returns the instructions of any skill. Kept for agents that list it as a tool. */
export function createSkillTool(skills: Skill[] | (() => Skill[])): ToolDefinition<{ name: string }> {
  const current = typeof skills === 'function' ? skills : () => skills;
  return defineTool({
    name: 'load_skill',
    description: 'Load the full instructions of a skill listed under "Skills". Do this before starting a task the skill covers.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({ name: z.string().min(1) }),
    summarize: (input) => `Load skill ${input.name}`,
    async execute(input) {
      return readSkillBody(findSkill(current(), input.name));
    },
  });
}

/** Runs a skill that has its own model as a separate job and returns what it produced. */
export type SkillRunner = (skill: Skill, input: string, context: ToolContext) => Promise<string>;

/**
 * `use_skill`: the skills an agent was given from the skill hub. A skill without a model
 * hands its instructions to the agent; a skill with one is run by `runner` on that model.
 */
export function createUseSkillTool(
  skills: Skill[],
  runner: SkillRunner,
): ToolDefinition<{ name: string; input?: string }> {
  return defineTool({
    name: 'use_skill',
    description: `Use one of your skills: ${skills.map((skill) => skill.name).join(', ')}. Pass in "input" everything the skill needs to know; it cannot see this conversation.`,
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      name: z.string().min(1),
      input: z.string().optional().describe('The task and all details needed to do it'),
    }),
    summarize: (input) => `Use skill ${input.name}`,
    async execute(input, context) {
      const skill = findSkill(skills, input.name);
      if (!skill.model) {
        return `Instructions of skill "${skill.name}" (follow them now):\n\n${readSkillBody(skill)}`;
      }
      return runner(skill, input.input?.trim() || '(no input given)', context);
    },
  });
}
