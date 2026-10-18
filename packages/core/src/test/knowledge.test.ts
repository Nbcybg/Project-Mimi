import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { WorkflowView } from '@mimi/shared';
import { openDb } from '../db/db.ts';
import { chunkText, type Embedder, ftsQuery, KnowledgeStore } from '../knowledge/store.ts';
import { createKnowledgeTools } from '../knowledge/tools.ts';
import { runWorkflowNode, type WorkflowRunnerDeps, WorkflowState } from '../workflows/runner.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-kb-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BILLS = 'บิลค่าไฟฟ้าเดือนตุลาคม ยอดชำระ 1,250 บาท ครบกำหนดวันที่ 25';
const WATER = 'ค่าน้ำประปาเดือนตุลาคม 300 บาท';
const RECIPE = 'สูตรต้มยำกุ้ง ใช้ข่า ตะไคร้ ใบมะกรูด พริก น้ำปลา มะนาว';

/** A toy embedder: words about money point one way, food another. */
const toyEmbed: Embedder = async (_model, texts) =>
  texts.map((text) => {
    const money = /บาท|ค่า|บิล|จ่าย|เงิน/.test(text) ? 1 : 0;
    const food = /ต้ม|กุ้ง|อาหาร|กิน|สูตร/.test(text) ? 1 : 0;
    return [money, food, 0.1];
  });

test('chunks: paragraphs pack up to the size, long ones split, seams overlap', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('a\n\nb'), ['a\n\nb']);
  const long = Array.from({ length: 30 }, (_, n) => `ย่อหน้า ${n} ${'ข้อความ '.repeat(10)}`).join('\n\n');
  const chunks = chunkText(long, 300, 60);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks[1]!.includes('ย่อหน้า 0') || chunks[1]!.startsWith('ข้อความ'), 'the second chunk repeats the end of the first');
  assert.equal(ftsQuery('ab'), null);
  assert.match(ftsQuery('ค่าไฟ')!, /"ค่าไฟ" OR "ค่า"/);
});

test('knowledge store: Thai keyword search, replace by source, delete', async () => {
  const store = new KnowledgeStore(openDb(':memory:'));
  assert.throws(() => store.saveCollection({ name: 'Bad Name' }), /lowercase/);
  store.saveCollection({ name: 'home', title: 'บ้าน', description: 'บิลและเอกสารบ้าน' });
  await store.add('home', { title: 'ค่าไฟ', text: BILLS, source: 'mail:1' });
  await store.add('home', { title: 'ค่าน้ำ', text: WATER });
  await store.add('home', { title: 'ต้มยำ', text: RECIPE });

  // No spaces in the query, still found; the bill ranks first.
  const hits = await store.search('ค่าไฟฟ้าเดือนนี้เท่าไหร่');
  assert.equal(hits[0]!.document, 'ค่าไฟ');
  assert.equal(hits[0]!.via, 'keyword');
  assert.ok(!hits.some((hit) => hit.document === 'ต้มยำ'));
  // Two-letter queries fall back to substring search.
  assert.deepEqual((await store.search('กุ้')).map((hit) => hit.document), ['ต้มยำ']);

  // Same source again: the old version goes.
  await store.add('home', { title: 'ค่าไฟ (แก้)', text: 'ค่าไฟฟ้าเดือนตุลาคม ยอดใหม่ 990 บาท', source: 'mail:1' });
  const documents = store.documents('home');
  assert.deepEqual(documents.map((doc) => doc.title).sort(), ['ค่าน้ำ', 'ค่าไฟ (แก้)', 'ต้มยำ'].sort());
  assert.match((await store.search('ค่าไฟฟ้า'))[0]!.text, /990/);

  const view = store.collection('home')!;
  assert.deepEqual([view.documents, view.chunks, view.embedded, view.embeddingModel], [3, 3, 0, null]);
  assert.equal(store.deleteDocument(documents.find((doc) => doc.title === 'ต้มยำ')!.id), true);
  assert.deepEqual(await store.search('ต้มยำกุ้ง'), []);
  assert.equal(store.deleteCollection('home'), true);
  assert.deepEqual(store.collections(), []);
  await assert.rejects(store.add('home', { title: 'x', text: 'y' }), /No knowledge base/);
});

test('knowledge store: vectors when a model is set, fused with keywords, failures fall back', async () => {
  const calls: string[] = [];
  let failing = false;
  const embed: Embedder = async (model, texts) => {
    calls.push(`${model}:${texts.length}`);
    if (failing) throw new Error('quota');
    return toyEmbed(model, texts);
  };
  const store = new KnowledgeStore(openDb(':memory:'), embed);
  store.saveCollection({ name: 'home', embeddingModel: 'google/gemini-embedding-001' });
  await store.add('home', { title: 'ค่าไฟ', text: BILLS });
  await store.add('home', { title: 'ต้มยำ', text: RECIPE });
  assert.equal(store.collection('home')!.embedded, 2);

  // "อาหารเย็น" shares no trigram with the recipe, but the vector finds it.
  const food = await store.search('อยากกินอะไรดี');
  assert.equal(food[0]!.document, 'ต้มยำ');
  assert.equal(food[0]!.via, 'vector');
  const bill = await store.search('บิลค่าไฟ');
  assert.equal(bill[0]!.document, 'ค่าไฟ');
  assert.equal(bill[0]!.via, 'both');

  failing = true;
  const added = await store.add('home', { title: 'ค่าน้ำ', text: WATER });
  assert.match(added.warning!, /keyword only/);
  assert.equal(store.collection('home')!.embedded, 2);
  // Search still answers by keyword when the query cannot be embedded.
  assert.equal((await store.search('ค่าน้ำประปา'))[0]!.document, 'ค่าน้ำ');
  failing = false;
  assert.equal(await store.embedMissing('home'), 1);
  assert.equal(store.collection('home')!.embedded, 3);
  // A new model makes every vector stale.
  store.saveCollection({ name: 'home', embeddingModel: 'google/other' });
  assert.equal(store.collection('home')!.embedded, 0);
  assert.equal(await store.embedMissing('home'), 3);
  assert.ok(calls.includes('google/other:3'));
});

test('knowledge_search tool: lists bases when asked for a missing one, renders hits', async () => {
  const store = new KnowledgeStore(openDb(':memory:'));
  const [tool] = createKnowledgeTools(store);
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };
  assert.match(String(await tool!.execute({ query: 'x' }, context, {})), /no knowledge bases yet/);
  store.saveCollection({ name: 'home', title: 'บ้าน' });
  await store.add('home', { title: 'ค่าไฟ', text: BILLS, source: 'mail:1' });
  assert.match(String(await tool!.execute({ query: 'x', collection: 'work' }, context, {})), /Available: home \(บ้าน\)/);
  const found = String(await tool!.execute({ query: 'ค่าไฟฟ้า' }, context, {}));
  assert.match(found, /^\[1\] ค่าไฟ \(mail:1\)\n.*1,250 บาท/);
});

test('knowledge node: search gives context or items, add stores the item text', async () => {
  const store = new KnowledgeStore(openDb(':memory:'));
  store.saveCollection({ name: 'home' });
  await store.add('home', { title: 'ค่าไฟ', text: BILLS });
  const deps: WorkflowRunnerDeps = {
    runAgent: async () => '',
    tool: () => undefined,
    speak: () => {},
    mail: { list: async () => [], markRead: async () => {} },
    state: new WorkflowState(path.join(tmp, 'state.json')),
    allowedDirs: [],
    knowledge: store,
  };
  const workflow: WorkflowView = { name: 'f', agent: 'mimi', title: 'F', description: '', enabled: true, trigger: { pool: 'manual', config: {} }, webhook: null, nodes: [] };
  const context = await runWorkflowNode(workflow, { id: 'n1', type: 'knowledge', config: { query: '{{ $json.text }}' }, links: { main: [] } }, [{ json: { text: 'ค่าไฟเท่าไหร่' } }], deps);
  assert.equal(context.ok, true, context.error);
  assert.match(String(context.outputs.main![0]!.json.context), /1,250 บาท/);
  assert.equal(context.outputs.main![0]!.json.text, 'ค่าไฟเท่าไหร่');

  const items = await runWorkflowNode(workflow, { id: 'n1', type: 'knowledge', config: { query: 'ค่าไฟฟ้า', output: 'items' }, links: { main: [] } }, [{ json: {} }], deps);
  assert.equal(items.outputs.main![0]!.json.document, 'ค่าไฟ');

  const added = await runWorkflowNode(
    workflow,
    { id: 'n1', type: 'knowledge', config: { operation: 'add', collection: 'home', title: '{{ $json.Subject }}', source: 'mail:{{ $json.Id }}' }, links: { main: [] } },
    [{ json: { Id: 9, Subject: 'นัดซ่อมแอร์', text: 'ช่างแอร์จะมาวันเสาร์ 10 โมง' } }],
    deps,
  );
  assert.equal(added.ok, true, added.error);
  assert.equal(store.documents('home')[0]!.source, 'mail:9');
  assert.equal((await store.search('ช่างแอร์'))[0]!.document, 'นัดซ่อมแอร์');

  const missing = await runWorkflowNode(workflow, { id: 'n1', type: 'knowledge', config: { operation: 'add', text: 'x' }, links: { main: [] } }, [{ json: {} }], deps);
  assert.match(missing.error!, /pick the knowledge base/);
});

test('core: add from text and from a file in the allowed folders, agents get the tool', async () => {
  const target = await makeTestCore({});
  target.core.knowledge.saveCollection({ name: 'manuals', title: 'คู่มือ' });
  await target.core.addKnowledge('manuals', { title: 'แอร์', text: 'ล้างฟิลเตอร์แอร์ทุก 2 สัปดาห์' });
  const folder = target.core.deps.allowedDirs[0]!;
  fs.writeFileSync(path.join(folder, 'tv.html'), '<html><title>ทีวี</title><body><p>กดปุ่ม Home ค้าง 5 วินาทีเพื่อรีเซ็ต</p></body></html>');
  const fromFile = await target.core.addKnowledge('manuals', { path: 'tv.html' });
  assert.equal(fromFile.document.title, 'tv.html');
  assert.equal((await target.core.knowledge.search('รีเซ็ตทีวี'))[0]!.document, 'tv.html');
  await assert.rejects(target.core.addKnowledge('manuals', { path: path.join(os.tmpdir(), 'outside.txt') }), /outside the allowed folders/);
  await assert.rejects(target.core.addKnowledge('manuals', { text: '   ' }), /no text/);
  assert.ok(target.core.tools.get('knowledge_search'));
  await target.cleanup();
});
