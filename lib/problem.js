// Turn an ApiError (or anything thrown) into text a person can act on.
//
// The API's `detail` is already written for people, so it leads; this module
// adds what the extension knows on top: which URL an `urls[3]` error points
// at, where to go next (top-up, settings), how long to wait.

import { TOPUP_URL, API_KEYS_URL, DASHBOARD_URL } from './config.js';

const SCOPE_HELP = {
  'orders:read': 'reading orders',
  'orders:write': 'creating and deleting drafts',
  'orders:run': 'running orders, which spends the balance',
  'balance:read': 'reading the balance and price',
};

/** Strip the Markdown backticks the API uses around identifiers. */
export function plain(text) {
  return typeof text === 'string' ? text.replace(/`([^`]*)`/g, '$1').trim() : '';
}

/** "urls[3]" -> 3, anything else -> null */
export function urlIndex(field) {
  const m = /^urls\[(\d+)\]$/.exec(field || '');
  return m ? Number(m[1]) : null;
}

/**
 * @param {unknown} err
 * @param {object} [ctx]
 * @param {string[]} [ctx.urls] the list that was sent, to resolve urls[i]
 * @returns {{ title: string, message: string, details: string[], rejected: Array<{index:number,url:string|null,message:string}>, action: null|{label:string,url:string,kind:string}, retryAfter: number|null, code: string|null }}
 */
export function describeError(err, { urls = [] } = {}) {
  const out = { title: 'Something went wrong', message: '', details: [], rejected: [], action: null, retryAfter: null, code: null };

  if (!err || typeof err !== 'object' || !('status' in err)) {
    out.message = plain(err?.message) || 'An unexpected error occurred.';
    return out;
  }

  if (err.network) {
    out.title = err.timeout ? 'The request timed out' : 'Could not reach Index Pages';
    out.message = err.timeout
      ? 'The API did not answer in time. Your request may still have gone through – refresh the order list before trying again.'
      : 'Check your connection and try again.';
    return out;
  }

  const p = err.problem || {};
  out.code = p.code ?? null;
  out.retryAfter = err.retryAfter ?? null;
  out.title = plain(p.title) || `Request failed (HTTP ${err.status})`;
  out.message = plain(p.detail);

  switch (p.code) {
    case 'unauthorized':
      out.title = 'API key rejected';
      out.message = 'The key is unknown, revoked or expired. Changing the account password revokes all keys. Create a new key in the dashboard and save it in the extension settings.';
      out.action = { kind: 'settings', label: 'Open settings', url: null };
      break;
    case 'forbidden_scope': {
      const scope = p.required_scope;
      out.title = 'Not allowed for this key';
      out.message = scope
        ? `This API key does not have the ${scope} scope${SCOPE_HELP[scope] ? ` (${SCOPE_HELP[scope]})` : ''}.`
        : out.message || 'This API key does not have the scope this action needs.';
      out.action = { kind: 'link', label: 'Manage API keys', url: API_KEYS_URL };
      break;
    }
    case 'account_frozen':
      out.title = 'Account frozen';
      out.message = out.message || 'This account is frozen. Contact support@index-pages.com.';
      break;
    case 'insufficient_balance':
      out.title = 'Not enough balance';
      if (!out.message && p.required && p.available) {
        out.message = `This order costs $${p.required}, your balance is $${p.available}.`;
      }
      out.message += out.message ? ' The order stays a draft; top up and run it again.' : 'Top up and run the order again.';
      out.action = { kind: 'link', label: 'Top up balance', url: TOPUP_URL };
      break;
    case 'draft_limit_reached':
      out.title = 'Too many drafts';
      out.message = `${out.message || 'The account holds the maximum number of drafts.'} Run or delete some drafts first.`;
      out.action = { kind: 'link', label: 'Open dashboard', url: DASHBOARD_URL };
      break;
    case 'order_not_executable':
      out.title = 'Order already started';
      out.message = out.message || 'Only a draft can be run. This order has already been run or is no longer a draft.';
      break;
    case 'order_not_deletable':
      out.title = 'Cannot delete';
      out.message = out.message || 'Only drafts can be deleted.';
      break;
    case 'not_found':
      out.title = 'Not found';
      out.message = out.message || 'The order does not exist or was deleted.';
      break;
    case 'rate_limited':
      out.title = 'Too many requests';
      out.message = out.retryAfter
        ? `Please wait ${out.retryAfter} second${out.retryAfter === 1 ? '' : 's'} and try again.`
        : out.message || 'Please wait a moment and try again.';
      break;
    case 'idempotency_key_in_flight':
      out.title = 'Still working';
      out.message = 'The same request is still being processed. Wait a moment, then refresh.';
      break;
    case 'idempotency_key_reused':
      out.title = 'Request changed';
      out.message = 'The request changed while a retry was pending. Try again.';
      break;
    case 'internal_error':
      out.title = 'Server error';
      out.message = 'Index Pages had a problem handling this request. Try again later.';
      break;
    default:
      if (!out.message && err.status >= 500) out.message = 'Index Pages had a problem handling this request. Try again later.';
  }

  if (Array.isArray(p.errors)) {
    for (const e of p.errors) {
      const message = plain(e?.message) || plain(e?.code) || 'Rejected.';
      const index = urlIndex(e?.field);
      if (index !== null) {
        const url = typeof urls[index] === 'string' ? urls[index] : null;
        out.rejected.push({ index, url, message });
        out.details.push(url ? `${url} – ${message}` : `URL #${index + 1} – ${message}`);
      } else {
        out.details.push(e?.field ? `${e.field}: ${message}` : message);
      }
    }
  }

  if (!out.message) out.message = out.details.length ? '' : `HTTP ${err.status}`;
  return out;
}

/** One-line version for places with no room for a list. */
export function errorText(err, ctx) {
  const d = describeError(err, ctx);
  return [d.title, d.message, ...d.details].filter(Boolean).join(' – ');
}
