import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MailWatch, normalizeMailAccount } from '../notify/mail-watch.ts';
import { parseMail } from '../mail/parse.ts';
import { sendSmtpMail } from '../mail/smtp.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mimi-mail-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('mail parser: RFC 2047 headers and multipart text bodies', () => {
  const raw = [
    'From: =?UTF-8?B?4Liq4Lih4LiK4Liy4Lii?= <somchai@example.com>',
    'To: me@example.com',
    `Subject: =?UTF-8?B?${Buffer.from('ใบแจ้งหนี้', 'utf8').toString('base64')}?=`, 
    'Date: Tue, 13 Oct 2026 09:00:00 +0700',
    'Message-ID: <m1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'กรุณาชำระภายในสิ้นเดือน',
    '--b1',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>กรุณาชำระภายในสิ้นเดือน</p>',
    '--b1--',
    '',
  ].join('\r\n');
  const parsed = parseMail(raw);
  assert.equal(parsed.from, 'สมชาย <somchai@example.com>');
  assert.equal(parsed.subject, 'ใบแจ้งหนี้');
  assert.match(parsed.text, /กรุณาชำระ/);
  assert.equal(parsed.messageId, '<m1@example.com>');
});

test('mail accounts: secrets are not written to the watch file', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'watch-'));
  const secrets = new Map<string, string>();
  const watch = new MailWatch({
    dir,
    password: (id) => secrets.get(`mail.${id}.password`),
    setPassword: (id, value) => (value ? secrets.set(`mail.${id}.password`, value) : secrets.delete(`mail.${id}.password`)),
    smtpPassword: (id) => secrets.get(`mail.${id}.smtp_password`),
    setSmtpPassword: (id, value) => (value ? secrets.set(`mail.${id}.smtp_password`, value) : secrets.delete(`mail.${id}.smtp_password`)),
    google: () => { throw new Error('not used'); },
    microsoft: () => { throw new Error('not used'); },
    notify: () => {},
    timezone: () => 'Asia/Bangkok',
  });
  watch.saveAccount({
    id: 'mail-work',
    kind: 'imap',
    name: 'งาน',
    email: 'me@example.com',
    incoming: {
      protocol: 'imap',
      host: 'imap.example.com',
      port: 993,
      security: 'tls',
      rejectUnauthorized: true,
      user: 'me@example.com',
      unseenOnly: true,
    },
    outgoing: {
      host: 'smtp.example.com',
      port: 465,
      security: 'tls',
      rejectUnauthorized: true,
      fromEmail: 'me@example.com',
      useIncomingPassword: true,
    },
  }, 'incoming-secret-123', 'smtp-secret-456');
  const file = fs.readFileSync(path.join(dir, 'mail-watch.json'), 'utf8');
  assert.equal(file.includes('incoming-secret-123'), false);
  assert.equal(file.includes('smtp-secret-456'), false);
  assert.deepEqual(watch.views()[0]!.hasPassword, true);
  assert.deepEqual(watch.views()[0]!.hasOutgoingPassword, true);
  assert.equal(watch.list().accounts[0]!.kind, 'imap');
});

test('old flat watch accounts are upgraded and do not keep stray fields', () => {
  const normalized = normalizeMailAccount({
    id: 'mail-old',
    kind: 'imap',
    host: 'imap.example.com',
    port: 0,
    tls: false,
    user: 'me@example.com',
    query: 'invoice',
    password: 'should-not-survive',
  });
  assert.equal(normalized?.kind, 'imap');
  if (normalized?.kind !== 'imap') return;
  assert.equal(normalized.incoming.security, 'none');
  assert.equal(normalized.incoming.query, 'invoice');
  assert.equal('password' in normalized, false);
});

test('SMTP sends headers, recipients and a dot-stuffed body', async () => {
  let received = '';
  let commands = '';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    socket.write('220 local test\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
            continue;
          }
          received += `${line}\r\n`;
          continue;
        }
        commands += `${line}\n`;
        if (line.startsWith('EHLO') || line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    const result = await sendSmtpMail({
      host: '127.0.0.1',
      port: address.port,
      security: 'none',
      rejectUnauthorized: true,
      fromEmail: 'me@example.com',
      fromName: 'Mimi',
    }, '', {
      to: 'you@example.com',
      subject: 'สวัสดี',
      text: '.บรรทัดแรก\nบรรทัดที่สอง',
      inReplyTo: '<m1@example.com>',
    });
    assert.match(result, /queued/);
    assert.match(commands, /MAIL FROM:<me@example.com>/);
    assert.match(commands, /RCPT TO:<you@example.com>/);
    assert.match(received, /Subject: =\?UTF-8\?B\?/);
    assert.match(received, /In-Reply-To: <m1@example.com>/);
    assert.match(parseMail(received).text, /^\.บรรทัดแรก/m);
    assert.doesNotMatch(received, /^Bcc:/m);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SMTP refuses header injection in the subject', async () => {
  let received = '';
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    socket.write('220 local test\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
            continue;
          }
          received += `${line}\r\n`;
          continue;
        }
        if (line.startsWith('EHLO') || line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    await sendSmtpMail({
      host: '127.0.0.1',
      port: address.port,
      security: 'none',
      rejectUnauthorized: true,
      fromEmail: 'me@example.com',
    }, '', {
      to: 'you@example.com',
      subject: 'hello\r\nBcc: evil@example.com',
      text: 'body',
    });
    assert.doesNotMatch(received, /^Bcc:/m);
    assert.match(parseMail(received).subject, /hello Bcc: evil@example.com/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
