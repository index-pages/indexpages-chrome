import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/api.js';
import { outcomeUnknown, sha256Hex, storeFrom, withIdempotency } from '../lib/idempotency.js';

let n = 0;
const newKey = () => `key-${++n}`;

test('outcomeUnknown keeps the key only when the server may have acted', () => {
  assert.equal(outcomeUnknown(new ApiError({ status: 0, network: true })), true);
  assert.equal(outcomeUnknown(new ApiError({ status: 500, problem: { code: 'internal_error' } })), true);
  assert.equal(outcomeUnknown(new ApiError({ status: 429, problem: { code: 'rate_limited' } })), true);
  assert.equal(outcomeUnknown(new ApiError({ status: 409, problem: { code: 'idempotency_key_in_flight' } })), true);
  assert.equal(outcomeUnknown(new ApiError({ status: 409, problem: { code: 'order_not_executable' } })), false);
  assert.equal(outcomeUnknown(new ApiError({ status: 402, problem: { code: 'insufficient_balance' } })), false);
  assert.equal(outcomeUnknown(new ApiError({ status: 422, problem: { code: 'validation_failed' } })), false);
  assert.equal(outcomeUnknown(new Error('weird')), true);
});

test('the same operation and body reuse the key until it succeeds', async () => {
  const store = storeFrom(new Map());
  const seen = [];
  const flaky = async (k) => { seen.push(k); throw new ApiError({ status: 0, network: true }); };
  await assert.rejects(withIdempotency(store, 'create', 'fp1', flaky, { newKey }));
  await assert.rejects(withIdempotency(store, 'create', 'fp1', flaky, { newKey }));
  const result = await withIdempotency(store, 'create', 'fp1', async (k) => { seen.push(k); return 'ok'; }, { newKey });
  assert.equal(result, 'ok');
  assert.equal(new Set(seen).size, 1);
  assert.equal(await store.get('idem:create'), undefined);
});

test('a different body gets a different key', async () => {
  const store = storeFrom(new Map());
  const seen = [];
  const fail = async (k) => { seen.push(k); throw new ApiError({ status: 503 }); };
  await assert.rejects(withIdempotency(store, 'create', 'fp1', fail, { newKey }));
  await assert.rejects(withIdempotency(store, 'create', 'fp2', fail, { newKey }));
  assert.notEqual(seen[0], seen[1]);
});

test('a definitive 4xx drops the key so a later retry is fresh (402 after top-up)', async () => {
  const store = storeFrom(new Map());
  const seen = [];
  await assert.rejects(withIdempotency(store, 'run:x', 'x', async (k) => { seen.push(k); throw new ApiError({ status: 402, problem: { code: 'insufficient_balance' } }); }, { newKey }));
  assert.equal(await store.get('idem:run:x'), undefined);
  await withIdempotency(store, 'run:x', 'x', async (k) => { seen.push(k); return {}; }, { newKey });
  assert.notEqual(seen[0], seen[1]);
});

test('storeFrom wraps a chrome.storage-like area', async () => {
  const data = {};
  const area = {
    get: async (k) => ({ [k]: data[k] }),
    set: async (o) => { Object.assign(data, o); },
    remove: async (k) => { delete data[k]; },
  };
  const s = storeFrom(area);
  await s.set('a', 1);
  assert.equal(await s.get('a'), 1);
  await s.remove('a');
  assert.equal(await s.get('a'), undefined);
});

test('sha256Hex', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
