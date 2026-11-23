import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_API_BASE, resolveApiBase, loadApiBase, orderDashboardUrl } from '../lib/config.js';

test('default base without an override', () => {
  assert.deepEqual(resolveApiBase(undefined), { base: DEFAULT_API_BASE, dev: false });
  assert.deepEqual(resolveApiBase(''), { base: DEFAULT_API_BASE, dev: false });
  assert.equal(DEFAULT_API_BASE, 'https://api.index-pages.com/v1');
});

test('loopback http and any https are accepted as overrides', () => {
  assert.deepEqual(resolveApiBase('http://127.0.0.1:8080/v1/'), { base: 'http://127.0.0.1:8080/v1', dev: true });
  assert.deepEqual(resolveApiBase('http://localhost:8080/v1'), { base: 'http://localhost:8080/v1', dev: true });
  assert.deepEqual(resolveApiBase('https://staging.example/v1'), { base: 'https://staging.example/v1', dev: true });
  assert.deepEqual(resolveApiBase(`${DEFAULT_API_BASE}/`), { base: DEFAULT_API_BASE, dev: false });
});

test('unsafe overrides are ignored', () => {
  for (const bad of ['http://example.com/v1', 'ftp://127.0.0.1/', 'https://u:p@example.com/v1', 'https://example.com/v1?x=1', 'nonsense']) {
    const r = resolveApiBase(bad);
    assert.equal(r.base, DEFAULT_API_BASE, bad);
    assert.equal(r.dev, false);
    assert.equal(r.rejected, bad);
  }
});

test('loadApiBase reads chrome.storage.local', async () => {
  const area = { get: async () => ({ apiBase: 'http://127.0.0.1:8080/v1' }) };
  assert.deepEqual(await loadApiBase(area), { base: 'http://127.0.0.1:8080/v1', dev: true });
  assert.deepEqual(await loadApiBase(null), { base: DEFAULT_API_BASE, dev: false });
});

test('dashboard links', () => {
  assert.equal(orderDashboardUrl('k3j4h5g6f7d8s9a0'), 'https://index-pages.com/app/orders/k3j4h5g6f7d8s9a0');
});
