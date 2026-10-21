import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { JsonValue, ToolContext, WorkflowRunResult, WorkflowView } from '@mimi/shared';
import { loadSkills, readSkillBody } from '../skills/skills.ts';
import { createWorkflowAuthorTools, type WorkflowAuthorDeps } from '../workflows/author-tools.ts';
import { TriggerPool } from '../workflows/trigger-pool.ts';
import { WorkflowStore } from '../workflows/workflow-store.ts';

const draft = {
  name: 'daily-report',
  title: 'Daily report',
  description: 'A small test workflow.',
  trigger: { pool: 'manual', config: {} },
  nodes: [
    {
      id: 'mark',
      type: 'set',
      title: 'Mark',
      config: { fields: { ok: true } },
      links: { main: [] },
    },
  ],
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-author-'));
  const workflows = new WorkflowStore(path.join(root, 'workflows'));
  const triggerPool = new TriggerPool(path.join(root, 'pool'));
  const calls: Array<{ name: string; input?: JsonValue }> = [];
  const changed: string[] = [];
  const deps: WorkflowAuthorDeps = {
    agent: 'mimi',
    workflows,
    triggerPool,
    hasAgent: (name) => name === 'mimi' || name === 'tim',
    hasTool: (name) => name === 'web_search',
    agentNames: () => ['mimi', 'tim'],
    tools: () => [{ name: 'web_search', description: 'Search the web.', risk: 'read' }],
    run: async (name, input) => {
      calls.push({ name, input });
      return { name, ok: true, result: 'done', nodes: [] } satisfies WorkflowRunResult;
    },
    changed: (id) => changed.push(id ?? ''),
  };
  const tools = createWorkflowAuthorTools(deps);
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const context = { traceId: 't', thread: 'mimi', agent: 'mimi', allowedDirs: [] } satisfies ToolContext;
  return { root, workflows, triggerPool, calls, changed, tools, tool, context };
}

test('author tools: schema names triggers, node types, tools and rules', async () => {
  const { root, tool, context } = setup();
  try {
    const text = String(await tool('workflow_schema').execute({}, context));
    assert.match(text, /"manual"/);
    assert.match(text, /"form"/);
    assert.match(text, /"http"/);
    assert.match(text, /"web_search"/);
    assert.match(text, /Saved workflows are always disabled/);
    const onlyHttp = String(await tool('workflow_schema').execute({ nodeType: 'http' }, context));
    assert.match(onlyHttp, /"type": "http"/);
    assert.doesNotMatch(onlyHttp, /"type": "set"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('author tools: save always lands disabled, keeps the webhook key, and signals the change', async () => {
  const { root, workflows, changed, tool, context } = setup();
  try {
    const message = await tool('workflow_save').execute({ workflow: draft }, context);
    assert.match(String(message), /disabled until the user reviews and enables it/);
    const first = workflows.get('mimi', 'daily-report')!;
    assert.equal(first.enabled, false);
    assert.equal(first.agent, 'mimi');
    assert.ok(first.webhookKey);
    assert.deepEqual(changed, ['mimi/daily-report']);

    await tool('workflow_save').execute({ workflow: { ...draft, title: 'Daily report v2' } }, context);
    const second = workflows.get('mimi', 'daily-report')!;
    assert.equal(second.title, 'Daily report v2');
    assert.equal(second.webhookKey, first.webhookKey, 'replacing a workflow keeps its URL');
    assert.deepEqual(changed, ['mimi/daily-report', 'mimi/daily-report']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('author tools: JSON strings work, and invalid drafts are rejected before writing', async () => {
  const { root, workflows, tool, context } = setup();
  try {
    const saved = await tool('workflow_save').execute({ workflow: JSON.stringify({ ...draft, name: 'json-draft' }) }, context);
    assert.match(String(saved), /json-draft/);
    assert.equal(workflows.get('mimi', 'json-draft')!.enabled, false);

    await assert.rejects(
      tool('workflow_save').execute(
        {
          workflow: {
            ...draft,
            name: 'bad-tool',
            nodes: [{ id: 'one', type: 'tool', config: { tool: 'missing' }, links: { main: [] } }],
          },
        },
        context,
      ),
      /unknown tool "missing"/,
    );
    assert.equal(workflows.get('mimi', 'bad-tool'), undefined);

    await assert.rejects(
      tool('workflow_validate').execute({ workflow: { ...draft, trigger: { pool: 'nope', config: {} } } }, context),
      /Unknown trigger "nope"/,
    );
    assert.equal(workflows.get('mimi', 'nope'), undefined);
    assert.match(
      String(await tool('workflow_validate').execute({ workflow: draft }, context)),
      /The workflow is valid/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('author tools: an agent can only read, run and delete its own workflows', async () => {
  const { root, workflows, calls, changed, tool, context } = setup();
  try {
    const timView: WorkflowView = {
      name: 'secret',
      agent: 'tim',
      title: 'Secret',
      description: '',
      enabled: true,
      trigger: { pool: 'manual', config: {} },
      webhook: null,
      nodes: [{ id: 'one', type: 'set', config: { fields: { private: true } }, links: { main: [] } }],
    };
    workflows.save(timView);

    await assert.rejects(tool('workflow_get').execute({ name: 'secret' }, context), /No workflow "secret"/);
    await assert.rejects(tool('workflow_delete').execute({ name: 'secret' }, context), /No workflow "secret"/);
    await assert.rejects(tool('workflow_run').execute({ name: 'secret' }, context), /No workflow "secret"/);
    assert.ok(workflows.get('tim', 'secret'), 'another agent cannot delete it');

    await tool('workflow_save').execute({ workflow: draft }, context);
    const run = String(await tool('workflow_run').execute({ name: 'daily-report', input: '{"who":"mimi"}' }, context));
    assert.match(run, /"ok": true/);
    assert.match(run, /"result": "done"/);
    assert.deepEqual(calls, [{ name: 'daily-report', input: { who: 'mimi' } }]);

    await tool('workflow_delete').execute({ name: 'daily-report' }, context);
    assert.equal(workflows.get('mimi', 'daily-report'), undefined);
    assert.deepEqual(changed, ['mimi/daily-report', 'mimi/daily-report']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skills: workflow-builder ships built in, and a user file overrides it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-skills-'));
  try {
    const builtin = loadSkills(path.join(root, 'skills')).find((skill) => skill.name === 'workflow-builder')!;
    assert.equal(builtin.builtin, true);
    assert.equal(builtin.model, undefined);
    assert.ok(builtin.tools.includes('workflow_save'));
    assert.match(readSkillBody(builtin), /workflow_schema/);

    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', 'workflow-builder.md'),
      '---\nname: workflow-builder\ndescription: My builder\n---\nFollow my own rules.',
      'utf8',
    );
    const override = loadSkills(path.join(root, 'skills')).find((skill) => skill.name === 'workflow-builder')!;
    assert.equal(override.builtin, undefined);
    assert.equal(override.description, 'My builder');
    assert.equal(readSkillBody(override), 'Follow my own rules.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('author tools: a target-aware caller can work on another agent\'s workflows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-author-target-'));
  const workflows = new WorkflowStore(path.join(root, 'workflows'));
  const triggerPool = new TriggerPool(path.join(root, 'pool'));
  const runs: Array<{ agent: string; name: string; input?: JsonValue }> = [];
  const deps: WorkflowAuthorDeps = {
    agent: 'overseer',
    allowTarget: true,
    workflows,
    triggerPool,
    hasAgent: (name) => ['overseer', 'mimi', 'tim'].includes(name),
    hasTool: (name) => name === 'web_search',
    agentNames: () => ['overseer', 'mimi', 'tim'],
    tools: () => [{ name: 'web_search', description: 'Search the web.', risk: 'read' }],
    run: async () => {
      throw new Error('the owning agent call should not run');
    },
    runFor: async (agent, name, input) => {
      runs.push({ agent, name, input });
      return { name, ok: true, result: 'done', nodes: [] } satisfies WorkflowRunResult;
    },
    changed: () => {},
  };
  const tools = createWorkflowAuthorTools(deps);
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const context = { traceId: 't', thread: 'overseer', agent: 'overseer', allowedDirs: [] } satisfies ToolContext;
  try {
    const saved = String(await tool('workflow_save').execute({ agent: 'tim', workflow: draft }, context));
    assert.match(saved, /agent "tim"/);
    assert.equal(workflows.get('tim', 'daily-report')!.agent, 'tim');
    assert.equal(workflows.get('overseer', 'daily-report'), undefined);

    const listed = String(await tool('workflow_list').execute({ agent: 'tim' }, context));
    assert.match(listed, /daily-report/);
    assert.match(String(await tool('workflow_get').execute({ agent: 'tim', name: 'daily-report' }, context)), /"agent": "tim"/);

    await tool('workflow_run').execute({ agent: 'tim', name: 'daily-report', input: '{"x":1}' }, context);
    assert.deepEqual(runs, [{ agent: 'tim', name: 'daily-report', input: { x: 1 } }]);

    await assert.rejects(tool('workflow_save').execute({ agent: 'nobody', workflow: draft }, context), /Unknown agent "nobody"/);
    await tool('workflow_delete').execute({ agent: 'tim', name: 'daily-report' }, context);
    assert.equal(workflows.get('tim', 'daily-report'), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
