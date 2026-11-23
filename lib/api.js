// Thin client for the Index Pages API v1. One method per endpoint, JSON in
// and out, RFC 9457 problems turned into ApiError. `fetch` is injected so the
// tests can stub it and so the same module runs in the popup, the options
// page and Node.

export const SCOPES = ['orders:read', 'orders:write', 'orders:run', 'balance:read'];

const TIMEOUT_MS = 30000;

export class ApiError extends Error {
  /**
   * @param {object} p
   * @param {number} p.status   HTTP status, 0 for a network failure
   * @param {object} [p.problem] parsed problem+json body, if any
   * @param {number|null} [p.retryAfter] seconds from Retry-After
   * @param {boolean} [p.network] the request never got an HTTP answer
   * @param {boolean} [p.timeout] the request was aborted by the timeout
   */
  constructor({ status, problem = null, retryAfter = null, network = false, timeout = false, cause } = {}) {
    super(problem?.detail || problem?.title || (network ? 'Network error' : `HTTP ${status}`), cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? null;
    this.retryAfter = retryAfter;
    this.network = network;
    this.timeout = timeout;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - Date.now()) / 1000));
}

export class ApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.key   the API key (ipk_live_…)
   * @param {string} opts.base  e.g. https://api.index-pages.com/v1
   * @param {Function} [opts.fetch]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ key, base, fetch: fetchImpl, timeoutMs = TIMEOUT_MS }) {
    if (!key) throw new Error('An API key is required.');
    if (!base) throw new Error('An API base URL is required.');
    this.key = key;
    this.base = base.replace(/\/+$/, '');
    this.fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query, body, idempotencyKey } = {}) {
    let url = this.base + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const headers = { Accept: 'application/json', Authorization: `Bearer ${this.key}` };
    const init = { method, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    init.signal = controller.signal;

    let response;
    try {
      response = await this.fetch(url, init);
    } catch (cause) {
      throw new ApiError({ status: 0, network: true, timeout: controller.signal.aborted, cause });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return null;

    const type = response.headers.get('Content-Type') || '';
    let data = null;
    if (type.includes('json')) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const problem = data && typeof data === 'object'
        ? data
        : { title: response.statusText || `HTTP ${response.status}`, status: response.status };
      throw new ApiError({
        status: response.status,
        problem,
        retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
      });
    }
    if (data === null) {
      throw new ApiError({ status: response.status, problem: { title: 'Unexpected response', detail: 'The API answered with something that is not JSON.' } });
    }
    return data;
  }

  getAccount() {
    return this.request('GET', '/account');
  }

  listOrders({ limit = 10, cursor, status } = {}) {
    return this.request('GET', '/orders', { query: { limit, cursor, status } });
  }

  createOrder({ urls, title, comment }, { idempotencyKey } = {}) {
    const body = { urls };
    if (title) body.title = title;
    if (comment) body.comment = comment;
    return this.request('POST', '/orders', { body, idempotencyKey });
  }

  getOrder(id) {
    return this.request('GET', `/orders/${encodeURIComponent(id)}`);
  }

  deleteOrder(id) {
    return this.request('DELETE', `/orders/${encodeURIComponent(id)}`);
  }

  runOrder(id, { idempotencyKey } = {}) {
    return this.request('POST', `/orders/${encodeURIComponent(id)}/run`, { idempotencyKey });
  }

  listOrderUrls(id, { limit, cursor } = {}) {
    return this.request('GET', `/orders/${encodeURIComponent(id)}/urls`, { query: { limit, cursor } });
  }

  /**
   * Verify the key and find out what it may do.
   *
   * GET /account answers with the key's scopes, but only to a key that has
   * `balance:read`. For a key without it, each remaining scope is probed with
   * a request that cannot change anything: the scope check runs before
   * anything else on the server, so a missing scope is a 403
   * `forbidden_scope`, and a present one falls through to a harmless answer –
   * `GET /orders?limit=1` lists, `POST /orders` with `{}` fails validation
   * (422) and `POST /orders/<unknown id>/run` is a 404.
   *
   * Returns { scopes: string[], account: object|null, key: object|null, source }.
   * Throws ApiError on 401, a frozen account, or any inconclusive probe.
   */
  async verify() {
    try {
      const account = await this.getAccount();
      const scopes = Array.isArray(account?.key?.scopes) ? account.key.scopes.filter((s) => SCOPES.includes(s)) : [];
      return { scopes, account, key: account?.key ?? null, source: 'account' };
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'forbidden_scope') throw err;
    }

    const scopes = [];
    const probes = [
      ['orders:read', () => this.listOrders({ limit: 1 }), (e) => e === null],
      ['orders:write', () => this.request('POST', '/orders', { body: {} }), (e) => e?.status === 422],
      ['orders:run', () => this.request('POST', `/orders/${'0'.repeat(16)}/run`), (e) => e?.status === 404 && e.code === 'not_found'],
    ];
    for (const [scope, call, granted] of probes) {
      let error = null;
      try {
        await call();
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        error = err;
      }
      if (granted(error)) {
        scopes.push(scope);
      } else if (error?.code !== 'forbidden_scope') {
        throw error ?? new ApiError({ status: 200, problem: { title: 'Unexpected response', detail: `Could not check the ${scope} scope.` } });
      }
    }
    return { scopes, account: null, key: null, source: 'probe' };
  }
}

/** What the extension can offer with a set of scopes. */
export function capabilities(scopes) {
  const has = new Set(scopes || []);
  return {
    readBalance: has.has('balance:read'),
    readOrders: has.has('orders:read'),
    createDrafts: has.has('orders:write'),
    deleteDrafts: has.has('orders:write'),
    runOrders: has.has('orders:run'),
  };
}

/** "ipk_live_ab12…wxyz" – the prefix the dashboard shows plus the last four characters. */
export function maskKey(key) {
  if (typeof key !== 'string' || key.length < 17) return '••••';
  return `${key.slice(0, 13)}…${key.slice(-4)}`;
}

/** A loose shape check before the key is sent anywhere. */
export function looksLikeKey(key) {
  return typeof key === 'string' && /^ipk_[a-z]+_[A-Za-z0-9]{20,}$/.test(key);
}
