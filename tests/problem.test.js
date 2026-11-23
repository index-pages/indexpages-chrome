import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/api.js';
import { describeError, errorText, plain, urlIndex } from '../lib/problem.js';
import { TOPUP_URL, API_KEYS_URL } from '../lib/config.js';

const problem = (status, body, extra = {}) => new ApiError({ status, problem: { status, ...body }, ...extra });

test('helpers', () => {
  assert.equal(plain('send it as `Authorization: Bearer <key>`.'), 'send it as Authorization: Bearer <key>.');
  assert.equal(urlIndex('urls[17]'), 17);
  assert.equal(urlIndex('urls'), null);
  assert.equal(urlIndex('title'), null);
});

test('validation errors name the rejected URL', () => {
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d'];
  const err = problem(422, {
    title: 'Validation failed', detail: '2 of 4 URLs were rejected.', code: 'validation_failed',
    errors: [
      { field: 'urls[3]', code: 'invalid_url', message: 'Not a valid URL.' },
      { field: 'urls[9]', code: 'private_host', message: 'Points to a private or internal address.' },
      { field: 'title', code: 'max', message: 'The title may not be greater than 255 characters.' },
    ],
  });
  const d = describeError(err, { urls });
  assert.equal(d.title, 'Validation failed');
  assert.equal(d.message, '2 of 4 URLs were rejected.');
  assert.deepEqual(d.rejected, [
    { index: 3, url: 'https://example.com/d', message: 'Not a valid URL.' },
    { index: 9, url: null, message: 'Points to a private or internal address.' },
  ]);
  assert.deepEqual(d.details, [
    'https://example.com/d – Not a valid URL.',
    'URL #10 – Points to a private or internal address.',
    'title: The title may not be greater than 255 characters.',
  ]);
});

test('whole-list errors', () => {
  const d = describeError(problem(422, { title: 'Validation failed', detail: '1 field was rejected.', code: 'validation_failed', errors: [{ field: 'urls', code: 'too_many', message: 'At most 1000 URLs.' }] }));
  assert.deepEqual(d.details, ['urls: At most 1000 URLs.']);
  assert.deepEqual(d.rejected, []);
});

test('insufficient balance points at the top-up page', () => {
  const d = describeError(problem(402, { title: 'Insufficient balance', detail: 'This order costs $120.00, your balance is $12.50.', code: 'insufficient_balance', required: '120.00', available: '12.50', currency: 'USD' }));
  assert.equal(d.title, 'Not enough balance');
  assert.match(d.message, /costs \$120\.00, your balance is \$12\.50\. The order stays a draft/);
  assert.equal(d.action.url, TOPUP_URL);
  const bare = describeError(problem(402, { code: 'insufficient_balance', required: '3.00', available: '1.00' }));
  assert.match(bare.message, /^This order costs \$3\.00, your balance is \$1\.00\./);
});

test('scope, auth, rate limit and conflicts', () => {
  const scope = describeError(problem(403, { code: 'forbidden_scope', required_scope: 'orders:run', detail: 'This API key does not have the `orders:run` scope.' }));
  assert.match(scope.message, /orders:run scope \(running orders/);
  assert.equal(scope.action.url, API_KEYS_URL);

  const auth = describeError(problem(401, { code: 'unauthorized', detail: 'A valid API key is required.' }));
  assert.equal(auth.title, 'API key rejected');
  assert.equal(auth.action.kind, 'settings');

  const rl = describeError(problem(429, { code: 'rate_limited', title: 'Too many requests' }, { retryAfter: 12 }));
  assert.equal(rl.message, 'Please wait 12 seconds and try again.');
  assert.equal(rl.retryAfter, 12);

  assert.equal(describeError(problem(409, { code: 'order_not_executable' })).title, 'Order already started');
  assert.match(describeError(problem(422, { code: 'draft_limit_reached', detail: 'You can hold at most 100 drafts.', limit: 100 })).message, /at most 100 drafts\. Run or delete/);
});

test('problems without a code and network failures', () => {
  const blank = describeError(problem(413, { type: 'about:blank', title: 'Payload too large', detail: 'The request body exceeds what one order can hold.' }));
  assert.equal(blank.title, 'Payload too large');
  assert.equal(blank.code, null);

  const s500 = describeError(new ApiError({ status: 502, problem: { title: 'Bad Gateway', status: 502 } }));
  assert.match(s500.message, /Try again later/);

  const net = describeError(new ApiError({ status: 0, network: true }));
  assert.equal(net.title, 'Could not reach Index Pages');
  const timeout = describeError(new ApiError({ status: 0, network: true, timeout: true }));
  assert.match(timeout.message, /may still have gone through/);

  assert.equal(describeError(new Error('boom')).message, 'boom');
  assert.equal(describeError(undefined).message, 'An unexpected error occurred.');
});

test('errorText joins everything in one line', () => {
  const err = problem(422, { title: 'Validation failed', detail: '1 of 1 URLs were rejected.', code: 'validation_failed', errors: [{ field: 'urls[0]', message: 'Not a valid URL.' }] });
  assert.equal(errorText(err, { urls: ['https://example.com/x'] }), 'Validation failed – 1 of 1 URLs were rejected. – https://example.com/x – Not a valid URL.');
});
