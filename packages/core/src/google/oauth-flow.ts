import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { GOOGLE_SCOPES, TOKEN_ENDPOINT } from './auth.ts';

export interface OAuthFlow {
  /** The Google sign-in page the user has to open. */
  url: string;
  /** Resolves once the refresh token is stored; rejects if sign-in fails or times out. */
  done: Promise<void>;
}

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Google's "desktop app" sign-in: the user opens a link, Google redirects back to a
 * temporary listener on 127.0.0.1, and the returned code is exchanged for a refresh
 * token that is saved to `tokenFile`.
 */
export async function startGoogleOAuth(options: {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
}): Promise<OAuthFlow> {
  const { clientId, clientSecret, tokenFile } = options;
  const state = randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Google sign-in timed out')), FLOW_TIMEOUT_MS);
    server.on('request', (request, response) => {
      const callback = new URL(request.url ?? '/', redirectUri);
      const answer = (status: number, text: string) => {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(text);
      };
      if (callback.searchParams.get('state') !== state) return answer(400, 'State mismatch. Start again.');
      clearTimeout(timer);
      const error = callback.searchParams.get('error');
      const value = callback.searchParams.get('code');
      if (error || !value) {
        answer(400, `Sign-in was not completed: ${error ?? 'no code'}`);
        return reject(new Error(`Google sign-in was not completed: ${error ?? 'no code'}`));
      }
      answer(200, 'Mimi is connected to Google. You can close this tab.');
      resolve(value);
    });
  });

  const done = code
    .then(async (value) => {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: value,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const token = (await response.json()) as { refresh_token?: string; error_description?: string; error?: string };
      if (!response.ok || !token.refresh_token) {
        throw new Error(`Google did not return a refresh token: ${token.error_description ?? token.error ?? response.status}`);
      }
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: token.refresh_token }, null, 2), { mode: 0o600 });
    })
    .finally(() => server.close());
  done.catch(() => {}); // callers decide whether to await it

  return { url, done };
}
