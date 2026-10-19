import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { buildSystem } from '../loop/prompt-builder.ts';
import { WardrobeStore } from '../wardrobe/wardrobe-store.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-wardrobe-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('wardrobe store: outfits are folders; ids are checked; pictures, rename and delete work', () => {
  const store = new WardrobeStore(path.join(tmp, 'a'), () => ['tim', 'mimi']);
  assert.deepEqual(store.list(), []);
  const saved = store.save({ id: 'wa01', name: ' ชุดทำงาน ', description: 'เชิ้ตขาว กระโปรงดำ' });
  assert.deepEqual(saved, { id: 'wa01', name: 'ชุดทำงาน', description: 'เชิ้ตขาว กระโปรงดำ', image: null, sprites: {} });
  assert.throws(() => store.save({ id: 'Bad Id' }), /lowercase/);
  assert.throws(() => store.save({ id: 'user' }), /reserved/);
  assert.throws(() => store.save({ id: 'tim' }), /id of an agent/);

  assert.throws(() => store.saveImage('nope', 'image/png', PNG), /No outfit/);
  assert.throws(() => store.saveImage('wa01', 'text/html', PNG), /PNG/);
  store.saveImage('wa01', 'image/png', PNG);
  assert.equal(store.readImage('wa01')!.mime, 'image/png');
  assert.ok(store.get('wa01')!.image);

  store.save({ id: 'wa02', name: 'ชุดอยู่บ้าน' });
  assert.throws(() => store.rename('wa01', 'wa02'), /already exists/);
  const moved = store.rename('wa01', 'work');
  assert.equal(moved.name, 'ชุดทำงาน');
  assert.ok(moved.image, 'the picture moves with the outfit');
  assert.equal(store.has('wa01'), false);
  assert.deepEqual(store.list().map((outfit) => outfit.id), ['wa02', 'work']);

  store.removeImage('work');
  assert.equal(store.get('work')!.image, null);
  assert.equal(store.remove('work'), true);
  assert.equal(store.remove('work'), false);
});

test('wardrobe store: prompt entries and the index an agent reads', () => {
  const store = new WardrobeStore(path.join(tmp, 'b'));
  assert.equal(store.renderIndex(), '');
  store.save({ id: 'wa01', name: 'ชุดทำงาน', description: 'เชิ้ตขาว\nกระโปรงดำ' });
  store.save({ id: 'wa02', name: 'ชุดอยู่บ้าน' });
  assert.deepEqual(store.promptEntries(), { wa01: 'ชุดทำงาน (เชิ้ตขาว กระโปรงดำ)', wa02: 'ชุดอยู่บ้าน' });
  const index = store.renderIndex();
  assert.match(index, /- wa01: ชุดทำงาน - เชิ้ตขาว กระโปรงดำ/);
  assert.match(index, /- wa02: ชุดอยู่บ้าน$/);
});

test('core: {{wa01}} in an agent prompt expands; the outfit shows in the status; agent ids cannot clash', async () => {
  const target = await makeTestCore({});
  const { core } = target;
  core.wardrobe.save({ id: 'wa01', name: 'ชุดทำงาน', description: 'เชิ้ตขาว' });
  const agent = { ...core.agents.get('mimi'), systemPrompt: '{{char}} wears {{wa01}} for {{user}}.' };
  const [block] = buildSystem({ agent, workingDir: undefined, memorySnapshot: '', summaries: [], vars: core.deps.promptVars!(agent) });
  assert.match(String(block!.content), /^mimi wears ชุดทำงาน \(เชิ้ตขาว\) for the user\./);

  // An agent that can change its status is told which outfits exist.
  assert.doesNotMatch(core.deps.promptExtras!(core.agents.get('tim')), /Wardrobe/);
  const withStatus = { ...core.agents.get('tim'), tools: ['status_set'] };
  assert.match(core.deps.promptExtras!(withStatus), /- wa01: ชุดทำงาน - เชิ้ตขาว/);

  core.status.set('tim', 'outfit', 'wa01');
  const rendered = core.status.render('tim', (outfit) => core.wardrobe.promptEntries()[outfit]);
  assert.match(rendered, /outfit: wa01 = ชุดทำงาน \(เชิ้ตขาว\)/);
  core.status.set('tim', 'outfit', 'pyjamas');
  assert.match(core.status.render('tim', (outfit) => core.wardrobe.promptEntries()[outfit]), /outfit: pyjamas$/m);

  assert.throws(() => core.wardrobe.save({ id: 'scout' }), /id of an agent/);
  await target.cleanup();
});
