import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { z } from 'zod';
import { GoogleAuth, GoogleNotConfiguredError } from '../google/auth.ts';
import { buildRawEmail, createGoogleTools } from '../google/tools.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { createSkillTool, loadPersona, loadSkills, renderSkillIndex } from '../skills/skills.ts';
import { defineTool, type ToolDefinition, ToolRegistry } from '../tools/registry.ts';
import { FakeBroker } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-int-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const context = { traceId: 't', thread: 'main', agent: 'karlen', allowedDirs: [] };

function skillDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'skills-'));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.md`), source);
  }
  return dir;
}

test('skills: only name and description are indexed; load_skill returns the body', async () => {
  const dir = skillDir({
    'song-writer': '---\nname: song-writer\ndescription: Write lyrics\n---\n# Song Writer\nBODY-A',
    'night-quiz': '---\nname: night-quiz\ndescription: Bedtime quiz\n---\nBODY-B',
  });
  fs.writeFileSync(path.join(dir, 'not-a-skill.txt'), 'not markdown, ignored');
  fs.mkdirSync(path.join(dir, 'not-a-skill')); // folders are not skills either
  const skills = loadSkills(dir);

  assert.deepEqual(skills.map((skill) => [skill.name, skill.description]), [['night-quiz', 'Bedtime quiz'], ['song-writer', 'Write lyrics']]);
  const index = renderSkillIndex(skills);
  assert.match(index, /- night-quiz: Bedtime quiz\n- song-writer: Write lyrics/);
  assert.doesNotMatch(index, /BODY/);
  assert.equal(renderSkillIndex([]), '');

  const tool = createSkillTool(skills);
  assert.equal(tool.risk, 'read');
  assert.equal(await tool.execute({ name: 'song-writer' }, context), '# Song Writer\nBODY-A');
  fs.writeFileSync(path.join(dir, 'song-writer.md'), '---\nname: song-writer\ndescription: Write lyrics\n---\nEDITED');
  assert.equal(await tool.execute({ name: 'song-writer' }, context), 'EDITED', 'edits apply without a restart');
  await assert.rejects(tool.execute({ name: 'nope' }, context), /No skill "nope". Available: night-quiz, song-writer/);
});

test('skills: broken files fail loudly; a missing folder or persona is simply empty', () => {
  assert.throws(() => loadSkills(skillDir({ bad: 'no frontmatter' })), /invalid skill frontmatter/);
  assert.throws(() => loadSkills(skillDir({ renamed: '---\nname: other\ndescription: x\n---\nBody' })), /must match the file name/);
  assert.deepEqual(loadSkills(path.join(tmp, 'missing')), []);
  assert.equal(loadPersona(path.join(tmp, 'missing.md')), '');
});

test('an agent may not combine untrusted-content tools with a shell', () => {
  const make = (name: string, extra: Partial<ToolDefinition>) =>
    defineTool({
      name,
      description: name,
      risk: 'read',
      target: 'core',
      inputSchema: z.object({}),
      summarize: () => name,
      execute: async () => '',
      ...extra,
    } as ToolDefinition<{}>);
  const registry = new ToolRegistry().register(
    make('web_fetch', { untrustedInput: true }),
    make('run_shell', { risk: 'shell' }),
    make('read_memory', {}),
  );

  assert.throws(() => registry.select(['web_fetch', 'run_shell']), /cannot have both "web_fetch".*and "run_shell"/);
  assert.equal(registry.select(['web_fetch', 'read_memory']).length, 2);
  assert.equal(registry.select(['run_shell', 'read_memory']).length, 2);
});

test('permission settings override the risk policy per tool', async () => {
  const broker = new FakeBroker(true);
  const gate = new PermissionGate(broker, { overrides: { create_trigger: 'allow', run_shell: 'deny', read_file: 'ask' } });
  assert.equal(gate.modeFor('create_trigger', 'write'), 'auto');
  assert.equal(gate.modeFor('run_shell', 'shell'), 'deny');
  assert.equal(gate.modeFor('read_file', 'read'), 'ask');
  assert.equal(gate.modeFor('write_file', 'write'), 'ask');

  const ask = (tool: string, risk: 'write' | 'shell') =>
    gate.decide(gate.createRequest({ traceId: 't', agent: 'mimi', tool, risk, input: {}, summary: '' }));
  assert.deepEqual(await ask('create_trigger', 'write'), { allow: true, via: 'auto' });
  assert.deepEqual(await ask('run_shell', 'shell'), { allow: false, reason: 'denied' });
  assert.equal(broker.requests.length, 0, 'neither allow nor deny reaches the user');
});

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  authorization: string | null;
}

/** A fake Google: token endpoint plus canned API responses keyed by URL fragment. */
function fakeGoogle(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : (init?.body as string | undefined);
    calls.push({ url, method: init?.method ?? 'GET', body, authorization: headers.get('authorization') });
    if (url.includes('oauth2.googleapis.com/token')) {
      return Response.json({ access_token: `access-${calls.filter((call) => call.url.includes('/token')).length}`, expires_in: 3600 });
    }
    const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!match) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    return Response.json(match[1]);
  }) as typeof fetch;
  let now = 1_000_000;
  const auth = new GoogleAuth({
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    tokenFile: path.join(tmp, 'none.json'),
    fetchFn,
    now: () => now,
  });
  const tools = Object.fromEntries(
    createGoogleTools(auth, 'Asia/Bangkok').map((tool) => [tool.name, tool]),
  ) as Record<string, ToolDefinition<any>>;
  return { auth, tools, calls, api: () => calls.filter((call) => !call.url.includes('/token')), advance: (ms: number) => (now += ms) };
}

test('google auth: clear guidance when not connected; tokens are refreshed and cached', async () => {
  const none = new GoogleAuth({ clientId: undefined, clientSecret: undefined, refreshToken: undefined, tokenFile: path.join(tmp, 'none.json') });
  assert.equal(none.isConfigured, false);
  await assert.rejects(none.accessToken(), GoogleNotConfiguredError);
  await assert.rejects(none.accessToken(), /npm run google-auth/);

  const tokenFile = path.join(tmp, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'from-file' }));
  assert.equal(new GoogleAuth({ clientId: 'id', clientSecret: 's', refreshToken: undefined, tokenFile }).isConfigured, true);

  const google = fakeGoogle({});
  assert.equal(await google.auth.accessToken(), 'access-1');
  assert.equal(await google.auth.accessToken(), 'access-1', 'cached while valid');
  google.advance(3600_000);
  assert.equal(await google.auth.accessToken(), 'access-2', 'refreshed after expiry');
  assert.match(google.calls[0]!.body!, /grant_type=refresh_token/);
  assert.match(google.calls[0]!.body!, /refresh_token=refresh/);
  await assert.rejects(google.auth.request('https://example.test/missing'), /Google API error 404: Not Found/);
});

test('gmail tools: search, read, send', async () => {
  const body = Buffer.from('สวัสดีครับ นัดประชุมวันศุกร์', 'utf8').toString('base64url');
  const google = fakeGoogle({
    '/messages?q=': { messages: [{ id: 'm1' }] },
    '/messages/m1?format=metadata': {
      id: 'm1',
      snippet: 'นัดประชุม…',
      payload: { headers: [{ name: 'From', value: 'boss@example.com' }, { name: 'Subject', value: 'ประชุม' }, { name: 'Date', value: 'Mon, 12 Oct 2026' }] },
    },
    '/messages/m1?format=full': {
      id: 'm1',
      payload: {
        headers: [{ name: 'From', value: 'boss@example.com' }, { name: 'Subject', value: 'ประชุม' }],
        parts: [{ mimeType: 'text/html', body: { data: 'PGI-' } }, { mimeType: 'text/plain', body: { data: body } }],
      },
    },
    '/messages/send': { id: 'sent-1' },
  });
  const { tools } = google;
  assert.deepEqual(
    ['gmail_search', 'gmail_read', 'gmail_send', 'calendar_list', 'calendar_create'].map((name) => [tools[name]!.risk, tools[name]!.untrustedInput ?? false]),
    [['read', true], ['read', true], ['network', false], ['read', true], ['write', false]],
  );

  const found = await tools.gmail_search!.execute({ query: 'is:unread from:boss' }, context);
  assert.match(found, /\[id m1\] Mon, 12 Oct 2026\nFrom: boss@example.com\nSubject: ประชุม\nนัดประชุม…/);
  assert.match(google.api()[0]!.url, /q=is%3Aunread%20from%3Aboss&maxResults=10/);
  assert.equal(google.api()[0]!.authorization, 'Bearer access-1');

  assert.match(await tools.gmail_read!.execute({ id: 'm1' }, context), /Subject: ประชุม\n\nสวัสดีครับ นัดประชุมวันศุกร์/);

  assert.equal(await tools.gmail_send!.execute({ to: 'a@example.com', subject: 'ตอบกลับ', body: 'รับทราบครับ' }, context), 'Sent to a@example.com (message id sent-1).');
  const sent = google.api().at(-1)!;
  assert.equal(sent.method, 'POST');
  const raw = Buffer.from((JSON.parse(sent.body!) as { raw: string }).raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: a@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1]!, 'base64').toString('utf8'), 'รับทราบครับ');
  assert.match(Buffer.from(buildRawEmail({ to: 'x@y.z', subject: 'plain ascii', body: 'b' }), 'base64url').toString(), /Subject: plain ascii/);
});

test('calendar tools: list a range, create an event in the core time zone', async () => {
  const event = { id: 'e1', summary: 'หมอฟัน', location: 'คลินิก', start: { dateTime: '2026-10-20T10:00:00+07:00' }, end: { dateTime: '2026-10-20T11:00:00+07:00' }, htmlLink: 'https://calendar.example/e1' };
  const google = fakeGoogle({ '/events': { ...event, items: [event] } });
  const { tools } = google;

  const listed = await tools.calendar_list!.execute({ from: '2026-10-20T00:00:00+07:00', to: '2026-10-21T00:00:00+07:00' }, context);
  assert.equal(listed, '2026-10-20T10:00:00+07:00 -> 2026-10-20T11:00:00+07:00 | หมอฟัน @ คลินิก [id e1]');
  const query = new URL(google.api()[0]!.url).searchParams;
  assert.deepEqual(
    { min: query.get('timeMin'), max: query.get('timeMax'), single: query.get('singleEvents'), order: query.get('orderBy') },
    { min: '2026-10-19T17:00:00.000Z', max: '2026-10-20T17:00:00.000Z', single: 'true', order: 'startTime' },
  );

  const created = await tools.calendar_create!.execute(
    { summary: 'หมอฟัน', start: '2026-10-20T10:00:00+07:00', end: '2026-10-20T11:00:00+07:00', location: 'คลินิก' },
    context,
  );
  assert.match(created, /^Created: 2026-10-20T10:00:00\+07:00 .*หมอฟัน @ คลินิก \[id e1\]\nhttps:\/\/calendar\.example\/e1$/);
  assert.deepEqual(JSON.parse(google.api().at(-1)!.body!), {
    summary: 'หมอฟัน',
    location: 'คลินิก',
    start: { dateTime: '2026-10-20T10:00:00+07:00', timeZone: 'Asia/Bangkok' },
    end: { dateTime: '2026-10-20T11:00:00+07:00', timeZone: 'Asia/Bangkok' },
  });
});
