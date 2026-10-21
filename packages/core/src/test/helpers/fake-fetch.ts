export interface RecordedCall {
  url: string;
  method: string;
  body: string | undefined;
  headers: Headers;
}

export type FakeHandler = (call: RecordedCall) => Response | Promise<Response>;

/** Captures every request and lets a test answer it without touching the network. */
export function fakeFetch(handler: FakeHandler = () => Response.json({ ok: true })) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

/** A body that satisfies every list response used by the connector specs. */
export function fixtureBody(): Record<string, unknown> {
  return {
    ok: true,
    data: [{ id: 'data_1' }],
    items: [{ id: 'item_1' }],
    results: [{ id: 'result_1' }],
    responses: [{ responseId: 'response_1' }],
    records: [{ id: 'rec_1' }],
    members: [{ id: 'member_1' }],
    channels: [{ id: 'channel_1' }],
    messages: [{ id: 'message_1' }],
    message: { id: 'message_1' },
    id: 'object_1',
  };
}
