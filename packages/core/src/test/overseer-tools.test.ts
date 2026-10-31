import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolContext, ToolDefinition } from '@mimi/shared';
import { ensureOverseer, OVERSEER_NAME } from '../overseer/overseer.ts';
import { makeTestCore } from './core-helpers.ts';

const context: ToolContext = { traceId: 'overseer-tools-test', thread: 'main', agent: OVERSEER_NAME, allowedDirs: [] };

test('overseer: reads triggers, tests a tool and sees the one-shot state', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name) as ToolDefinition<any> | undefined;
      assert.ok(tool, `tool ${name}`);
      return tool.execute(input, context);
    };

    const trigger = core.triggers.create({
      kind: 'reminder',
      title: 'drink water',
      text: 'Drink a glass of water.',
      fireAt: '2099-01-01T09:00:00',
      agent: 'mimi',
    });
    const list = JSON.parse(await run('trigger_list', {}));
    assert.ok(list.some((entry: { id: number; kind: string; oneShotState: string }) => entry.id === trigger.id && entry.kind === 'fire_at' && entry.oneShotState === 'pending'));
    const one = JSON.parse(await run('trigger_get', { id: trigger.id }));
    assert.equal(one.owner, 'agent mimi');
    assert.equal(one.status, 'active');
    core.triggers.cancel(trigger.id);
    const cancelled = JSON.parse(await run('trigger_get', { id: trigger.id }));
    assert.equal(cancelled.oneShotState, 'cancelled');

    const file = path.join(config.allowedDirs[0]!, 'hello.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'hello from the workspace');
    const tested = JSON.parse(await run('tool_test', { name: 'read_file', input: { path: 'hello.txt' } }));
    assert.equal(tested.ok, true);
    assert.match(tested.output, /hello from the workspace/);
    const logged = core.db.prepare(`SELECT tool, agent, risk, ok FROM tool_calls WHERE tool = 'read_file' ORDER BY id DESC LIMIT 1`).get() as
      | { tool: string; agent: string; risk: string; ok: number }
      | undefined;
    assert.deepEqual(logged, { tool: 'read_file', agent: OVERSEER_NAME, risk: 'read', ok: 1 });
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: error_codes explains a code and rejects an unknown one', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const tool = tools.find((entry) => entry.name === 'error_codes') as ToolDefinition<any>;
    assert.ok(tool);
    const one = JSON.parse(await tool.execute({ code: 'E-RATE-429' }, context));
    assert.equal(one.code, 'E-RATE');
    assert.match(one.fix, /retry/i);
    const all = JSON.parse(await tool.execute({}, context));
    assert.ok(all.some((entry: { code: string }) => entry.code === 'E-CONFIG'));
    await assert.rejects(() => tool.execute({ code: 'E-NOPE' }, context), /Unknown error code/);
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: agent_message runs a real test turn and is rate-limited', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const tool = tools.find((entry) => entry.name === 'agent_message') as ToolDefinition<any>;
    assert.ok(tool);
    const first = JSON.parse(await tool.execute({ agent: 'mimi', text: 'say hello', test: true }, context));
    assert.equal(first.test, true);
    assert.equal(first.agent, 'mimi');
    assert.ok(first.text.length > 0);
    await assert.rejects(() => tool.execute({ agent: 'mimi', text: 'again', test: true }, context), /wait/i);
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: config_validate finds missing secrets and prompt/tool drift', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name) as ToolDefinition<any> | undefined;
      assert.ok(tool, `tool ${name}`);
      return tool.execute(input, context);
    };

    await run('tool_save', {
      tool: {
        name: 'missing-secret',
        description: 'Needs a key that is not in the vault',
        kind: 'http',
        params: [],
        settings: [],
        config: { method: 'GET', url: 'https://example.invalid/?key={{secret.NOT_THERE}}' },
      },
    });
    const mimi = core.agents.get('mimi');
    await run('agent_save', { name: 'mimi', systemPrompt: `${mimi.systemPrompt}\nUse web_search before answering.` });
    const report = JSON.parse(await run('config_validate', {}));
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((issue: { code: string }) => issue.code === 'CFG-TOOL-SECRET'));
    assert.ok(report.warnings.some((issue: { code: string; where: string }) => issue.code === 'CFG-PROMPT-TOOL' && issue.where === 'agent "mimi"'));
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: agent and tool history can be restored', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name) as ToolDefinition<any> | undefined;
      assert.ok(tool, `tool ${name}`);
      return tool.execute(input, context);
    };

    const original = core.agents.get('mimi').systemPrompt;
    await run('agent_save', { name: 'mimi', systemPrompt: 'A completely different prompt.' });
    const history = JSON.parse(await run('agent_history', { name: 'mimi' }));
    assert.ok(history.versions.length >= 1);
    await run('agent_restore', { name: 'mimi', version: history.versions[0].id });
    assert.equal(core.agents.get('mimi').systemPrompt, original);

    await run('tool_save', {
      tool: { name: 'probe', description: 'first', kind: 'code', params: [], settings: [], config: { code: 'return "one";' } },
    });
    await run('tool_save', {
      tool: { name: 'probe', description: 'second', kind: 'code', params: [], settings: [], config: { code: 'return "two";' } },
    });
    const toolHistory = JSON.parse(await run('tool_history', { name: 'probe' }));
    assert.ok(toolHistory.versions.length >= 1);
    await run('tool_restore', { name: 'probe', version: toolHistory.versions[0].id });
    assert.equal(core.tools.customSpecs().find((spec) => spec.name === 'probe')?.description, 'first');
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: skill, preset and workflow versions diff and roll back', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name) as ToolDefinition<any> | undefined;
      assert.ok(tool, `tool ${name}`);
      return tool.execute(input, context);
    };

    await run('skill_save', { skill: { name: 'roll-skill', description: 'first', body: 'BODY ONE' } });
    await run('skill_save', { skill: { name: 'roll-skill', description: 'second', body: 'BODY TWO' } });
    const diff = JSON.parse(await run('config_diff', { kind: 'skill', name: 'roll-skill', next: { body: 'BODY THREE' } }));
    assert.ok(diff.changed.some((entry: { key: string }) => entry.key === 'body'));
    await run('config_rollback', { kind: 'skill', name: 'roll-skill' });
    assert.equal(core.skills().find((skill) => skill.name === 'roll-skill')?.description, 'first');

    await run('tool_save', {
      tool: { name: 'roll-base', description: 'base', kind: 'code', params: [], settings: [], config: { code: 'return "ok";' } },
    });
    await run('preset_save', { preset: { name: 'roll-preset', tool: 'roll-base', label: 'first', settings: {} } });
    await run('preset_save', { preset: { name: 'roll-preset', tool: 'roll-base', label: 'second', settings: {} } });
    await run('config_rollback', { kind: 'preset', name: 'roll-preset' });
    assert.equal(core.tools.presetViews().find((preset) => preset.name === 'roll-preset')?.label, 'first');

    const workflow = (title: string) => ({
      name: 'roll-flow',
      title,
      trigger: { pool: 'manual', config: {} },
      nodes: [{ id: 'mark', type: 'set', config: { fields: { ok: true } }, links: { main: [] } }],
    });
    await run('workflow_save', { workflow: workflow('First title'), agent: 'tim' });
    await run('workflow_save', { workflow: workflow('Second title'), agent: 'tim' });
    await run('config_rollback', { kind: 'workflow', name: 'tim/roll-flow' });
    assert.equal(core.workflows.get('tim', 'roll-flow')?.title, 'First title');
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: machine tools, self-edit, vault, oauth and workflow enable are available', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name) as ToolDefinition<any> | undefined;
      assert.ok(tool, `tool ${name}`);
      return tool.execute(input, context);
    };
    const names = tools.map((tool) => tool.name);
    for (const name of ['read_file', 'run_shell', 'browser_open', 'browser_screenshot', 'computer_screenshot', 'notify_user', 'create_trigger', 'secret_set', 'oauth_start', 'workflow_enable']) {
      assert.ok(names.includes(name), `the Overseer has ${name}`);
    }

    await run('agent_save', { name: 'overseer', description: 'Updated helper' });
    assert.equal(core.agents.get('overseer').description, 'Updated helper');
    await assert.rejects(run('agent_save', { name: 'overseer', addTools: ['web_search'] }), /always has run_shell/);

    const stored = String(await run('secret_set', { name: 'OVERSEER_TEST', value: 'supersecret123' }));
    assert.doesNotMatch(stored, /supersecret123/);
    assert.equal(core.secrets.get('OVERSEER_TEST'), 'supersecret123');
    await run('secret_delete', { name: 'OVERSEER_TEST' });
    assert.equal(core.secrets.get('OVERSEER_TEST'), undefined);

    assert.match(String(await run('oauth_accounts', {})), /No OAuth accounts/);
    await assert.rejects(run('oauth_start', {}), /No .*account/);
  } finally {
    await testCore.cleanup();
  }
});

test('overseer: workflow_runs shows the newest run and its error state', async () => {
  const testCore = await makeTestCore();
  try {
    const { core, config } = testCore;
    const overseer = ensureOverseer(config.agentsDir);
    const tools = core.deps.extraTools?.(overseer, { agent: overseer }) ?? [];
    const run = async (name: string, input: unknown) => {
      const tool = tools.find((entry) => entry.name === name) as ToolDefinition<any> | undefined;
      assert.ok(tool, `tool ${name}`);
      return tool.execute(input, context);
    };

    core.workflows.save({
      agent: 'tim',
      name: 'probe-flow',
      title: 'Probe flow',
      description: '',
      enabled: false,
      trigger: { pool: 'manual', config: {} },
      webhook: null,
      nodes: [{ id: 'mark', type: 'set', title: 'Mark', config: { fields: { ok: true } }, links: { main: [] } }],
    });
    await core.runWorkflow('tim', 'probe-flow');
    const runs = JSON.parse(await run('workflow_runs', { agent: 'tim' }));
    assert.ok(runs.some((entry: { workflow: string; ok: boolean }) => entry.workflow === 'tim/probe-flow' && entry.ok));
  } finally {
    await testCore.cleanup();
  }
});
