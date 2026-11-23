// Live check of lib/api.js against a running API (a local copy, never
// production). Not part of `node --test`: it creates real orders and spends
// real balance (one order of one URL).
//
//   IP_API_BASE=http://127.0.0.1:8080/v1 IP_API_KEY_FILE=/path/to/key node tests/live.mjs
//
// It creates two drafts, replays one creation with the same Idempotency-Key,
// provokes a validation error, runs one 1-URL order (charging one URL),
// replays the run, lists orders and URLs, and deletes the drafts it made.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ApiClient, ApiError } from '../lib/api.js';
import { resolveApiBase, DEFAULT_API_BASE } from '../lib/config.js';
import { describeError } from '../lib/problem.js';
import { costCents, toCents, formatMoney } from '../lib/money.js';

const base = resolveApiBase(process.env.IP_API_BASE).base;
if (new URL(base).host === new URL(DEFAULT_API_BASE).host) {
  console.error('Refusing to run against the production API. Set IP_API_BASE to a local copy.');
  process.exit(2);
}
const key = (process.env.IP_API_KEY || (process.env.IP_API_KEY_FILE ? readFileSync(process.env.IP_API_KEY_FILE, 'utf8') : '')).trim();
if (!key) {
  console.error('Set IP_API_KEY or IP_API_KEY_FILE.');
  process.exit(2);
}

const client = new ApiClient({ key, base });
const stamp = Date.now().toString(36);
const url = (p) => `https://example.com/ip-chrome-live/${stamp}/${p}`;
const created = [];
const log = (...a) => console.log('•', ...a);

async function expectProblem(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`expected ${code}, the call succeeded`);
}

try {
  const v = await client.verify();
  log(`verify: source=${v.source}, scopes=${v.scopes.join(',')}`);

  const before = await client.getAccount();
  log(`account: balance ${before.balance} ${before.currency}, price ${before.price_per_url}`);

  // Draft with an idempotency key, then the same request again.
  const body = { urls: [url('a'), url('b')], title: `Extension live check ${stamp}` };
  const idem = crypto.randomUUID();
  const d1 = await client.createOrder(body, { idempotencyKey: idem });
  created.push(d1.id);
  assert.equal(d1.status, 'draft');
  assert.equal(d1.urls_total, 2);
  assert.equal(toCents(d1.cost), costCents(2, d1.price_per_url));
  const d1again = await client.createOrder(body, { idempotencyKey: idem });
  assert.equal(d1again.id, d1.id, 'replay must return the same order');
  log(`draft ${d1.id} created; replay with the same Idempotency-Key returned the same id`);

  const reused = await expectProblem(client.createOrder({ ...body, title: 'changed' }, { idempotencyKey: idem }), 'idempotency_key_reused');
  log(`same key, different body -> ${reused.status} ${reused.code}`);

  // Validation: the second URL is rejected, the message names it.
  const badUrls = [url('ok'), 'http://10.0.0.1/internal', 'ftp://example.com/file'];
  const bad = await expectProblem(client.createOrder({ urls: badUrls }), 'validation_failed');
  const d = describeError(bad, { urls: badUrls });
  log(`validation -> ${d.title}: ${d.message}`);
  for (const line of d.details) log(`   ${line}`);
  assert.ok(d.rejected.some((r) => r.index === 1 && r.url === badUrls[1]));

  // Run a 1-URL order.
  const one = await client.createOrder({ urls: [url('run')], title: `Extension live run ${stamp}` });
  created.push(one.id);
  const runKey = crypto.randomUUID();
  const ran = await client.runOrder(one.id, { idempotencyKey: runKey });
  assert.equal(ran.status, 'in_progress');
  assert.ok(ran.started_at);
  const replay = await client.runOrder(one.id, { idempotencyKey: runKey });
  assert.equal(replay.id, one.id);
  log(`ran ${one.id}: ${ran.status}, cost ${ran.cost}; replay with the same key -> ${replay.status} (no second charge)`);
  const again = await expectProblem(client.runOrder(one.id, { idempotencyKey: crypto.randomUUID() }), 'order_not_executable');
  log(`run again with a new key -> ${again.status} ${again.code}`);

  const after = await client.getAccount();
  const spent = toCents(before.balance) - toCents(after.balance);
  assert.equal(spent, toCents(ran.cost), 'balance must drop by exactly one run');
  log(`balance ${before.balance} -> ${after.balance} (spent ${formatMoney(spent)})`);

  // Lists.
  const page = await client.listOrders({ limit: 10 });
  assert.ok(page.data.some((o) => o.id === one.id));
  log(`list: ${page.data.length} orders, has_more=${page.has_more}; newest ${page.data[0]?.id} ${page.data[0]?.status}`);
  const urls = await client.listOrderUrls(one.id, { limit: 100 });
  log(`urls of ${one.id}: ${urls.data.map((u) => `${u.url} [${u.status}]`).join(', ')}`);
  const draftUrls = await client.listOrderUrls(d1.id);
  assert.ok(draftUrls.data.every((u) => u.status === 'pending'));

  const notDeletable = await expectProblem(client.deleteOrder(one.id), 'order_not_deletable');
  log(`delete the running order -> ${notDeletable.status} ${notDeletable.code}`);

  // Cheap draft for the insufficient-balance path: more URLs than the balance covers, never run.
  const balanceUrls = Math.floor(toCents(after.balance) / toCents(after.price_per_url)) + 1;
  if (balanceUrls <= after.limits.max_urls_per_order) {
    const big = await client.createOrder({ urls: Array.from({ length: balanceUrls }, (_, i) => url(`big-${i}`)), title: `Extension live 402 ${stamp}` });
    created.push(big.id);
    const short = await expectProblem(client.runOrder(big.id, { idempotencyKey: crypto.randomUUID() }), 'insufficient_balance');
    const sd = describeError(short);
    log(`run ${balanceUrls} URLs on ${after.balance} -> ${short.status}: ${sd.message} [${sd.action?.label}]`);
  }
} finally {
  for (const id of created) {
    try {
      await client.deleteOrder(id);
      log(`deleted draft ${id}`);
    } catch (err) {
      if (err.code !== 'order_not_deletable') console.error(`could not delete ${id}: ${err.message}`);
    }
  }
}

for (const id of created) {
  try {
    const o = await client.getOrder(id);
    log(`left: ${o.id} ${o.status} (not a draft, kept by design)`);
  } catch (err) {
    assert.equal(err.code, 'not_found');
  }
}
console.log('live check passed');
