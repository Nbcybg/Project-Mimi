import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolContext, ToolDefinition } from '@mimi/shared';
import { skillFileName } from '../skills/author-tools.ts';
import { loadSkills, saveSkill } from '../skills/skills.ts';
import { makeTestCore } from './core-helpers.ts';

const context = (agent: string): ToolContext => ({ traceId: 'skill-author-test', thread: 'main', agent, allowedDirs: [] });

test('skill_create: any agent that lists it can write a plain skill, and gets it in its own list', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const tool = core.tools.get('skill_create') as ToolDefinition<any> | undefined;
    assert.ok(tool, 'skill_create is in the tool registry');
    assert.equal(tool.risk, 'write', 'the user is asked before each save');

    const before = core.agents.get('mimi');
    assert.ok(!before.skills.includes('thank-you-note'));

    const result = await tool.execute(
      { name: 'thank-you-note', description: 'Write a short thank-you note\nin the user\'s tone', body: '1. Ask who it is for.\n2. Keep it under 80 words.' },
      context('mimi'),
    );
    assert.match(result, /Saved skill "thank-you-note"/);

    // The file is a normal skill: frontmatter + the instructions, no model and no tools.
    const file = path.join(config.skillsDir, 'thank-you-note.md');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /^---\nname: thank-you-note\ndescription: /);
    assert.doesNotMatch(source, /\nmodel:|\ntools:/);
    assert.match(source, /Keep it under 80 words\./);
    const skill = loadSkills(config.skillsDir).find((entry) => entry.name === 'thank-you-note');
    assert.equal(skill?.description, "Write a short thank-you note in the user's tone", 'a one-line description');

    // It belongs to the agent that wrote it, so that agent's next run lists it.
    assert.ok(core.agents.get('mimi').skills.includes('thank-you-note'));
    // Another agent is untouched.
    const others = core.agents.names().filter((name) => name !== 'mimi');
    for (const name of others) assert.ok(!core.agents.get(name).skills.includes('thank-you-note'));
  } finally {
    await testCore.cleanup();
  }
});

test('skill_create: refuses to overwrite by accident, never touches built-in or hub-configured skills', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const tool = core.tools.get('skill_create') as ToolDefinition<any>;
    const run = (input: unknown, agent = 'mimi') => tool.execute(input, context(agent));

    await run({ name: 'meal-plan', description: 'Plan meals', body: 'FIRST VERSION' });
    await assert.rejects(run({ name: 'meal-plan', description: 'Plan meals', body: 'SECOND' }), /already exists.*replace: true/s);
    assert.match(fs.readFileSync(path.join(config.skillsDir, 'meal-plan.md'), 'utf8'), /FIRST VERSION/);

    await run({ name: 'meal-plan', description: 'Plan meals better', body: 'SECOND VERSION', replace: true, use: false });
    assert.match(fs.readFileSync(path.join(config.skillsDir, 'meal-plan.md'), 'utf8'), /SECOND VERSION/);
    assert.equal(core.agents.get('mimi').skills.filter((skill) => skill === 'meal-plan').length, 1, 'attached once, not twice');

    // A built-in skill cannot be replaced, with or without the flag.
    await assert.rejects(run({ name: 'workflow-builder', description: 'x', body: 'x', replace: true }), /built-in/);

    // A skill the user configured in the hub with its own model or tools is not flattened into plain text.
    saveSkill(config.skillsDir, { name: 'hub-job', description: 'Runs on a model', model: 'nope', tools: ['read_memory'], body: 'HUB' });
    await assert.rejects(run({ name: 'hub-job', description: 'x', body: 'x', replace: true }), /own model or tools/);
    assert.match(fs.readFileSync(path.join(config.skillsDir, 'hub-job.md'), 'utf8'), /HUB/);

    // The name is a file name: only lowercase letters, digits and "-" reach the disk, and what a model writes in the
    // user's language is cleaned up instead of refused (a refusal it cannot fix looks like "the tool does not work").
    assert.equal(skillFileName('../evil'), 'evil');
    assert.equal(skillFileName('Meal Plan_2'), 'meal-plan-2');
    assert.equal(skillFileName('1abc'), 'abc');
    const thai = skillFileName('ใบเตือนยา');
    assert.match(thai, /^skill-[0-9a-f]{6}$/, 'a title with no usable letters gets a stable name');
    assert.equal(skillFileName('ใบเตือนยา'), thai);
    assert.match(String(await run({ name: 'ใบเตือนยา', description: 'ช่วยตั้งเตือนกินยา', body: 'ถามเวลาแล้วตั้งเตือน' })), new RegExp(`Saved skill "${thai}"`));
    const kept = loadSkills(config.skillsDir).find((skill) => skill.name === thai);
    assert.match(kept?.description ?? '', /ใบเตือนยา/, 'the Thai title stays in the description');
    assert.throws(() => tool.inputSchema.parse({ name: '', description: 'x', body: 'x' }), 'an empty name is refused');
    assert.throws(() => tool.inputSchema.parse({ name: 'big', description: 'x', body: 'x'.repeat(20_001) }), 'an oversized body is refused');
    // Booleans sent as text still count.
    assert.ok(tool.inputSchema.parse({ name: 'x', description: 'x', body: 'x', replace: 'true', use: 'false' }));
    await run({ name: 'meal-plan', description: 'Plan meals v3', body: 'THIRD VERSION', replace: 'true', use: 'false' });
    assert.match(fs.readFileSync(path.join(config.skillsDir, 'meal-plan.md'), 'utf8'), /THIRD VERSION/);
  } finally {
    await testCore.cleanup();
  }
});

test('skill_create through a real agent turn: offered to an agent that never listed it, asks for approval, and the file appears', async () => {
  const { runAgent } = await import('../loop/agent-loop.ts');
  const { scriptedModel, textStep, toolStep, collect, eventsOf } = await import('./helpers.ts');
  const model = scriptedModel([
    toolStep('skill_create', { name: 'packing-list', description: 'Make a packing list for a trip', body: '1. Ask where and how long.\n2. List clothes, documents, chargers.' }),
    textStep('บันทึก skill แล้วค่ะ'),
  ]);
  const testCore = await makeTestCore({ models: { mimi: model } });
  try {
    const { core, config } = testCore;
    const base = core.agents.get('mimi');
    assert.ok(!base.tools.includes('skill_create'), 'the agent file does not list it');
    const events = await collect(runAgent(core.deps, { agent: base, userText: 'ทำเป็น skill เก็บไว้หน่อย' }));
    const offered = ((model.doStreamCalls[0] as { tools?: Array<{ name: string }> }).tools ?? []).map((entry) => entry.name);
    assert.ok(offered.includes('skill_create'), 'every agent is offered skill_create');
    const call = eventsOf(events, 'tool-call').find((event) => event.call.name === 'skill_create');
    assert.ok(call, 'the model was offered skill_create and called it');
    assert.ok(eventsOf(events, 'permission-request').length > 0, 'a write tool asks the user first');
    const result = eventsOf(events, 'tool-result').find((event) => event.result.name === 'skill_create');
    assert.ok(result, 'the call ended with a result');
    assert.equal(result.result.ok, true, `skill_create failed: ${JSON.stringify(result.result)}`);
    assert.ok(fs.existsSync(path.join(config.skillsDir, 'packing-list.md')), 'the skill file is on disk');
  } finally {
    await testCore.cleanup();
  }
});

test('use_skill / load_skill with a tool name say it is a tool (the mistake an agent made with skill_create)', async () => {
  const { createSkillTool } = await import('../skills/skills.ts');
  const tool = createSkillTool([{ name: 'mimiamp-player', description: 'x', tools: [], file: '(none)', body: 'x' }]);
  await assert.rejects(tool.execute({ name: 'skill_create' }, context('mimi')), /No skill "skill_create". Available: mimiamp-player..*looks like a tool, not a skill/s);
  await assert.rejects(tool.execute({ name: 'nope' }, context('mimi')), (error: Error) => !/looks like a tool/.test(error.message));
});
