// Idempotency keys for the two POSTs that create or spend something.
//
// A key is kept per operation ("create" for a given request body, "run:<id>"
// for one order) and reused for every attempt until the outcome is known. So
// a double click, or a popup closed mid-request and reopened, replays the
// first answer on the server instead of creating a second order or charging
// twice.
//
// Once the server has answered for real – a 2xx, or a 4xx such as 402 or 422
// – the key is dropped: the server stores 4xx answers for 24 hours, and a
// draft run after a top-up must not get the old 402 replayed. Network
// failures, timeouts, 5xx, 429 and 409 `idempotency_key_in_flight` leave the
// outcome unknown, so the key is kept for the retry.

const PREFIX = 'idem:';

/** Whether a failed attempt may have done something the retry must not repeat. */
export function outcomeUnknown(err) {
  if (!err || typeof err !== 'object') return true;
  if (err.network) return true;
  if (typeof err.status !== 'number' || err.status >= 500) return true;
  if (err.status === 429) return true;
  if (err.status === 409 && err.code === 'idempotency_key_in_flight') return true;
  return false;
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Minimal store over chrome.storage.session (or local), or a Map in tests. */
export function storeFrom(area) {
  if (area instanceof Map) {
    return {
      get: async (k) => area.get(k),
      set: async (k, v) => { area.set(k, v); },
      remove: async (k) => { area.delete(k); },
    };
  }
  return {
    get: async (k) => (await area.get(k))[k],
    set: async (k, v) => area.set({ [k]: v }),
    remove: async (k) => area.remove(k),
  };
}

/**
 * Run `fn(idempotencyKey)` under a key bound to `operation` and `fingerprint`.
 * The same operation with a different fingerprint (another body) gets a new key.
 */
export async function withIdempotency(store, operation, fingerprint, fn, { newKey = () => globalThis.crypto.randomUUID() } = {}) {
  const slot = PREFIX + operation;
  const saved = await store.get(slot);
  let key;
  if (saved && saved.fingerprint === fingerprint && typeof saved.key === 'string') {
    key = saved.key;
  } else {
    key = newKey();
    await store.set(slot, { key, fingerprint, createdAt: Date.now() });
  }
  try {
    const result = await fn(key);
    await store.remove(slot);
    return result;
  } catch (err) {
    if (!outcomeUnknown(err)) await store.remove(slot);
    throw err;
  }
}
