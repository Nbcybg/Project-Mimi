import type http from 'node:http';
import type { CalendarSync } from './sync.ts';

/** Notifications are tiny; anything larger is not a calendar event. */
const MAX_PUSH_BYTES = 256 * 1024;

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PUSH_BYTES) {
        reject(new Error('Calendar notification is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * `/api/calendar/push/<token>` — the public endpoint Graph and Google call.
 * It is not behind the app token: the unguessable per-account token in the path,
 * the Google channel token header and Graph's `clientState` are the credentials.
 * Validation requests (Graph) are echoed before any state is touched.
 */
export async function serveCalendarPush(
  sync: CalendarSync,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/calendar/push/')) return false;
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' }).end('Method not allowed.');
    return true;
  }
  try {
    const body = request.method === 'POST' ? await readBody(request) : '';
    const result = await sync.handlePush({ method: request.method, url, headers: request.headers, body });
    response.writeHead(result.status, {
      'content-type': result.contentType ?? 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(result.body);
  } catch (error) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end((error as Error).message);
  }
  return true;
}
