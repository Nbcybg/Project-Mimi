import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { SecretStore } from '../app/secrets.ts';
import { OAuthAccounts } from '../oauth/accounts.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-oauth-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const store = (name: string) => new SecretStore(path.join(tmp, `${name}-secrets.json`));

test('oauth accounts: the old env credentials become one default, connected account', () => {
  const dir = path.join(tmp, 'migrate');
  const legacy = path.join(tmp, 'google-token.json');
  fs.writeFileSync(legacy, JSON.stringify({ refresh_token: 'legacy-refresh' }));
  const oauth = new OAuthAccounts({
    dir,
    secrets: store('migrate'),
    env: { GOOGLE_OAUTH_CLIENT_ID: 'client-1', GOOGLE_OAUTH_CLIENT_SECRET: 'secret-1' } as NodeJS.ProcessEnv,
    legacyTokenFiles: { google: legacy },
  });
  const [account] = oauth.views();
  assert.equal(account!.id, 'google-default');
  assert.equal(account!.name, 'Google (เดิม)');
  assert.equal(account!.default, true);
  assert.equal(account!.connected, true);
  assert.equal(account!.hasSecret, true);
  assert.equal(account!.clientId, 'client-1');
  assert.equal(oauth.google().isConfigured, true);
  assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'google-default.json'), 'utf8')), {
    refresh_token: 'legacy-refresh',
  });
});

test('oauth accounts: add, choose default, keep tokens apart and remove', () => {
  const dir = path.join(tmp, 'multi');
  const secrets = store('multi');
  const oauth = new OAuthAccounts({ dir, secrets, env: {} as NodeJS.ProcessEnv });

  const first = oauth.save({ service: 'google', name: 'งาน', clientId: 'id-a', clientSecret: 'sec-a' });
  assert.equal(first.default, true);
  assert.equal(first.connected, false);
  assert.equal(secrets.get(`oauth.${first.id}.client_secret`), 'sec-a');
  fs.writeFileSync(path.join(dir, `${first.id}.json`), JSON.stringify({ refresh_token: 'rt-a' }));

  const second = oauth.save({ service: 'google', name: 'ส่วนตัว', clientId: 'id-b', clientSecret: 'sec-b' });
  assert.equal(second.default, false);
  assert.equal(oauth.view(first.id).connected, true);
  assert.equal(oauth.view(second.id).connected, false);
  assert.equal(oauth.google(first.id).hasClient, true);
  assert.equal(oauth.google(second.id).hasClient, true);
  assert.equal(oauth.google().hasClient, true);

  oauth.setDefault(second.id);
  assert.equal(oauth.view(second.id).default, true);
  assert.equal(oauth.view(first.id).default, false);

  oauth.remove(first.id);
  assert.equal(secrets.has(`oauth.${first.id}.client_secret`), false);
  assert.equal(fs.existsSync(path.join(dir, `${first.id}.json`)), false);
  assert.equal(oauth.defaultAccount('google')?.id, second.id);
  assert.throws(() => oauth.google(first.id), /No OAuth account/);
});

test('oauth accounts: a Google account needs a secret; Microsoft keeps its tenant', () => {
  const dir = path.join(tmp, 'ms');
  const secrets = store('ms');
  const oauth = new OAuthAccounts({ dir, secrets, env: {} as NodeJS.ProcessEnv });
  assert.throws(() => oauth.save({ service: 'google', name: 'ไม่มี secret', clientId: 'id' }), /Client secret/);

  const account = oauth.save({ service: 'microsoft', name: 'ที่ทำงาน', clientId: 'ms-id', tenant: 'contoso' });
  assert.equal(account.tenant, 'contoso');
  assert.equal(account.hasSecret, false);
  assert.equal(account.default, true);
  fs.writeFileSync(path.join(dir, `${account.id}.json`), JSON.stringify({ refresh_token: 'ms-rt' }));
  assert.equal(oauth.microsoft().isConfigured, true);
  assert.equal(oauth.microsoft(account.id).hasClient, true);
  assert.throws(() => oauth.google(account.id), /Microsoft account, not Google/);
});

test('oauth accounts: editing keeps the stored secret when the field is left empty', () => {
  const dir = path.join(tmp, 'edit');
  const secrets = store('edit');
  const oauth = new OAuthAccounts({ dir, secrets, env: {} as NodeJS.ProcessEnv });
  const first = oauth.save({ service: 'google', name: 'งาน', clientId: 'id-a', clientSecret: 'sec-a' });
  const edited = oauth.save({ service: 'google', name: 'งานใหม่', clientId: 'id-b' }, first.id);
  assert.equal(edited.name, 'งานใหม่');
  assert.equal(edited.clientId, 'id-b');
  assert.equal(secrets.get(`oauth.${first.id}.client_secret`), 'sec-a');
});

test('oauth accounts: keys entered later in Settings still reach their legacy account', () => {
  const dir = path.join(tmp, 'later');
  const secrets = store('later');
  const oauth = new OAuthAccounts({ dir, secrets, env: {} as NodeJS.ProcessEnv });
  assert.equal(oauth.views().length, 0);

  oauth.syncLegacyEnv({
    GOOGLE_OAUTH_CLIENT_ID: 'late-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'late-secret',
  } as NodeJS.ProcessEnv);
  const account = oauth.defaultAccount('google');
  assert.equal(account?.id, 'google-default');
  assert.equal(account?.clientId, 'late-id');
  assert.equal(secrets.get('oauth.google-default.client_secret'), 'late-secret');

  oauth.syncLegacyEnv({ GOOGLE_OAUTH_CLIENT_ID: 'newer-id' } as NodeJS.ProcessEnv);
  assert.equal(oauth.defaultAccount('google')?.clientId, 'newer-id');
});
