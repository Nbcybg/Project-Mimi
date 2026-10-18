import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { encryptPayload, loadOrCreateVapid, sendPush, vapidHeader } from '../notify/web-push.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-push-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const b = (text: string) => Buffer.from(text, 'base64url');

/** What a browser does with the bytes: RFC 8291 decryption with its private key. */
function decrypt(body: Buffer, receiverPrivate: Buffer, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const senderKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const shared = ecdh.computeSecret(senderKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'last-record delimiter');
  return padded.subarray(0, -1).toString('utf8');
}

test('web push: encryption matches the RFC 8291 example byte for byte', () => {
  const body = encryptPayload(
    Buffer.from('When I grow up, I want to be a watermelon'),
    {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
    { privateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: b('DGv6ra1nlYgDCS1FRnbzlw') },
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('web push: a browser key pair decrypts what we send; VAPID verifies', async () => {
  const browser = crypto.createECDH('prime256v1');
  browser.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = { endpoint: 'https://push.example.com/send/abc', p256dh: browser.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };

  const vapid = loadOrCreateVapid(path.join(tmp, 'vapid.json'));
  assert.equal(loadOrCreateVapid(path.join(tmp, 'vapid.json')).publicKey, vapid.publicKey, 'the key pair is kept');
  assert.equal(b(vapid.publicKey).length, 65);

  const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
    return new Response(null, { status: sent.length === 1 ? 201 : 410 });
  }) as typeof fetch;
  const payload = { title: 'เตือน', body: 'โทรหาแม่', chatId: 3 };
  const first = await sendPush(subscription, payload, { vapid, subject: 'mailto:mimi@localhost', fetchFn, urgency: 'high' });
  assert.deepEqual(first, { status: 201, gone: false });
  const request = sent[0]!;
  assert.equal(request.url, subscription.endpoint);
  assert.equal(request.headers['content-encoding'], 'aes128gcm');
  assert.equal(request.headers.urgency, 'high');
  assert.deepEqual(JSON.parse(decrypt(request.body, browser.getPrivateKey(), auth)), payload);

  // The JWT is signed by our key, for the push service's origin.
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(request.headers.authorization!)!;
  const claims = JSON.parse(b(match[2]!).toString('utf8')) as { aud: string; sub: string; exp: number };
  assert.equal(claims.aud, 'https://push.example.com');
  assert.equal(claims.sub, 'mailto:mimi@localhost');
  assert.equal(match[4], vapid.publicKey);
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b(vapid.publicKey).subarray(1, 33).toString('base64url'), y: b(vapid.publicKey).subarray(33).toString('base64url') }, format: 'jwk' });
  assert.equal(crypto.verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(match[3]!)), true);
  assert.match(vapidHeader(subscription.endpoint, vapid, 'mailto:x@y'), /^vapid t=/);

  // A subscription the browser dropped answers 410: it is gone.
  assert.deepEqual(await sendPush(subscription, payload, { vapid, subject: 'mailto:mimi@localhost', fetchFn }), { status: 410, gone: true });
  assert.throws(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: subscription.auth }), /bad p256dh/);
});
