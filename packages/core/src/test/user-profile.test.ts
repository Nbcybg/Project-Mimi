import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { UserProfileStore } from '../profile/user-profile.ts';
import { makeTestCore } from './core-helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-profile-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const AGENTS = ['mimi', 'tim', 'karen'];

test('profile store: saves key/value fields, checks keys and agents, empty rows go', () => {
  const store = new UserProfileStore(path.join(tmp, 'a', 'profile.json'));
  assert.deepEqual(store.get(), { fields: [] });
  const saved = store.save(
    {
      fields: [
        { key: 'nickname', label: 'ชื่อเล่น', value: ' ต้น ', visibleTo: '*' },
        { key: 'bank_account', label: 'บัญชี', value: 'กสิกร 123-4-56789-0', visibleTo: ['karen', 'karen'] },
        { key: '', label: '', value: '', visibleTo: '*' },
      ],
    },
    AGENTS,
  );
  assert.deepEqual(saved.fields, [
    { key: 'nickname', label: 'ชื่อเล่น', value: 'ต้น', visibleTo: '*' },
    { key: 'bank_account', label: 'บัญชี', value: 'กสิกร 123-4-56789-0', visibleTo: ['karen'] },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'a', 'profile.json'), 'utf8')), saved);
  assert.throws(() => store.save({ fields: [{ key: 'Bad Key', label: '', value: 'x', visibleTo: '*' }] }, AGENTS), /lowercase/);
  assert.throws(
    () => store.save({ fields: [{ key: 'a', label: '', value: '1', visibleTo: '*' }, { key: 'a', label: '', value: '2', visibleTo: '*' }] }, AGENTS),
    /used twice/,
  );
  assert.throws(() => store.save({ fields: [{ key: 'a', label: '', value: '1', visibleTo: ['ghost'] }] }, AGENTS), /no agent named ghost/);
});

test('profile store: each agent sees only what is shared with it; renames and deletes follow', () => {
  const store = new UserProfileStore(path.join(tmp, 'b', 'profile.json'));
  store.save(
    {
      fields: [
        { key: 'nickname', label: 'ชื่อเล่น', value: 'ต้น', visibleTo: '*' },
        { key: 'home_address', label: 'ที่อยู่บ้าน', value: '99 ถ.สุขุมวิท\nกรุงเทพฯ', visibleTo: ['mimi', 'tim'] },
        { key: 'bank_account', label: 'บัญชี', value: '123-4', visibleTo: ['karen'] },
        { key: 'secret_note', label: 'บันทึกส่วนตัว', value: 'ไม่ให้ใครเห็น', visibleTo: [] },
        { key: 'empty', label: 'ว่าง', value: '', visibleTo: '*' },
      ],
    },
    AGENTS,
  );
  const mimi = store.render('mimi');
  assert.match(mimi, /^<user_profile>/);
  assert.match(mimi, /- ชื่อเล่น \(nickname\): ต้น/);
  assert.match(mimi, /- ที่อยู่บ้าน \(home_address\): 99 ถ\.สุขุมวิท \/ กรุงเทพฯ/);
  assert.doesNotMatch(mimi, /123-4|ไม่ให้ใครเห็น|empty/);
  const karen = store.render('karen');
  assert.match(karen, /bank_account/);
  assert.doesNotMatch(karen, /home_address/);
  assert.equal(store.render('nobody').includes('nickname'), true, 'a field for everyone reaches new agents too');

  store.renameAgent('karen', 'karen2');
  assert.deepEqual(store.get().fields.find((field) => field.key === 'bank_account')!.visibleTo, ['karen2']);
  store.forgetAgent('tim');
  assert.deepEqual(store.get().fields.find((field) => field.key === 'home_address')!.visibleTo, ['mimi']);
  assert.equal(new UserProfileStore(path.join(tmp, 'none.json')).render('mimi'), '');
});

test('core: the profile block lands in the agent prompt, per agent', async () => {
  const target = await makeTestCore({});
  const names = target.core.agents.names();
  target.core.profile.save(
    {
      fields: [
        { key: 'nickname', label: 'ชื่อเล่น', value: 'ต้น', visibleTo: '*' },
        { key: 'salary', label: 'เงินเดือน', value: '50,000', visibleTo: [names[0]!] },
      ],
    },
    names,
  );
  const extras = (name: string) => target.core.deps.promptExtras!(target.core.agents.get(name));
  assert.match(extras(names[0]!), /เงินเดือน \(salary\): 50,000/);
  assert.match(extras(names[1]!), /ชื่อเล่น \(nickname\): ต้น/);
  assert.doesNotMatch(extras(names[1]!), /salary/);
  // A broken file does not stop the agents.
  fs.writeFileSync(path.join(target.root, 'user', 'profile.json'), '{ not json');
  assert.doesNotMatch(extras(names[0]!), /user_profile/);
  await target.cleanup();
});
