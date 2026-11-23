// chrome.storage access in one place. Everything lives in storage.local
// (never sync: the API key must not leave this browser profile). Short-lived
// state – pending idempotency keys and an order awaiting run confirmation –
// lives in storage.session, which is cleared when the browser closes.

import { mergeUrls, sanitizeList, DEFAULT_MAX_URLS } from './urls.js';

export const K = {
  apiKey: 'apiKey',
  keyInfo: 'keyInfo',
  urls: 'urlList',
  limits: 'limits',
  apiBase: 'apiBase',
  pendingRun: 'pendingRun',
};

const local = () => chrome.storage.local;
export const sessionArea = () => chrome.storage.session ?? chrome.storage.local;

export async function getKey() {
  const data = await local().get([K.apiKey, K.keyInfo]);
  return { key: data[K.apiKey] || null, info: data[K.keyInfo] || null };
}

export async function saveKey(key, info) {
  await local().set({ [K.apiKey]: key, [K.keyInfo]: info });
}

export async function updateKeyInfo(patch) {
  const { [K.keyInfo]: info } = await local().get(K.keyInfo);
  if (!info) return;
  await local().set({ [K.keyInfo]: { ...info, ...patch } });
}

export async function removeKey() {
  await local().remove([K.apiKey, K.keyInfo, K.limits]);
  await sessionArea().remove(K.pendingRun);
}

export async function getLimits() {
  const { [K.limits]: limits } = await local().get(K.limits);
  return limits || null;
}

export async function saveLimits(limits) {
  if (limits && typeof limits === 'object') await local().set({ [K.limits]: limits });
}

export function maxUrls(limits) {
  const n = limits?.max_urls_per_order;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_URLS;
}

export async function getList() {
  const { [K.urls]: list } = await local().get(K.urls);
  return Array.isArray(list) ? list : [];
}

export async function setList(list) {
  await local().set({ [K.urls]: list });
}

/** Merge candidates into the stored list; returns the merge result. */
export async function addToList(candidates) {
  const [list, limits] = await Promise.all([getList(), getLimits()]);
  const max = maxUrls(limits);
  const result = mergeUrls(sanitizeList(list, { max: Infinity }), candidates, { max });
  if (result.added.length) await setList(result.list);
  return result;
}

export async function removeFromList(url) {
  const list = await getList();
  await setList(list.filter((u) => u !== url));
}

/** Remove exactly the URLs that went into an order, keep anything added meanwhile. */
export async function removeSent(sent) {
  const done = new Set(sent);
  const list = await getList();
  await setList(list.filter((u) => !done.has(u)));
}

export async function getPendingRun() {
  const { [K.pendingRun]: p } = await sessionArea().get(K.pendingRun);
  return p || null;
}

export async function setPendingRun(order) {
  await sessionArea().set({ [K.pendingRun]: order });
}

export async function clearPendingRun() {
  await sessionArea().remove(K.pendingRun);
}
