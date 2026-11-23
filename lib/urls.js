// URL list handling: parsing pasted text, normalising single URLs and merging
// them into the stored list without duplicates. Pure functions only, so the
// popup, the service worker and the tests share one implementation.
//
// The server is the authority on what it accepts (scheme, length, private
// hosts, control characters). The checks here only keep obvious junk out of
// the list early; anything that slips through is reported back per URL from
// the API's `errors[]`.

export const MAX_URL_LENGTH = 2048;
export const DEFAULT_MAX_URLS = 1000;

export const REASONS = {
  empty: 'Empty line.',
  invalid: 'Not a valid URL.',
  scheme: 'Only http and https URLs can be indexed.',
  credentials: 'URLs with a user name or password are not accepted.',
  local: 'Points to a local or private address.',
  tooLong: `Longer than ${MAX_URL_LENGTH} characters.`,
};

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
  }
  if (!host.includes('.')) return true;
  return isPrivateIPv4(host);
}

/**
 * Normalise one URL. The fragment is dropped (search engines ignore it, and
 * `page#a` and `page#b` are the same page to index); scheme and host are
 * lower-cased by the URL parser, and an internationalised host becomes its
 * punycode form.
 * Returns { ok: true, url } or { ok: false, input, reason }.
 */
export function normalizeUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, input: raw, reason: REASONS.empty };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, input: raw, reason: REASONS.invalid };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, input: raw, reason: REASONS.scheme };
  }
  if (!url.hostname) return { ok: false, input: raw, reason: REASONS.invalid };
  if (url.username || url.password) return { ok: false, input: raw, reason: REASONS.credentials };
  if (isLocalHost(url.hostname)) return { ok: false, input: raw, reason: REASONS.local };
  url.hash = '';
  const href = url.href;
  if (href.length > MAX_URL_LENGTH) return { ok: false, input: raw, reason: REASONS.tooLong };
  return { ok: true, url: href };
}

/** Split pasted text into candidate URLs: one per line, whitespace-separated pieces count separately. */
export function splitUrlText(text) {
  if (typeof text !== 'string') return [];
  return text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Merge candidates into an existing (already normalised) list.
 * Returns { list, added, duplicates, invalid, overflow } – `list` is a new
 * array; the input is not modified.
 */
export function mergeUrls(existing, candidates, { max = DEFAULT_MAX_URLS } = {}) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(list);
  const result = { list, added: [], duplicates: [], invalid: [], overflow: [] };
  for (const candidate of candidates) {
    const n = normalizeUrl(candidate);
    if (!n.ok) {
      if (n.reason !== REASONS.empty) result.invalid.push({ input: n.input, reason: n.reason });
      continue;
    }
    if (seen.has(n.url)) {
      result.duplicates.push(n.url);
      continue;
    }
    if (list.length >= max) {
      result.overflow.push(n.url);
      continue;
    }
    seen.add(n.url);
    list.push(n.url);
    result.added.push(n.url);
  }
  return result;
}

/** Drop anything from a stored list that is not a normalised, unique, acceptable URL. */
export function sanitizeList(stored, { max = DEFAULT_MAX_URLS } = {}) {
  return mergeUrls([], Array.isArray(stored) ? stored.filter((v) => typeof v === 'string') : [], { max }).list;
}

/** A short human summary of a merge, or '' when there is nothing to say. */
export function describeMerge({ added, duplicates, invalid, overflow }, { max = DEFAULT_MAX_URLS } = {}) {
  const parts = [];
  if (added.length) parts.push(`Added ${added.length} URL${added.length === 1 ? '' : 's'}.`);
  if (duplicates.length) parts.push(`${duplicates.length} already in the list.`);
  if (invalid.length) parts.push(`${invalid.length} skipped as not indexable.`);
  if (overflow.length) parts.push(`${overflow.length} over the limit of ${max} URLs per order.`);
  return parts.join(' ');
}
