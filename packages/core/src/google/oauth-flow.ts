import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loopbackReceiver, type ReceiverFactory } from '../oauth/callback.ts';
import { GOOGLE_SCOPES, TOKEN_ENDPOINT } from './auth.ts';

export interface OAuthFlow {
  /** The Google sign-in page the user has to open. */
  url: string;
  /** Resolves once the refresh token is stored; rejects if sign-in fails or times out. */
  done: Promise<void>;
}

/**
 * Google's sign-in: the user opens a link and Google redirects back with a code, which is
 * exchanged for a refresh token saved to `tokenFile`. On a computer the redirect goes to a
 * temporary listener on 127.0.0.1 ("desktop app" clients); a core on a server passes its
 * own `receiver` so Google redirects to its public `/oauth/callback` ("web" clients).
 */
export async function startGoogleOAuth(options: {
  clientId: string;
  clientSecret: string;
  tokenFile: string;
  receiver?: ReceiverFactory;
}): Promise<OAuthFlow> {
  const { clientId, clientSecret, tokenFile } = options;
  const state = randomBytes(16).toString('hex');
  const receiver = await (options.receiver ?? loopbackReceiver)(state, { label: 'Google' });
  const { redirectUri } = receiver;

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;

  const done = receiver.code
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
    .finally(() => receiver.close());
  done.catch(() => {}); // callers decide whether to await it

  return { url, done };
}
