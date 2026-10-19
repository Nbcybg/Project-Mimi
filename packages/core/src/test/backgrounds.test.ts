import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { BackgroundStore } from '../backgrounds/background-store.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-bg-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('background store: folders, ids, keywords and pictures', () => {
  const store = new BackgroundStore(path.join(tmp, 'a'));
  assert.deepEqual(store.list(), []);
  const saved = store.save({ id: 'cafe', name: ' คาเฟ่ ', keywords: ['คาเฟ่', ' ร้านกาแฟ ', 'คาเฟ่', ''] });
  assert.deepEqual(saved, { id: 'cafe', name: 'คาเฟ่', keywords: ['คาเฟ่', 'ร้านกาแฟ'], image: null });
  assert.throws(() => store.save({ id: 'Bad Id' }), /lowercase/);
  assert.throws(() => store.save({ id: 'auto' }), /reserved/);
  assert.throws(() => store.saveImage('nope', 'image/png', PNG), /No background/);
  assert.throws(() => store.saveImage('cafe', 'text/html', PNG), /PNG/);
  store.saveImage('cafe', 'image/png', PNG);
  assert.equal(store.readImage('cafe')!.mime, 'image/png');
  assert.ok(store.list()[0]!.image);
  store.removeImage('cafe');
  assert.equal(store.list()[0]!.image, null);
});

test('background store: choices are checked and follow renames and deletes', () => {
  const store = new BackgroundStore(path.join(tmp, 'b'));
  assert.deepEqual(store.settings(), { default: '', agents: {} });
  store.save({ id: 'cafe', name: 'Cafe' });
  store.save({ id: 'office', name: 'Office' });
  assert.throws(() => store.select(undefined, 'ghost'), /No background/);
  store.select(undefined, 'auto');
  store.select('mimi', 'cafe');
  store.select('tim', 'none');
  assert.deepEqual(store.settings(), { default: 'auto', agents: { mimi: 'cafe', tim: 'none' } });

  store.rename('cafe', 'coffee');
  assert.equal(store.settings().agents.mimi, 'coffee');
  assert.throws(() => store.rename('coffee', 'office'), /already exists/);

  store.select('mimi', '');
  assert.deepEqual(store.settings().agents, { tim: 'none' }, 'an empty choice follows the app-wide one');
  store.select('tim', 'office');
  store.renameAgent('tim', 'tim2');
  assert.deepEqual(store.settings().agents, { tim2: 'office' });
  store.remove('office');
  assert.deepEqual(store.settings(), { default: 'auto', agents: {} }, 'deleting clears the choices that used it');
  store.select('mimi', 'none');
  store.forgetAgent('mimi');
  assert.deepEqual(store.settings().agents, {});
});
