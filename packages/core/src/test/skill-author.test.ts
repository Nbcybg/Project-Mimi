import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolContext, ToolDefinition } from '@mimi/shared';
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

    // The name is a file name: nothing outside lowercase letters, digits and "-" gets in.
    for (const bad of ['../evil', 'Evil', 'a_b', '1abc', '']) {
      assert.throws(() => tool.inputSchema.parse({ name: bad, description: 'x', body: 'x' }), `name "${bad}" is refused`);
    }
    assert.throws(() => tool.inputSchema.parse({ name: 'big', description: 'x', body: 'x'.repeat(20_001) }), 'an oversized body is refused');

  } finally {
    await testCore.cleanup();
  }
});
