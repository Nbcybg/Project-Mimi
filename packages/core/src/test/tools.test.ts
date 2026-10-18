import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MicrosoftAuth } from '../microsoft/auth.ts';
import { createMicrosoftTools } from '../microsoft/tools.ts';
import { type ToolDefinition, ToolRegistry } from '../tools/registry.ts';
import { createWebTools } from '../tools/web-tools.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-tools-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const context = { traceId: 't', thread: 'main', agent: 'mimi', allowedDirs: [] };

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
}
type Route = unknown | ((call: Call) => unknown);

/** A fake HTTP service: canned JSON keyed by URL fragment; the first matching route answers. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : (init?.body as string | undefined);
    const call = { url: String(input), method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) };
    calls.push(call);
    const match = Object.entries(routes).find(([fragment]) => call.url.includes(fragment));
    if (!match) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    const answer = typeof match[1] === 'function' ? (match[1] as (call: Call) => unknown)(call) : match[1];
    return answer === null ? new Response(null, { status: 204 }) : Response.json(answer);
  }) as typeof fetch;
  return { fetchFn, calls };
}
const byName = (tools: ToolDefinition<any>[]) =>
  Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<string, ToolDefinition<any>>;

test('web tools: search, places and weather, each behind its own key', async () => {
  const keys: Record<string, string> = { SERPER_API_KEY: 'serper-key' };
  const web = fakeFetch({
    'serper.dev/search': {
      answerBox: { answer: '35 บาท' },
      knowledgeGraph: { title: 'เงินบาท', type: 'สกุลเงิน' },
      organic: [
        { title: 'อัตราแลกเปลี่ยนวันนี้', link: 'https://example.com/fx', snippet: 'ดอลลาร์อยู่ที่ 35 บาท', date: '13 ต.ค.' },
        { title: 'ข่าวค่าเงิน', link: 'https://example.com/news', snippet: 'บาทแข็งค่า' },
      ],
    },
    'serper.dev/maps': {
      places: [{ title: 'ร้านกาแฟ A', address: 'ซอยอารีย์ 1', rating: 4.6, ratingCount: 120, latitude: 13.78, longitude: 100.54 }],
    },
    'data/2.5/weather': { name: 'Bangkok', sys: { country: 'TH' }, main: { temp: 31.4, feels_like: 36, humidity: 70 }, weather: [{ description: 'ฝนฟ้าคะนอง' }], wind: { speed: 2.1 } },
    'data/2.5/forecast': {
      list: [
        { dt_txt: '2026-10-13 03:00:00', main: { temp: 30 }, weather: [{ description: 'เมฆมาก' }], pop: 0.2 },
        { dt_txt: '2026-10-13 06:00:00', main: { temp: 33 }, weather: [{ description: 'ฝนตก' }], pop: 0.8 },
      ],
    },
  });
  const tools = byName(createWebTools({ key: (name) => keys[name], fetchFn: web.fetchFn }));

  const found = await tools.web_search!.execute({ query: 'ค่าเงินบาทวันนี้' }, context);
  assert.match(found, /^Answer: 35 บาท\nเงินบาท \(สกุลเงิน\)\n1\. อัตราแลกเปลี่ยนวันนี้ \(13 ต\.ค\.\)\n {3}https:\/\/example\.com\/fx\n {3}ดอลลาร์อยู่ที่ 35 บาท\n2\. ข่าวค่าเงิน/);
  assert.equal(web.calls[0]!.headers.get('x-api-key'), 'serper-key');
  assert.deepEqual(JSON.parse(web.calls[0]!.body!), { q: 'ค่าเงินบาทวันนี้', gl: 'th', hl: 'th', num: 5 });

  const places = await tools.map_search!.execute({ query: 'ร้านกาแฟ อารีย์', max_results: 3 }, context);
  assert.equal(places, '1. ร้านกาแฟ A · 4.6★ (120)\n   ซอยอารีย์ 1\n   https://www.google.com/maps?q=13.78,100.54');

  // Each service has its own key; a missing one says where to put it.
  await assert.rejects(tools.weather!.execute({ city: 'Bangkok' }, context), /Weather is not set up: add the OpenWeatherMap API key/);
  keys.OPENWEATHER_API_KEY = 'owm-key';
  const weather = await tools.weather!.execute({ city: 'Bangkok' }, context);
  assert.equal(
    weather,
    'Bangkok, TH now: 31°C, ฝนฟ้าคะนอง, feels like 36°C, humidity 70%, wind 2.1 m/s\n2026-10-13 06:00 UTC: 33°C, ฝนตก, rain chance 80%',
  );
  assert.match(web.calls.at(-1)!.url, /forecast\?q=Bangkok&units=metric&lang=th&appid=owm-key&cnt=8$/);
  assert.equal((await tools.weather!.execute({ city: 'Bangkok', days: 0 }, context)).split('\n').length, 1);

  delete keys.SERPER_API_KEY;
  await assert.rejects(tools.web_search!.execute({ query: 'x' }, context), /Web search is not set up/);

  // What the web says is untrusted: it may not sit next to a shell in one agent.
  for (const tool of Object.values(tools)) assert.deepEqual([tool.risk, tool.untrustedInput], ['read', true], tool.name);
});

function fakeMicrosoft(routes: Record<string, Route>, tokenFile = path.join(tmp, `ms-${Math.random().toString(36).slice(2)}.json`)) {
  fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'refresh-1' }));
  let issued = 0;
  const web = fakeFetch({
    'oauth2/v2.0/token': () => ({ access_token: `access-${++issued}`, refresh_token: `refresh-${issued + 1}`, expires_in: 3600 }),
    ...routes,
  });
  let now = 1_000_000;
  const auth = new MicrosoftAuth({
    credentials: () => ({ clientId: 'client-id', tenant: 'common' }),
    tokenFile,
    fetchFn: web.fetchFn,
    now: () => now,
  });
  return {
    auth,
    tokenFile,
    tools: byName(createMicrosoftTools(auth, 'Asia/Bangkok')),
    calls: web.calls,
    graph: () => web.calls.filter((call) => call.url.includes('graph.microsoft.com')),
    advance: (ms: number) => (now += ms),
  };
}

test('microsoft auth: public client; the rotated refresh token is kept; clear guidance when not connected', async () => {
  const missing = new MicrosoftAuth({ credentials: () => ({ clientId: undefined, tenant: 'common' }), tokenFile: path.join(tmp, 'none.json') });
  assert.deepEqual([missing.hasClient, missing.isConfigured], [false, false]);
  await assert.rejects(missing.accessToken(), /Microsoft is not connected \(no client ID\)/);
  const signedOut = new MicrosoftAuth({ credentials: () => ({ clientId: 'x', tenant: 'common' }), tokenFile: path.join(tmp, 'none.json') });
  await assert.rejects(signedOut.accessToken(), /not signed in/);

  const microsoft = fakeMicrosoft({});
  assert.equal(microsoft.auth.isConfigured, true);
  assert.equal(await microsoft.auth.accessToken(), 'access-1');
  assert.equal(await microsoft.auth.accessToken(), 'access-1', 'cached while valid');
  const refresh = microsoft.calls[0]!;
  assert.match(refresh.url, /login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/);
  assert.match(refresh.body!, /client_id=client-id&refresh_token=refresh-1&grant_type=refresh_token/);
  assert.doesNotMatch(refresh.body!, /client_secret/);
  assert.equal(JSON.parse(fs.readFileSync(microsoft.tokenFile, 'utf8')).refresh_token, 'refresh-2', 'Microsoft replaces the refresh token');

  microsoft.advance(3_600_000);
  assert.equal(await microsoft.auth.accessToken(), 'access-2');
  assert.match(microsoft.calls.at(-1)!.body!, /refresh_token=refresh-2/);
  await assert.rejects(microsoft.auth.request('/me/nothing'), /Microsoft Graph error 404: Not Found/);
});

test('outlook mail: list, search, read, send and reply', async () => {
  const message = {
    id: 'AAA=',
    subject: 'ใบแจ้งหนี้เดือนตุลาคม',
    from: { emailAddress: { name: 'การเงิน', address: 'billing@example.com' } },
    toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
    receivedDateTime: '2026-10-12T02:00:00Z',
    bodyPreview: 'ยอดชำระ 1,250 บาท',
    body: { content: 'ยอดชำระ 1,250 บาท ภายในวันที่ 20' },
    hasAttachments: true,
    isRead: false,
  };
  const microsoft = fakeMicrosoft({
    '/me/mailFolders/inbox/messages': { value: [message] },
    '/me/messages?': { value: [] },
    '/me/messages/AAA%3D/reply': null,
    '/me/messages/AAA%3D': message,
    '/me/sendMail': null,
  });
  const { tools } = microsoft;

  const inbox = await tools.outlook_search!.execute({ unread_only: true }, context);
  assert.equal(inbox, '[id AAA=] 2026-10-12T02:00:00Z [unread] [attachment]\nFrom: การเงิน <billing@example.com>\nSubject: ใบแจ้งหนี้เดือนตุลาคม\nยอดชำระ 1,250 บาท');
  assert.match(decodeURIComponent(microsoft.graph()[0]!.url), /inbox\/messages\?\$orderby=receivedDateTime desc&\$top=10&.*&\$filter=isRead eq false$/);
  assert.equal(microsoft.graph()[0]!.headers.get('authorization'), 'Bearer access-1');

  assert.equal(await tools.outlook_search!.execute({ query: 'from:"bank" invoice' }, context), 'No messages match.');
  assert.match(decodeURIComponent(microsoft.graph()[1]!.url), /\/me\/messages\?\$search="from:bank invoice"&\$top=10/);

  const read = await tools.outlook_read!.execute({ id: 'AAA=' }, context);
  assert.match(read, /^From: การเงิน <billing@example\.com>\nTo: <me@example\.com>\nDate: .*\nSubject: ใบแจ้งหนี้เดือนตุลาคม\n\(has attachments\)\n\nยอดชำระ 1,250 บาท ภายในวันที่ 20$/);
  assert.equal(microsoft.graph()[2]!.headers.get('prefer'), 'outlook.body-content-type="text"');

  assert.equal(await tools.outlook_send!.execute({ to: 'a@example.com, b@example.com', subject: 'สวัสดี', body: 'ทดสอบ', cc: 'c@example.com' }, context), 'Sent to a@example.com, b@example.com.');
  const sent = microsoft.graph()[3]!;
  assert.deepEqual([sent.method, sent.url.endsWith('/me/sendMail')], ['POST', true]);
  assert.deepEqual(JSON.parse(sent.body!), {
    message: {
      subject: 'สวัสดี',
      body: { contentType: 'Text', content: 'ทดสอบ' },
      toRecipients: [{ emailAddress: { address: 'a@example.com' } }, { emailAddress: { address: 'b@example.com' } }],
      ccRecipients: [{ emailAddress: { address: 'c@example.com' } }],
    },
    saveToSentItems: true,
  });

  assert.equal(await tools.outlook_reply!.execute({ id: 'AAA=', body: 'รับทราบครับ' }, context), 'Reply sent.');
  assert.deepEqual(JSON.parse(microsoft.graph()[4]!.body!), { comment: 'รับทราบครับ' });

  // Reading mail is untrusted input; sending leaves the machine and asks first.
  assert.deepEqual([tools.outlook_search!.untrustedInput, tools.outlook_read!.untrustedInput], [true, true]);
  assert.deepEqual([tools.outlook_send!.risk, tools.outlook_reply!.risk], ['network', 'network']);
  const shell = { ...tools.outlook_send!, name: 'sh', risk: 'shell' as const };
  assert.throws(() => new ToolRegistry().register(tools.outlook_read!, shell).select(['outlook_read', 'sh']), /cannot have both/);
});

test('outlook calendar: list, create, update and delete in the user\'s time zone', async () => {
  const event = { id: 'E1', subject: 'ประชุมทีม', start: { dateTime: '2026-10-13T14:00:00.0000000' }, end: { dateTime: '2026-10-13T15:00:00.0000000' }, location: { displayName: 'ห้อง 3' } };
  const microsoft = fakeMicrosoft({
    '/me/calendarView': { value: [event] },
    '/me/events/E1': (call: Call) => (call.method === 'DELETE' ? null : { ...event, subject: 'ประชุมทีม (เลื่อน)' }),
    '/me/events': event,
  });
  const { tools } = microsoft;

  assert.equal(
    await tools.outlook_calendar_list!.execute({ from: '2026-10-13T00:00:00', to: '2026-10-14T00:00:00' }, context),
    '2026-10-13T14:00 -> 2026-10-13T15:00 | ประชุมทีม @ ห้อง 3 [id E1]',
  );
  assert.equal(microsoft.graph()[0]!.headers.get('prefer'), 'outlook.timezone="Asia/Bangkok"');
  assert.match(decodeURIComponent(microsoft.graph()[0]!.url), /calendarView\?startDateTime=2026-10-13T00:00:00&endDateTime=2026-10-14T00:00:00&\$orderby=start\/dateTime&\$top=20/);

  await tools.outlook_calendar_create!.execute(
    { title: 'ประชุมทีม', start: '2026-10-13T14:00:00+07:00', end: '2026-10-13T15:00:00', location: 'ห้อง 3', attendees: 'a@example.com' },
    context,
  );
  assert.deepEqual(JSON.parse(microsoft.graph()[1]!.body!), {
    subject: 'ประชุมทีม',
    start: { dateTime: '2026-10-13T14:00:00', timeZone: 'Asia/Bangkok' },
    end: { dateTime: '2026-10-13T15:00:00', timeZone: 'Asia/Bangkok' },
    location: { displayName: 'ห้อง 3' },
    attendees: [{ emailAddress: { address: 'a@example.com' }, type: 'required' }],
  });

  assert.match(await tools.outlook_calendar_update!.execute({ id: 'E1', title: 'ประชุมทีม (เลื่อน)' }, context), /^Updated: .*ประชุมทีม \(เลื่อน\)/);
  assert.deepEqual([microsoft.graph()[2]!.method, JSON.parse(microsoft.graph()[2]!.body!)], ['PATCH', { subject: 'ประชุมทีม (เลื่อน)' }]);
  await assert.rejects(tools.outlook_calendar_update!.execute({ id: 'E1' }, context), /Nothing to change/);

  assert.equal(await tools.outlook_calendar_delete!.execute({ id: 'E1', title: 'ประชุมทีม' }, context), 'Event deleted.');
  assert.equal(microsoft.graph().at(-1)!.method, 'DELETE');
  assert.deepEqual(
    [tools.outlook_calendar_create!.risk, tools.outlook_calendar_update!.risk, tools.outlook_calendar_delete!.risk],
    ['write', 'write', 'delete'],
  );
});

test('microsoft to do: the default list is used unless one is named', async () => {
  const task = { id: 'T1', title: 'ซื้อนม', status: 'notStarted', dueDateTime: { dateTime: '2026-10-15T00:00:00.0000000' } };
  const microsoft = fakeMicrosoft({
    '/me/todo/lists/L1/tasks/T1': (call: Call) => (call.method === 'DELETE' ? null : { ...task, status: 'completed' }),
    '/me/todo/lists/L1/tasks': (call: Call) => (call.method === 'POST' ? task : { value: [task] }),
    '/me/todo/lists/L9/tasks': { value: [] },
    '/me/todo/lists': { value: [{ id: 'L0', displayName: 'งาน' }, { id: 'L1', displayName: 'Tasks', wellknownListName: 'defaultList' }] },
  });
  const { tools } = microsoft;

  assert.equal(await tools.todo_lists!.execute({}, context), 'งาน [id L0]\nTasks (default) [id L1]');
  assert.equal(await tools.todo_tasks!.execute({}, context), '[ ] ซื้อนม (due 2026-10-15) [id T1]');
  assert.match(decodeURIComponent(microsoft.graph().at(-1)!.url), /lists\/L1\/tasks\?\$top=50&\$filter=status ne 'completed'$/);
  assert.equal(await tools.todo_tasks!.execute({ list_id: 'L9', include_completed: true }, context), 'No tasks.');

  assert.equal(await tools.todo_create!.execute({ title: 'ซื้อนม', due: '2026-10-15', note: '2 ขวด' }, context), 'Added: [ ] ซื้อนม (due 2026-10-15) [id T1]');
  assert.deepEqual(JSON.parse(microsoft.graph().at(-1)!.body!), {
    title: 'ซื้อนม',
    dueDateTime: { dateTime: '2026-10-15T00:00:00', timeZone: 'Asia/Bangkok' },
    body: { content: '2 ขวด', contentType: 'text' },
  });

  assert.equal(await tools.todo_update!.execute({ task_id: 'T1', completed: true }, context), 'Updated: [x] ซื้อนม (due 2026-10-15) [id T1]');
  assert.deepEqual(JSON.parse(microsoft.graph().at(-1)!.body!), { status: 'completed' });
  assert.equal(await tools.todo_delete!.execute({ task_id: 'T1' }, context), 'Task deleted.');
  assert.deepEqual([tools.todo_create!.risk, tools.todo_delete!.risk, tools.todo_tasks!.risk], ['write', 'delete', 'read']);
});
