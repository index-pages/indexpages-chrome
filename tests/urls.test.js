import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, splitUrlText, mergeUrls, sanitizeList, describeMerge, REASONS, MAX_URL_LENGTH } from '../lib/urls.js';

test('normalizeUrl accepts http and https and canonicalises them', () => {
  assert.deepEqual(normalizeUrl('  HTTPS://Example.COM/Path?q=1  '), { ok: true, url: 'https://example.com/Path?q=1' });
  assert.equal(normalizeUrl('http://example.com').url, 'http://example.com/');
  assert.equal(normalizeUrl('https://example.com/a#section').url, 'https://example.com/a');
  assert.equal(normalizeUrl('https://bücher.example/').url, 'https://xn--bcher-kva.example/');
});

test('normalizeUrl rejects what cannot be indexed', () => {
  assert.equal(normalizeUrl('').reason, REASONS.empty);
  assert.equal(normalizeUrl('not a url').reason, REASONS.invalid);
  assert.equal(normalizeUrl('example.com/page').reason, REASONS.invalid);
  assert.equal(normalizeUrl('ftp://example.com/').reason, REASONS.scheme);
  assert.equal(normalizeUrl('chrome://extensions/').reason, REASONS.scheme);
  assert.equal(normalizeUrl('javascript:alert(1)').reason, REASONS.scheme);
  assert.equal(normalizeUrl('https://user:pw@example.com/').reason, REASONS.credentials);
  assert.equal(normalizeUrl('http://localhost:8080/').reason, REASONS.local);
  assert.equal(normalizeUrl('http://127.0.0.1/').reason, REASONS.local);
  assert.equal(normalizeUrl('http://10.1.2.3/').reason, REASONS.local);
  assert.equal(normalizeUrl('http://172.20.0.1/').reason, REASONS.local);
  assert.equal(normalizeUrl('http://[::1]/').reason, REASONS.local);
  assert.equal(normalizeUrl('http://intranet/').reason, REASONS.local);
  assert.equal(normalizeUrl('http://printer.local/').reason, REASONS.local);
  assert.equal(normalizeUrl(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`).reason, REASONS.tooLong);
  assert.equal(normalizeUrl(42).ok, false);
});

test('public IPv4 hosts are allowed', () => {
  assert.equal(normalizeUrl('http://172.32.0.1/').ok, true);
  assert.equal(normalizeUrl('http://8.8.8.8/').ok, true);
});

test('splitUrlText splits on lines and whitespace and drops blanks', () => {
  assert.deepEqual(splitUrlText('https://a.example/\n\n  https://b.example/ https://c.example/\r\n'), [
    'https://a.example/', 'https://b.example/', 'https://c.example/',
  ]);
  assert.deepEqual(splitUrlText(''), []);
  assert.deepEqual(splitUrlText(null), []);
});

test('mergeUrls dedupes against the list and within the batch', () => {
  const r = mergeUrls(['https://example.com/a'], [
    'https://example.com/a', 'https://EXAMPLE.com/a#top', 'https://example.com/b', 'https://example.com/b', 'mailto:x@example.com', '',
  ]);
  assert.deepEqual(r.list, ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(r.added, ['https://example.com/b']);
  assert.equal(r.duplicates.length, 3);
  assert.deepEqual(r.invalid, [{ input: 'mailto:x@example.com', reason: REASONS.scheme }]);
});

test('mergeUrls does not modify its input and respects the maximum', () => {
  const existing = ['https://example.com/1'];
  const r = mergeUrls(existing, ['https://example.com/2', 'https://example.com/3'], { max: 2 });
  assert.deepEqual(existing, ['https://example.com/1']);
  assert.deepEqual(r.list, ['https://example.com/1', 'https://example.com/2']);
  assert.deepEqual(r.overflow, ['https://example.com/3']);
});

test('sanitizeList cleans a corrupted stored list', () => {
  assert.deepEqual(sanitizeList(['https://example.com/', 7, 'https://example.com/', 'bad']), ['https://example.com/']);
  assert.deepEqual(sanitizeList(undefined), []);
});

test('describeMerge summarises', () => {
  const r = mergeUrls([], ['https://example.com/a', 'https://example.com/a', 'nope']);
  assert.equal(describeMerge(r), 'Added 1 URL. 1 already in the list. 1 skipped as not indexable.');
  assert.equal(describeMerge(mergeUrls([], [])), '');
});
