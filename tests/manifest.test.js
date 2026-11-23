import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const manifest = read('manifest.json');
const dev = read('manifest.dev.json');

test('shipped permissions are the minimal set', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.slice().sort(), ['activeTab', 'contextMenus', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.index-pages.com/*']);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});

test('dev manifest differs only in name and loopback host permissions', () => {
  const { name, host_permissions: hp, ...rest } = dev;
  const { name: _n, host_permissions: shippedHp, ...shippedRest } = manifest;
  assert.deepEqual(rest, shippedRest);
  assert.match(name, /\(dev\)$/);
  assert.deepEqual(hp.slice(0, shippedHp.length), shippedHp);
  for (const extra of hp.slice(shippedHp.length)) assert.match(extra, /^http:\/\/(127\.0\.0\.1|localhost)\/\*$/);
});

test('every file the manifest names exists', () => {
  const files = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.action.default_popup,
    manifest.options_ui.page,
    manifest.background.service_worker,
  ];
  for (const f of files) assert.ok(existsSync(join(root, f)), f);
});

test('the base URL constant matches the host permission', async () => {
  const { DEFAULT_API_BASE } = await import('../lib/config.js');
  assert.equal(`${new URL(DEFAULT_API_BASE).origin}/*`, manifest.host_permissions[0]);
});

test('extension pages load no remote code', () => {
  for (const page of ['popup.html', 'options.html']) {
    const html = readFileSync(join(root, page), 'utf8');
    for (const m of html.matchAll(/<(script|link)\b[^>]*(src|href)="([^"]+)"/g)) {
      assert.ok(!/^(https?:)?\/\//.test(m[3]), `${page} loads ${m[3]}`);
    }
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${page} has an inline script`);
  }
});
