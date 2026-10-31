import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyError, formatError } from '../errors.ts';

test('errors: stable codes for the failures a chat shows', () => {
  assert.deepEqual(classifyError(Object.assign(new Error('invalid api key'), { statusCode: 401 })), {
    code: 'E-AUTH-401',
    message: 'invalid api key',
  });
  assert.equal(classifyError(new Error('Rate limit reached, too many requests')).code, 'E-RATE');
  assert.equal(classifyError(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' })).code, 'E-TIMEOUT');
  assert.equal(classifyError(new Error('fetch failed')).code, 'E-NETWORK');
  assert.equal(classifyError(new Error('maximum context length exceeded')).code, 'E-CONTEXT');
  assert.equal(classifyError(new Error('unknown tool "ghost"')).code, 'E-CONFIG');
  assert.equal(classifyError(new Error('daily budget reached')).code, 'E-BUDGET');
  assert.equal(classifyError(new Error('something odd')).code, 'E-INTERNAL');
  assert.equal(formatError(Object.assign(new Error('quota exhausted'), { status: 429 })), 'E-RATE-429: quota exhausted');
  assert.deepEqual(classifyError(new Error('E-NETWORK: socket hang up')), { code: 'E-NETWORK', message: 'socket hang up' });
});
