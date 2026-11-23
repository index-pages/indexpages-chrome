// Where the extension talks to and where it sends people.
//
// DEFAULT_API_BASE is the only API host the shipped manifest may reach. A
// development build can point the client elsewhere through the
// `apiBase` key in chrome.storage.local; resolveApiBase() accepts only
// https URLs or plain http on the loopback interface, so the stored value
// cannot route the API key to an arbitrary cleartext host.

export const DEFAULT_API_BASE = 'https://api.index-pages.com/v1';

export const SITE = 'https://index-pages.com';
export const DASHBOARD_URL = `${SITE}/app`;
export const TOPUP_URL = `${SITE}/app/topup`;
export const API_KEYS_URL = `${SITE}/app/settings`;
export const API_DOCS_URL = `${SITE}/api/`;
export const PRIVACY_URL = `${SITE}/privacy/`;

export function orderDashboardUrl(id) {
  return `${SITE}/app/orders/${encodeURIComponent(id)}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Turn a stored override into the base URL to use.
 * Returns { base, dev } where `dev` is true when the override is in effect,
 * and { base: DEFAULT_API_BASE, dev: false, rejected } when it is unusable.
 */
export function resolveApiBase(override) {
  if (override === undefined || override === null || override === '') {
    return { base: DEFAULT_API_BASE, dev: false };
  }
  let url;
  try {
    url = new URL(String(override).trim());
  } catch {
    return { base: DEFAULT_API_BASE, dev: false, rejected: String(override) };
  }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash) {
    return { base: DEFAULT_API_BASE, dev: false, rejected: String(override) };
  }
  const base = url.href.replace(/\/+$/, '');
  return { base, dev: base !== DEFAULT_API_BASE };
}

export async function loadApiBase(storageArea = globalThis.chrome?.storage?.local) {
  if (!storageArea) return resolveApiBase(undefined);
  const { apiBase } = await storageArea.get('apiBase');
  return resolveApiBase(apiBase);
}
