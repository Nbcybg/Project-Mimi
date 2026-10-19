import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentCatalog, listAgents, loadAgent, parseAgentFile } from '../agents/loader.ts';
import { loadConfig } from '../config.ts';
import { openDb } from '../db/db.ts';
import { MessagesRepo } from '../db/messages-repo.ts';
import { GoogleAuth } from '../google/auth.ts';
import { MemoryStore } from '../memory/store.ts';
import { parseModelRef } from '../providers/registry.ts';
import { loadSettings } from '../providers/settings.ts';
import { TriggerStore } from '../scheduler/triggers.ts';
import { ChatStore } from '../chat/chat-store.ts';
import { MemoStore, StatusStore } from '../chat/state-store.ts';
import { MicrosoftAuth } from '../microsoft/auth.ts';
import { loadSkills } from '../skills/skills.ts';
import { createToolRegistry } from '../tools/index.ts';

const VALID = `---
name: helper
description: Test agent
model: google/gemini-2.5-pro
small_model: deepseek/deepseek-flash
tools: [read_file]
can_message: [mimi]
budgets:
  max_rounds: 5
---
You are a helper.

Second paragraph.
`;

test('parses frontmatter and body', () => {
  assert.deepEqual(parseAgentFile(VALID), {
    name: 'helper',
    displayName: '',
    description: 'Test agent',
    models: { model: 'google/gemini-2.5-pro', small_model: 'deepseek/deepseek-flash' },
    tools: ['read_file'],
    skills: [],
    canMessage: ['mimi'],
    budgets: { maxRounds: 5, maxTokens: 200_000 },
    systemPrompt: 'You are a helper.\n\nSecond paragraph.',
  });
});

test('handles CRLF line endings', () => {
  assert.equal(parseAgentFile(VALID.replaceAll('\n', '\r\n')).name, 'helper');
});

test('applies defaults when only the name is given', () => {
  const agent = parseAgentFile('---\nname: bare\n---\nHello.');
  assert.deepEqual(agent.models, {});
  assert.deepEqual(agent.tools, []);
  assert.deepEqual(agent.canMessage, []);
  assert.deepEqual(agent.budgets, { maxRounds: 12, maxTokens: 200_000 });
});

test('rejects malformed agent files with a readable error', () => {
  assert.throws(() => parseAgentFile('no frontmatter here'), /missing "---" frontmatter/);
  assert.throws(() => parseAgentFile('---\nname: [unclosed\n---\nBody'), /invalid YAML/);
  assert.throws(() => parseAgentFile('---\ndescription: x\n---\nBody'), /name/);
  assert.throws(() => parseAgentFile('---\nname: Bad Name\n---\nBody'), /name/);
  assert.throws(() => parseAgentFile('---\nname: a\nbudgets:\n  max_rounds: 0\n---\nBody'), /max_rounds/);
  assert.throws(() => parseAgentFile('---\nname: a\nmodel: No Provider\n---\nBody'), /provider/);
  assert.throws(() => parseAgentFile('---\nname: a\nmodels:\n  chat: google/x\n---\nBody'), /models/);
  assert.throws(() => parseAgentFile('---\nname: a\ntypo_field: 1\n---\nBody'), /typo_field/);
  assert.throws(() => parseAgentFile('---\nname: a\n---\n   \n'), /body is empty/);
});

test('seeded settings and agents load, and their tools resolve', () => {
  const config = loadConfig({});
  const settings = loadSettings(config.settingsPath, {});
  assert.ok(parseModelRef(settings.model).provider);

  const db = openDb(':memory:');
  const agents = new AgentCatalog(config.agentsDir);
  const registry = createToolRegistry({
    memory: new MemoryStore(db),
    messages: new MessagesRepo(db),
    triggers: new TriggerStore(db, config.timezone),
    agents,
    google: GoogleAuth.fromEnv({}, config.googleTokenPath),
    microsoft: MicrosoftAuth.fromEnv({}, config.microsoftTokenPath),
    skills: loadSkills(config.skillsDir),
    chats: new ChatStore(db),
    status: new StatusStore(db),
    memos: new MemoStore(db),
    timezone: config.timezone,
    // Tools that need a service the core always has.
    notifyUser: () => ({}),
    readDocument: async () => '',
  });
  // No agents are shipped: the user creates their own in the app. Whatever exists must load.
  for (const name of listAgents(config.agentsDir)) {
    const agent = agents.get(name);
    assert.equal(agent.name, name);
    assert.equal(registry.select(agent.tools).length, agent.tools.length);
  }
  assert.ok(registry.names().includes('read_file') && registry.names().includes('gmail_read'));
  for (const tool of ['status_set', 'memo_save', 'list_sessions']) assert.ok(registry.names().includes(tool), tool);
  assert.throws(() => loadAgent(config.agentsDir, 'nobody'), /Unknown agent "nobody"/);
});
