import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, capabilities, maskKey, looksLikeKey } from '../lib/api.js';

const KEY = `ipk_live_${'A1b2C3d4E5'.repeat(4)}`;
const BASE = 'https://api.test.invalid/v1';

function json(status, body, headers = {}) {
  const type = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': type, ...headers } });
}

/** A fetch stub that answers from a list of [method, path-with-query, responder] routes and records calls. */
function stub(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const call = { method: init.method, path: u.pathname.replace('/v1', '') + u.search, headers: init.headers, body: init.body, init };
    calls.push(call);
    for (const [method, path, respond] of routes) {
      if (method === call.method && path === call.path) return respond(call);
    }
    return json(404, { title: 'Not found', code: 'not_found', detail: 'No route.' });
  };
  return { fetch, calls };
}

const ORDER = {
  id: 'k3j4h5g6f7d8s9a0', title: 'Untitled Order 1', comment: null, status: 'draft', urls_total: 2, urls_done: 0,
  price_per_url: '1.00', cost: '2.00', currency: 'USD', created_at: '2026-10-10T12:00:00Z', started_at: null, campaign_ends_at: null,
};

test('sends the bearer key, JSON headers and no cookies', async () => {
  const { fetch, calls } = stub([['GET', '/account', () => json(200, { balance: '25.00' })]]);
  const client = new ApiClient({ key: KEY, base: `${BASE}/`, fetch });
  assert.deepEqual(await client.getAccount(), { balance: '25.00' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].headers.Accept, 'application/json');
  assert.equal(calls[0].headers['Content-Type'], undefined);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].body, undefined);
});

test('createOrder posts JSON with an Idempotency-Key and leaves out empty fields', async () => {
  const { fetch, calls } = stub([['POST', '/orders', () => json(201, ORDER, { Location: `${BASE}/orders/${ORDER.id}` })]]);
  const client = new ApiClient({ key: KEY, base: BASE, fetch });
  const order = await client.createOrder({ urls: ['https://example.com/a', 'https://example.com/b'], title: '' }, { idempotencyKey: 'k-1' });
  assert.equal(order.id, ORDER.id);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers['Idempotency-Key'], 'k-1');
  assert.deepEqual(JSON.parse(calls[0].body), { urls: ['https://example.com/a', 'https://example.com/b'] });
});

test('runOrder sends no body; deleteOrder handles 204; ids are encoded', async () => {
  const { fetch, calls } = stub([
    ['POST', `/orders/${ORDER.id}/run`, () => json(200, { ...ORDER, status: 'in_progress' })],
    ['DELETE', `/orders/${ORDER.id}`, () => json(204)],
  ]);
  const client = new ApiClient({ key: KEY, base: BASE, fetch });
  assert.equal((await client.runOrder(ORDER.id, { idempotencyKey: 'r-1' })).status, 'in_progress');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers['Content-Type'], undefined);
  assert.equal(calls[0].headers['Idempotency-Key'], 'r-1');
  assert.equal(await client.deleteOrder(ORDER.id), null);
  await assert.rejects(client.getOrder('../account'), (e) => e.status === 404);
  assert.equal(calls[2].path, '/orders/..%2Faccount');
});

test('query parameters skip empty values', async () => {
  const { fetch, calls } = stub([
    ['GET', '/orders?limit=10', () => json(200, { data: [ORDER], next_cursor: null, has_more: false })],
    ['GET', '/orders?limit=5&cursor=abc&status=draft', () => json(200, { data: [], next_cursor: null, has_more: false })],
    ['GET', `/orders/${ORDER.id}/urls?limit=100`, () => json(200, { data: [{ url: 'https://example.com/a', status: 'pending' }], next_cursor: null, has_more: false })],
  ]);
  const client = new ApiClient({ key: KEY, base: BASE, fetch });
  assert.equal((await client.listOrders()).data.length, 1);
  await client.listOrders({ limit: 5, cursor: 'abc', status: 'draft' });
  assert.equal((await client.listOrderUrls(ORDER.id, { limit: 100 })).data[0].status, 'pending');
  assert.equal(calls.length, 3);
});

test('problem+json becomes an ApiError with code, problem and Retry-After', async () => {
  const { fetch } = stub([
    ['POST', `/orders/${ORDER.id}/run`, () => json(402, { title: 'Insufficient balance', status: 402, code: 'insufficient_balance', detail: 'This order costs $2.00, your balance is $1.00.', required: '2.00', available: '1.00', currency: 'USD' })],
    ['GET', '/account', () => json(429, { title: 'Too many requests', status: 429, code: 'rate_limited' }, { 'Retry-After': '17' })],
  ]);
  const client = new ApiClient({ key: KEY, base: BASE, fetch });
  await assert.rejects(client.runOrder(ORDER.id), (e) => e instanceof ApiError && e.status === 402 && e.code === 'insufficient_balance' && e.problem.available === '1.00');
  await assert.rejects(client.getAccount(), (e) => e.code === 'rate_limited' && e.retryAfter === 17);
});

test('non-JSON errors and network failures', async () => {
  const html = new ApiClient({ key: KEY, base: BASE, fetch: async () => new Response('<h1>Bad gateway</h1>', { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(html.getAccount(), (e) => e.status === 502 && e.code === null && e.problem.title === 'Bad Gateway');

  const down = new ApiClient({ key: KEY, base: BASE, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(down.getAccount(), (e) => e.network === true && e.status === 0 && e.timeout === false);

  const slow = new ApiClient({
    key: KEY, base: BASE, timeoutMs: 20,
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  });
  await assert.rejects(slow.getAccount(), (e) => e.network === true && e.timeout === true);

  const okButHtml = new ApiClient({ key: KEY, base: BASE, fetch: async () => new Response('hi', { status: 200, headers: { 'Content-Type': 'text/plain' } }) });
  await assert.rejects(okButHtml.getAccount(), (e) => e.problem.title === 'Unexpected response');
});

test('verify reads scopes from /account when it can', async () => {
  const account = { balance: '25.00', currency: 'USD', price_per_url: '1.00', limits: {}, key: { name: 'chrome', prefix: 'ipk_live_A1b2', scopes: ['orders:read', 'balance:read', 'something:new'] } };
  const { fetch, calls } = stub([['GET', '/account', () => json(200, account)]]);
  const r = await new ApiClient({ key: KEY, base: BASE, fetch }).verify();
  assert.deepEqual(r.scopes, ['orders:read', 'balance:read']);
  assert.equal(r.source, 'account');
  assert.equal(r.key.name, 'chrome');
  assert.equal(calls.length, 1);
});

test('verify probes scopes for a key without balance:read, without side effects', async () => {
  const forbidden = (scope) => () => json(403, { title: 'Forbidden', status: 403, code: 'forbidden_scope', required_scope: scope });
  const { fetch, calls } = stub([
    ['GET', '/account', forbidden('balance:read')],
    ['GET', '/orders?limit=1', () => json(200, { data: [], next_cursor: null, has_more: false })],
    ['POST', '/orders', (c) => (c.body === '{}' ? json(422, { code: 'validation_failed', errors: [{ field: 'urls', code: 'required' }] }) : json(500, {}))],
    ['POST', `/orders/${'0'.repeat(16)}/run`, forbidden('orders:run')],
  ]);
  const r = await new ApiClient({ key: KEY, base: BASE, fetch }).verify();
  assert.deepEqual(r.scopes, ['orders:read', 'orders:write']);
  assert.equal(r.source, 'probe');
  assert.ok(calls.every((c) => !c.headers['Idempotency-Key']));
});

test('verify fails on a bad key and on inconclusive probes', async () => {
  const bad = stub([['GET', '/account', () => json(401, { code: 'unauthorized', status: 401 })]]);
  await assert.rejects(new ApiClient({ key: KEY, base: BASE, fetch: bad.fetch }).verify(), (e) => e.code === 'unauthorized');

  const limited = stub([
    ['GET', '/account', () => json(403, { code: 'forbidden_scope', required_scope: 'balance:read' })],
    ['GET', '/orders?limit=1', () => json(429, { code: 'rate_limited' }, { 'Retry-After': '5' })],
  ]);
  await assert.rejects(new ApiClient({ key: KEY, base: BASE, fetch: limited.fetch }).verify(), (e) => e.code === 'rate_limited');

  const frozen = stub([['GET', '/account', () => json(403, { code: 'account_frozen' })]]);
  await assert.rejects(new ApiClient({ key: KEY, base: BASE, fetch: frozen.fetch }).verify(), (e) => e.code === 'account_frozen');
});

test('capabilities, masking and key shape', () => {
  assert.deepEqual(capabilities(['orders:read', 'orders:write']), { readBalance: false, readOrders: true, createDrafts: true, deleteDrafts: true, runOrders: false });
  assert.deepEqual(capabilities(undefined), { readBalance: false, readOrders: false, createDrafts: false, deleteDrafts: false, runOrders: false });
  assert.equal(maskKey(KEY), `ipk_live_A1b2…${KEY.slice(-4)}`);
  assert.equal(maskKey('short'), '••••');
  assert.ok(looksLikeKey(KEY));
  assert.ok(!looksLikeKey(`Bearer ${KEY}`));
  assert.ok(!looksLikeKey('ipk_live_short'));
  assert.throws(() => new ApiClient({ key: '', base: BASE }));
});
