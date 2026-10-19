import path from 'node:path';
import fs from 'node:fs';
import type http from 'node:http';
import type { AttachmentView } from '@mimi/shared';
import { type AgentImages, isImageSlot } from '../chat/agent-images.ts';
import { type Attachment, type AttachmentStore, MAX_ATTACHMENT_BYTES } from '../chat/attachments.ts';

/** What the webhook endpoint answers: a `respond` node may shape all of it. */
export interface WebhookReply {
  status: number;
  headers?: Record<string, string>;
  /** Objects and arrays are sent as JSON; strings are sent as-is. */
  body: unknown;
  contentType?: string;
}

export interface HttpApiDeps {
  attachments: AttachmentStore;
  images: AgentImages;
  /** True when the request carries the shared token. */
  authorized(request: http.IncomingMessage): boolean;
  agentExists(name: string): boolean;
  /** Called after an agent's picture changed. */
  imagesChanged(): void;
  /** Fires a webhook trigger; null when the key matches no active trigger. */
  /** `secret` is the caller's `x-mimi-secret` header (or `?secret=`), for workflows that ask for one. */
  webhook(key: string, payload: string, secret?: string): Promise<WebhookReply | null>;
  /** Folder of backup files offered for download. */
  backupsDir?: string;
}

export function toAttachmentView(attachment: Attachment): AttachmentView {
  const { id, kind, name, mime, size, text } = attachment;
  return { id, kind, name, mime, size, text };
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `The file is larger than ${Math.round(limit / 1024 / 1024)} MB.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** Types a browser may show in place. Anything else is only ever offered as a download. */
const INLINE = /^(image\/(png|jpeg|webp|gif)|audio\/[\w.+-]+|video\/(webm|mp4|ogg|quicktime)|application\/pdf)$/;

/** A webhook call is a small event, not a file upload. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

function sendBytes(response: http.ServerResponse, data: Buffer, mime: string, name?: string): void {
  const inline = INLINE.test(mime);
  response.writeHead(200, {
    'content-type': inline ? mime : 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // Uploaded content must never run as a page of this origin.
    'content-security-policy': "default-src 'none'; sandbox",
    ...(name
      ? { 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}` }
      : {}),
  });
  response.end(data);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * The part of the server that moves bytes: files the user attaches and the agents'
 * pictures. Every request needs the token in an `Authorization: Bearer` header, which a
 * page from another origin cannot send without a CORS preflight this server never answers.
 * Returns false when the path is not part of this API.
 */
export async function handleHttpApi(
  deps: HttpApiDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    const [, , resource, ...rest] = url.pathname.split('/').map(decodeURIComponent);

    // Webhooks are called by services that do not have the token; the unguessable key
    // in the path is the credential, and it only exists while the trigger is active.
    if ((resource === 'webhook' || resource === 'workflow') && rest.length === 1) {
      if (!['POST', 'PUT', 'GET'].includes(request.method ?? '')) throw new HttpError(405, 'Method not allowed.');
      const payload = request.method === 'GET' ? '' : (await readBody(request, MAX_WEBHOOK_BYTES)).toString('utf8');
      const header = request.headers['x-mimi-secret'];
      const secret = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('secret') ?? undefined;
      const reply = await deps.webhook(rest[0]!, payload, secret);
      if (reply === null) throw new HttpError(404, 'No such webhook.');
      // content-length, transfer-encoding and connection belong to the server, not the workflow.
      const headers: Record<string, string> = { 'cache-control': 'no-store' };
      for (const [key, value] of Object.entries(reply.headers ?? {})) {
        if (!['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) headers[key] = value;
      }
      const isText = typeof reply.body === 'string';
      response.writeHead(reply.status, {
        'content-type': reply.contentType ?? (isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'),
        ...headers,
      });
      response.end(isText ? reply.body : JSON.stringify(reply.body ?? null));
      return true;
    }

    if (!deps.authorized(request)) throw new HttpError(401, 'Missing or wrong token.');

    if (resource === 'upload' && request.method === 'POST') {
      const data = await readBody(request, MAX_ATTACHMENT_BYTES);
      const attachment = deps.attachments.save({
        name: url.searchParams.get('name') ?? 'file',
        mime: String(request.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim(),
        data,
      });
      sendJson(response, 200, toAttachmentView(attachment));
    } else if (resource === 'backups' && request.method === 'GET' && rest.length === 1 && deps.backupsDir) {
      const name = rest[0]!;
      if (!/^mimi-backup-[\w-]+\.tar\.gz$/.test(name)) throw new HttpError(404, 'No such backup.');
      const file = path.join(deps.backupsDir, name);
      if (!fs.existsSync(file)) throw new HttpError(404, 'No such backup.');
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': fs.statSync(file).size,
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(response);
    } else if (resource === 'files' && request.method === 'GET' && rest.length === 1) {
      const attachment = deps.attachments.get(rest[0]!);
      const data = attachment && deps.attachments.read(attachment.id);
      if (!attachment || !data) throw new HttpError(404, 'No such file.');
      sendBytes(response, data, attachment.mime, attachment.name);
    } else if (resource === 'agent-image' && rest.length === 2 && isImageSlot(rest[1]!)) {
      const [agent, slot] = rest as [string, 'avatar' | 'portrait'];
      if (request.method === 'GET') {
        const image = deps.images.read(agent, slot);
        if (!image) throw new HttpError(404, 'No picture.');
        sendBytes(response, image.data, image.mime);
      } else if (request.method === 'POST' || request.method === 'DELETE') {
        if (!deps.agentExists(agent)) throw new HttpError(404, `No agent "${agent}".`);
        if (request.method === 'DELETE') deps.images.remove(agent, slot);
        else {
          const mime = String(request.headers['content-type'] ?? '').split(';')[0]!.trim();
          deps.images.save(agent, slot, mime, await readBody(request, 8 * 1024 * 1024));
        }
        deps.imagesChanged();
        sendJson(response, 200, { ok: true });
      } else {
        throw new HttpError(405, 'Method not allowed.');
      }
    } else {
      throw new HttpError(404, 'Not found.');
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    if (!response.headersSent) sendJson(response, status, { error: (error as Error).message });
    else response.destroy();
  }
  return true;
}
