import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadAgent, parseAgentFile, saveAgent, withoutRetiredTools } from '../agents/loader.ts';

const FILE = `---
name: mimi
display_name: Mimi
tools:
  - read_memory
  - mimiamp
  - web_search
---
You are Mimi.
`;

test('retired tools (mimiamp) are dropped from an agent file instead of failing the agent', () => {
  const agent = parseAgentFile(FILE, 'agent.md');
  assert.deepEqual(agent.tools, ['read_memory', 'web_search']);
  assert.deepEqual(withoutRetiredTools(['mimiamp', 'gmail_read']), ['gmail_read']);
});

test('an agent file written before a tool was removed loads, and is saved without it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-agents-'));
  try {
    fs.mkdirSync(path.join(dir, 'mimi'));
    fs.writeFileSync(path.join(dir, 'mimi', 'agent.md'), FILE);
    const agent = loadAgent(dir, 'mimi');
    assert.deepEqual(agent.tools, ['read_memory', 'web_search']);
    saveAgent(dir, agent);
    assert.ok(!fs.readFileSync(path.join(dir, 'mimi', 'agent.md'), 'utf8').includes('mimiamp'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
