import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { GalleryStore } from '../gallery/gallery-store.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-gallery-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const add = (store: GalleryStore, title: string, extra: { tags?: string[]; description?: string } = {}) =>
  store.add('mimi', { title, mime: 'image/png', data: PNG, source: 'user', ...extra });

test('gallery store: add, list newest first, search by words, ids never come back', () => {
  const store = new GalleryStore(path.join(tmp, 'a'));
  assert.deepEqual(store.list('mimi'), { total: 0, items: [] });
  const rain = add(store, 'ฝนตกหน้าคาเฟ่', { tags: ['Rain', 'cafe', 'rain'], description: 'ยืนหลบฝนด้วยกัน' });
  add(store, 'Sunset beach', { tags: ['beach'] });
  add(store, 'Night market', { description: 'rain started again' });
  assert.deepEqual([rain.id, rain.tags, rain.source, rain.thumb], ['g1', ['rain', 'cafe'], 'user', false]);

  assert.deepEqual(store.list('mimi').items.map((item) => item.id), ['g3', 'g2', 'g1'], 'newest first');
  assert.deepEqual(store.list('mimi', { query: 'rain' }).items.map((item) => item.id), ['g1', 'g3'], 'tag + title beat a description hit');
  assert.deepEqual(store.list('mimi', { query: 'rain cafe' }).items.map((item) => item.id), ['g1'], 'every word must match');
  assert.deepEqual(store.list('mimi', { query: 'คาเฟ่' }).items.map((item) => item.id), ['g1'], 'Thai needs no spaces');
  assert.equal(store.list('mimi', { query: 'nothing' }).total, 0);
  assert.deepEqual(store.list('mimi', { offset: 1, limit: 1 }), { total: 3, items: [store.get('mimi', 'g2')!] });

  assert.equal(store.remove('mimi', 'g3'), true);
  assert.equal(store.remove('mimi', 'g3'), false);
  assert.equal(add(store, 'Another').id, 'g4', 'a removed id is not reused');
  assert.equal(new GalleryStore(path.join(tmp, 'a')).count('mimi'), 3, 'the index is on disk');
});

test('gallery store: update, previews, bad input', () => {
  const store = new GalleryStore(path.join(tmp, 'b'));
  const item = add(store, 'First');
  assert.throws(() => store.add('mimi', { mime: 'text/html', data: PNG, source: 'user' }), /PNG/);
  assert.throws(() => store.add('Bad Name', { mime: 'image/png', data: PNG, source: 'user' }), /Unknown agent/);
  const updated = store.update('mimi', item.id, { title: ' Renamed ', tags: ['A', 'b'], description: 'desc' });
  assert.deepEqual([updated.title, updated.tags, updated.description], ['Renamed', ['a', 'b'], 'desc']);
  assert.throws(() => store.update('mimi', 'g99', {}), /No picture/);

  assert.equal(store.readImage('mimi', item.id, true)!.mime, 'image/png', 'no preview yet: the picture itself');
  assert.throws(() => store.saveThumb('mimi', item.id, 'image/png', PNG), /JPEG/);
  store.saveThumb('mimi', item.id, 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal(store.get('mimi', item.id)!.thumb, true);
  assert.equal(store.readImage('mimi', item.id, true)!.mime, 'image/jpeg');
  assert.equal(store.readImage('mimi', item.id)!.mime, 'image/png');
  store.remove('mimi', item.id);
  assert.equal(store.readImage('mimi', item.id), undefined);
});

test('gallery tools: search, show, hide and add; the picture on show is the agent status', async () => {
  const target = await makeTestCore({});
  const { core } = target;
  const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [target.root] };
  const tool = (name: string) => core.tools.get(name)!;
  assert.deepEqual(['gallery_search', 'gallery_show', 'gallery_hide', 'gallery_add'].map((name) => Boolean(core.tools.get(name))), [true, true, true, true]);

  assert.match(await tool('gallery_search').execute({}, context), /gallery is empty/);
  const first = core.gallery.add('mimi', { title: 'Rainy cafe', tags: ['rain'], description: 'a quiet moment', mime: 'image/png', data: PNG, source: 'user' });
  assert.match(await tool('gallery_search').execute({ query: 'rain' }, context), /g1: Rainy cafe \[rain\] - a quiet moment/);
  assert.match(await tool('gallery_search').execute({ query: 'snow' }, context), /Nothing in your gallery matches/);

  await assert.rejects(tool('gallery_show').execute({ id: 'g9' }, context), /No picture "g9"/);
  await tool('gallery_show').execute({ id: first.id }, context);
  assert.equal(core.status.get('mimi').situation, 'g1');
  assert.match(core.deps.contextExtras!(core.agents.get('mimi')), /situation: g1 = Rainy cafe \(a quiet moment\)/);
  await tool('gallery_hide').execute({}, context);
  assert.equal(core.status.get('mimi').situation, undefined);

  // Adding: from a file in the allowed folder, or from a chat attachment; exactly one source.
  fs.writeFileSync(path.join(target.root, 'made.png'), PNG);
  const added = await tool('gallery_add').execute({ path: 'made.png', title: 'Made', tags: ['x'] }, context);
  assert.match(added, /Added to your gallery as g2/);
  const attachment = core.attachments.save({ name: 'pic.png', mime: 'image/png', data: PNG });
  assert.match(await tool('gallery_add').execute({ attachment_id: attachment.id, title: 'Chat pic' }, context), /as g3/);
  assert.equal(core.gallery.get('mimi', 'g3')!.source, 'agent');
  await assert.rejects(tool('gallery_add').execute({ title: 'none' }, context), /exactly one/);
  await assert.rejects(tool('gallery_add').execute({ path: '../outside.png', title: 'x' }, context), /./);
  fs.writeFileSync(path.join(target.root, 'note.txt'), 'hello');
  await assert.rejects(tool('gallery_add').execute({ path: 'note.txt', title: 'x' }, context), /PNG|image/i);

  // The agent cannot set `situation` through status_set; only the gallery tools and the user do.
  assert.equal(tool('status_set').inputSchema.safeParse({ key: 'situation', value: 'g1' }).success, false);
  assert.equal(tool('status_set').inputSchema.safeParse({ key: 'mood', value: 'happy' }).success, true);
  await target.cleanup();
});
