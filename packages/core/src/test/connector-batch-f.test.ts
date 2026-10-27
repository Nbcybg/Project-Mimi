import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectorSpec } from '@mimi/shared';
import { ConnectorRegistry } from '../connectors/registry.ts';
import { ConnectorRuntimeImpl } from '../connectors/runtime.ts';
import { connectorSpecs } from '../connectors/services/index.ts';
import type { ConnectorAuthResolver } from '../connectors/types.ts';
import { fakeFetch, fixtureBody } from './helpers/fake-fetch.ts';

const registry = new ConnectorRegistry(connectorSpecs);
const tokenAuth: ConnectorAuthResolver = {
  resolve(connector) {
    const spec = registry.get(connector);
    const field = spec?.auth.fields[0];
    return spec?.auth.kind === 'oauth2'
      ? { accessToken: 'access-token-test', clientId: 'client-test', clientSecret: 'secret-test', refreshToken: 'refresh-test', expiresAt: '9999999999' }
      : field
        ? { [field.key]: 'token-test' }
        : {};
  },
};

type Input = Record<string, unknown>;

const samples: Record<string, Record<string, Input>> = {
  facebook: {
    list_pages: {},
    create_post: { pageId: 'page1', message: 'hello' },
    list_posts: { pageId: 'page1' },
  },
  instagram: {
    list_media: { igUserId: 'ig1' },
    create_post: { igUserId: 'ig1', imageUrl: 'https://example.com/photo.jpg', caption: 'hello' },
    publish_media: { igUserId: 'ig1', creationId: 'creation1' },
    get_insights: { igUserId: 'ig1' },
  },
  linkedin: {
    list_organizations: {},
    create_post: { author: 'urn:li:organization:1', text: 'hello' },
    get_profile: {},
  },
  x: {
    create_post: { text: 'hello' },
    list_posts: { userId: 'u1' },
    delete_post: { postId: 'p1' },
  },
  youtube: {
    search_videos: { q: 'mimi' },
    list_channel_videos: { channelId: 'ch1' },
    upload_video: { content: 'aGk=' },
  },
  reddit: {
    search: { q: 'mimi' },
    list_subreddit_posts: { subreddit: 'typescript' },
    create_comment: { thingId: 't3_abc', text: 'hello' },
  },
  google_search_console: {
    list_sites: {},
    query_search_analytics: { siteUrl: 'https://example.com/', startDate: '2024-01-01', endDate: '2024-01-31' },
  },
  google_chat: {
    list_spaces: {},
    send_message: { spaceId: 'spaces/AAAA', text: 'hello' },
    list_messages: { spaceId: 'spaces/AAAA' },
  },
  google_slides: {
    create_presentation: { title: 'Deck' },
    get_presentation: { presentationId: 'pres1' },
    add_text: { presentationId: 'pres1', objectId: 'shape1', text: 'hello' },
  },
  google_classroom: {
    list_courses: {},
    list_coursework: { courseId: 'course1' },
    create_coursework: { courseId: 'course1', title: 'Essay' },
  },
};

function expectedPath(spec: ConnectorSpec, operation: ConnectorSpec['operations'][number], input: Input): string {
  const rendered = operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const fallback = operation.fields.find((field) => field.key === key)?.default;
    return encodeURIComponent(String(input[key] ?? fallback));
  });
  if (/^https?:\/\//i.test(rendered)) return new URL(rendered).pathname;
  return new URL(`${spec.baseUrl!.replace(/\/+$/, '')}/${rendered.replace(/^\/+/, '')}`).pathname;
}

for (const [service, cases] of Object.entries(samples)) {
  test(`batch F: ${service} operations reach the right endpoint`, async () => {
    const spec = registry.get(service)!;
    const api = fakeFetch(() => Response.json(fixtureBody()));
    const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });
    for (const [operationKey, input] of Object.entries(cases)) {
      const operation = spec.operations.find((entry) => entry.key === operationKey);
      assert.ok(operation, `${service}.${operationKey} exists`);
      await runtime.execute({ connector: service, operation: operationKey, input });
      const call = api.calls.at(-1)!;
      assert.equal(call.method, operation.method, `${service}.${operationKey} method`);
      assert.equal(new URL(call.url).pathname, expectedPath(spec, operation, input), `${service}.${operationKey} path`);
      assert.equal(call.headers.get('authorization'), 'Bearer access-token-test', `${service}.${operationKey} auth`);
    }
    assert.equal(api.calls.length, Object.keys(cases).length);
  });
}

test('batch F: provider bodies, binary uploads and static headers', async () => {
  const api = fakeFetch(() => Response.json(fixtureBody()));
  const runtime = new ConnectorRuntimeImpl({ registry, auth: tokenAuth, fetchFn: api.fetchFn });
  let offset = 0;

  await runtime.execute({ connector: 'facebook', operation: 'create_post', input: { pageId: 'page1', message: 'hello' } });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), { message: 'hello' });

  await runtime.execute({ connector: 'instagram', operation: 'publish_media', input: { igUserId: 'ig1', creationId: 'creation1' } });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), { creation_id: 'creation1' });

  await runtime.execute({ connector: 'linkedin', operation: 'create_post', input: { author: 'urn:li:organization:1', text: 'hello' } });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), {
    author: 'urn:li:organization:1',
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': { shareCommentary: { text: 'hello' }, shareMediaCategory: 'NONE' },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  });

  await runtime.execute({ connector: 'youtube', operation: 'upload_video', input: { content: Buffer.from('hello').toString('base64') } });
  assert.equal(api.calls[offset]!.headers.get('content-type'), 'application/octet-stream');
  assert.equal(Buffer.from(api.calls[offset++]!.bodyBytes!).toString('utf8'), 'hello');

  await runtime.execute({ connector: 'reddit', operation: 'create_comment', input: { thingId: 't3_abc', text: 'hello' } });
  const reddit = api.calls[offset++]!;
  assert.equal(reddit.headers.get('user-agent'), 'mimi-connector/1.0');
  assert.deepEqual(JSON.parse(reddit.body!), { api_type: 'json', thing_id: 't3_abc', text: 'hello' });

  await runtime.execute({
    connector: 'google_search_console',
    operation: 'query_search_analytics',
    input: { siteUrl: 'https://example.com/', startDate: '2024-01-01', endDate: '2024-01-31' },
  });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), {
    startDate: '2024-01-01',
    endDate: '2024-01-31',
    dimensions: ['query'],
    rowLimit: 25,
  });

  await runtime.execute({ connector: 'google_chat', operation: 'send_message', input: { spaceId: 'spaces/AAAA', text: 'hello' } });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), { text: 'hello' });

  await runtime.execute({ connector: 'google_slides', operation: 'add_text', input: { presentationId: 'pres1', objectId: 'shape1', text: 'hello' } });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), { requests: [{ insertText: { objectId: 'shape1', text: 'hello' } }] });

  await runtime.execute({ connector: 'google_classroom', operation: 'create_coursework', input: { courseId: 'course1', title: 'Essay' } });
  assert.deepEqual(JSON.parse(api.calls[offset++]!.body!), {
    title: 'Essay',
    workType: 'ASSIGNMENT',
    state: 'DRAFT',
    maxPoints: 100,
  });

  assert.equal(api.calls.length, offset);
});
