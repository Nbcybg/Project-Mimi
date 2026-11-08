import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import { test } from 'node:test';
import { ALLOW_HEADERS, allowedOrigins, applyCors } from '../server/cors.ts';

function preflight(origin: string, requested: string): { handled: boolean; headers: Record<string, string>; status?: number } {
  const headers: Record<string, string> = {};
  let status: number | undefined;
  const request = { headers: { origin }, method: 'OPTIONS' } as unknown as http.IncomingMessage;
  const response = {
    setHeader: (name: string, value: string) => void (headers[name.toLowerCase()] = value),
    writeHead: (code: number, extra?: Record<string, string>) => {
      status = code;
      for (const [name, value] of Object.entries(extra ?? {})) headers[name.toLowerCase()] = value;
      return response;
    },
    end: () => undefined,
  } as unknown as http.ServerResponse;
  void requested;
  const handled = applyCors(request, response, allowedOrigins({}));
  return { handled, headers, status };
}

const allowedList = (): string[] => ALLOW_HEADERS.split(',').map((name) => name.trim().toLowerCase());

test('a preflight from an app shell allows the headers the page sends with an upload', () => {
  const answer = preflight('http://tauri.localhost', 'authorization,content-type,x-mimi-caption');
  assert.equal(answer.status, 204);
  for (const name of ['authorization', 'content-type', 'x-mimi-caption']) assert.ok(allowedList().includes(name), name);
});

test('every custom x-mimi-* request header the server reads is allowed by CORS', () => {
  const source = fs.readFileSync(new URL('../server/http-api.ts', import.meta.url), 'utf8');
  const read = [...source.matchAll(/headers\['(x-mimi-[a-z-]+)'\]/g)].map((match) => match[1]!);
  assert.ok(read.length > 0);
  for (const name of read) assert.ok(allowedList().includes(name), `${name} is read by the server but not in the CORS allow-list`);
});

test('a preflight from another origin is refused', () => {
  const answer = preflight('https://evil.example', 'authorization');
  assert.equal(answer.handled, true);
  assert.equal(answer.status, 403);
  assert.equal(answer.headers['access-control-allow-origin'], undefined);
});
