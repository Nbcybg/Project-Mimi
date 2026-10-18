import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseAgentFile, serializeAgent } from '../agents/loader.ts';
import { openDb } from '../db/db.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { createKnowledgeTools } from '../knowledge/tools.ts';
import { runAgent } from '../loop/agent-loop.ts';
import { createProfileTools } from '../profile/tools.ts';
import { UserProfileStore } from '../profile/user-profile.ts';
import { collect, makeAgent, makeHarness, scriptedModel, textStep } from './helpers.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-agentf-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('agent file: intro card and effort round-trip; a bad effort is refused', () => {
  const agent = parseAgentFile('---\nname: karen\ndescription: การเงิน\nintro: ละเอียดเรื่องตัวเลข ถามกลับก่อนทำ\neffort: high\n---\nคุณคือคาเรน');
  assert.equal(agent.intro, 'ละเอียดเรื่องตัวเลข ถามกลับก่อนทำ');
  assert.equal(agent.effort, 'high');
  const again = parseAgentFile(serializeAgent(agent));
  assert.deepEqual([again.intro, again.effort], [agent.intro, agent.effort]);
  assert.equal(parseAgentFile('---\nname: tim\n---\nทิม').intro, undefined);
  assert.throws(() => parseAgentFile('---\nname: tim\neffort: insane\n---\nทิม'), /effort/);
});

test('agent effort: reaches the model call and wins over the preset', async () => {
  const model = scriptedModel([textStep('ok')]);
  const harness = makeHarness(model);
  await collect(runAgent(harness.deps, { agent: makeAgent({ effort: 'max' }), userText: 'คิดหนัก ๆ' }));
  assert.equal(model.doStreamCalls[0]!.reasoning, 'max');
  const plain = scriptedModel([textStep('ok')]);
  await collect(runAgent(makeHarness(plain).deps, { agent: makeAgent(), userText: 'ปกติ' }));
  assert.equal(plain.doStreamCalls[0]!.reasoning, undefined);
});

test('intro card: other agents see it in send_to and in group chats', async () => {
  const target = await makeTestCore({});
  const [first, second] = target.core.agents.names() as [string, string];
  const file = path.join(target.root, 'user', 'agents', second, 'agent.md');
  const source = fs.readFileSync(file, 'utf8').replace(/^---\n/, '---\nintro: ใจเย็น เก่งตัวเลข\n');
  fs.writeFileSync(file, source);
  const sender = { ...target.core.agents.get(first), canMessage: [second] };
  const tools = target.core.deps.mesh!.toolsFor(sender, undefined);
  const sendTo = tools.find((tool) => tool.name === 'send_to')!;
  assert.match(sendTo.description, new RegExp(`${second} \\(.*\\) — ใจเย็น เก่งตัวเลข`));
  await target.cleanup();
});

test('profile_update: saves facts the agent may see; new ones are private to it', async () => {
  const store = new UserProfileStore(path.join(tmp, 'p', 'profile.json'), path.join(tmp, 'p', 'local.json'));
  store.save({ fields: [{ key: 'salary', label: 'เงินเดือน', value: '50,000', visibleTo: ['karen'] }] }, ['mimi', 'karen']);
  const [tool] = createProfileTools(store, () => ['mimi', 'karen']);
  const as = (agent: string) => ({ traceId: 't', thread: 'main', agent, allowedDirs: [] });
  assert.equal(tool!.risk, 'write', 'the user approves each change');

  assert.match(String(await tool!.execute({ key: 'home_address', label: 'ที่อยู่', value: 'เชียงใหม่' }, as('mimi'), {})), /Added/);
  const added = store.get().fields.find((field) => field.key === 'home_address')!;
  assert.deepEqual(added.visibleTo, ['mimi']);
  assert.match(String(await tool!.execute({ key: 'home_address', value: 'ลำปาง', visible_to: 'everyone' }, as('mimi'), {})), /Updated/);
  assert.deepEqual(store.get().fields.find((field) => field.key === 'home_address'), { key: 'home_address', label: 'ที่อยู่', value: 'ลำปาง', visibleTo: '*' });
  // Not shared with mimi: refused, unchanged.
  assert.match(String(await tool!.execute({ key: 'salary', value: '1' }, as('mimi'), {})), /not shared with you/);
  assert.equal(store.get().fields.find((field) => field.key === 'salary')!.value, '50,000');
});

test('knowledge per agent: a base limited to some agents is invisible to the rest', async () => {
  const store = new KnowledgeStore(openDb(':memory:'));
  store.saveCollection({ name: 'money', title: 'การเงิน', agents: ['karen'] });
  store.saveCollection({ name: 'home', title: 'บ้าน' });
  await store.add('money', { title: 'บัญชี', text: 'ยอดเงินเก็บ 120,000 บาท' });
  await store.add('home', { title: 'แอร์', text: 'ล้างแอร์ทุกเดือน' });
  assert.deepEqual(store.collection('money')!.agents, ['karen']);

  assert.equal((await store.search('ยอดเงินเก็บ', { agent: 'karen' }))[0]!.collection, 'money');
  assert.deepEqual(await store.search('ยอดเงินเก็บ', { agent: 'tim' }), []);
  await assert.rejects(store.search('ยอดเงิน', { collection: 'money', agent: 'tim' }), /not open to tim/);

  const [tool] = createKnowledgeTools(store);
  const listed = String(await tool!.execute({ query: 'x', collection: 'money' }, { traceId: 't', thread: 'm', agent: 'tim', allowedDirs: [] }, {}));
  assert.match(listed, /No knowledge base "money"\. Available: home/);
});
