# Index Pages for Chrome

A small Manifest V3 extension for [Index Pages](https://index-pages.com/), the
URL-indexing service. It sends the current page or links you collect to your
Index Pages account as an order, using your own API key.

Plain JavaScript modules, HTML and CSS. No build step, no npm, no frameworks,
no remote code, no analytics.

## What it does

- **Popup** – balance and price per URL, a link to the
  [dashboard](https://index-pages.com/app), and a URL list kept in the browser:
  - *Add this page* adds the active tab's address (http and https only,
    deduplicated, fragment dropped);
  - a box to paste more URLs, one per line; lines that cannot be added stay in
    the box so they can be fixed;
  - *Create draft* sends the list as `POST /orders`;
  - *Create and run* creates the draft, then shows the cost (URLs × price)
    against the balance and runs it with `POST /orders/{id}/run` only after an
    explicit "Pay $X and run". With too little balance the run button is
    replaced by a link to the top-up page;
  - the last 10 orders with status, progress and cost, each linking to its
    dashboard page; drafts can be run (same confirmation) or deleted
    (two-step);
  - API errors are shown from the problem's `detail`, with every `errors[]`
    entry resolved to the URL it names; rejected URLs are highlighted in the
    list.
- **Context menu** – "Add link to Index Pages list" on links, "Add this page to
  Index Pages list" on pages. The toolbar badge shows how many URLs are
  waiting.
- **Options page** – paste the key, verify it, see it masked
  (`ipk_live_ab12…wxyz`), its name and scopes, re-check, replace or remove it.
  Explains which scopes the extension uses and recommends a key without
  `orders:run` for drafts only.

### Keys and scopes

| Scope | Without it |
|---|---|
| `balance:read` | Balance and price are hidden; the run confirmation shows the cost from the order itself and says the balance is not visible. |
| `orders:read` | Recent orders are not listed. |
| `orders:write` | URLs can still be collected, but *Create* is disabled with an explanation. |
| `orders:run` | *Create and run* and *Run…* are hidden; drafts are run in the dashboard. |

The key is verified with `GET /account`, which also returns its scopes. A key
without `balance:read` cannot read `/account`, so the remaining scopes are
probed with requests that cannot change anything: the server checks the scope
before anything else, so a missing scope is `403 forbidden_scope` and a present
one gets `GET /orders?limit=1` → 200, `POST /orders` with `{}` → 422, and
`POST /orders/0000000000000000/run` → 404.

### No duplicate orders, no double charge

Both POSTs carry an `Idempotency-Key`. One key is kept per operation (the
create request for a given body, or the run of a given order) in
`chrome.storage.session` and reused until the outcome is known, so a double
click or a popup closed mid-request replays the first answer instead of
creating a second order. A definitive answer (2xx, or a 4xx like 402) drops the
key, because the server stores 4xx replies for 24 hours and a draft run after a
top-up must not get the old 402 back. Buttons are also disabled while a
request runs, and an order awaiting confirmation survives closing the popup.

## Install unpacked

1. `chrome://extensions` → turn on *Developer mode*.
2. *Load unpacked* → pick this directory (it contains `manifest.json`).
3. Pin the icon, open the extension's options, paste a key from
   [Settings → API keys](https://index-pages.com/app/settings).

Chrome 116 or newer.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab's address when you click *Add this page* or use the right-click menu. No access to page content or other tabs. |
| `storage` | Keep the key, the URL list and limits in `chrome.storage.local` (never `sync`); a pending run confirmation and idempotency keys in `chrome.storage.session`. |
| `contextMenus` | The two right-click entries. |
| `https://api.index-pages.com/*` | The API sends no CORS headers; extension pages with a host permission can call it directly. All API calls go from the popup and the options page – there are no content scripts, and the service worker never calls the API. |

## Development

```
lib/config.js       API base constant and the dev override, dashboard links
lib/api.js          API client (one method per endpoint), ApiError, scope check
lib/problem.js      problem+json → readable text, per-URL rejections
lib/urls.js         URL normalisation, paste parsing, dedup/merge
lib/money.js        money strings as integer cents, cost and balance maths
lib/idempotency.js  Idempotency-Key lifecycle
lib/storage.js      chrome.storage access
background.js       service worker: context menus and badge
popup.*, options.*  the two pages; ui.css is shared
tests/              node:test suites; live.mjs is a manual live check
store/              Chrome Web Store listing texts (not shipped)
```

### Tests

```sh
node --test 'tests/*.test.js'
```

Node 20 or newer, nothing to install. The suites cover URL handling, money
maths, problem formatting, idempotency, the base-URL override, the manifests,
and the API client against a stubbed `fetch`.

### Against a local API

The base URL is `DEFAULT_API_BASE` in `lib/config.js`. A development build can
override it with the `apiBase` key in `chrome.storage.local`; only `https://`
URLs or plain `http://` on `localhost`/`127.0.0.1`/`[::1]` are accepted. The
options page and the popup show a "dev API" note while it is active.

The shipped manifest only allows `https://api.index-pages.com/*`, so a local API
needs the dev manifest, which adds the loopback hosts:

```sh
./package.sh --dev          # dist/dev/ with manifest.dev.json as manifest.json
```

Load `dist/dev` unpacked, open the options page, then in its DevTools console:

```js
chrome.storage.local.set({ apiBase: 'http://127.0.0.1:8080/v1' })
```

and reload the page. `chrome.storage.local.remove('apiBase')` switches back.
`tests/manifest.test.js` fails if the two manifests drift apart in anything
but the name and the loopback host permissions.

`tests/live.mjs` drives the API client against a running API (it refuses the
production host). It creates and deletes drafts, checks idempotent replays and
a validation error, and runs one 1-URL order, so it spends one URL of balance:

```sh
IP_API_BASE=http://127.0.0.1:8080/v1 IP_API_KEY_FILE=/path/to/key node tests/live.mjs
```

## Packaging

```sh
./package.sh
```

writes `dist/indexpages-chrome-<version>.zip` with only the shipped files
(manifest, pages, `lib/`, `icons/`) – no `store/`, `tests/`, dev manifest or
README. Timestamps are fixed, so the same tree gives the same archive. The
version comes from `manifest.json`.

## Firefox

Not built. What would differ:

- `background` needs `"scripts": ["background.js"], "type": "module"` instead
  of `service_worker` (Firefox runs MV3 backgrounds as event pages).
- `browser_specific_settings.gecko.id` is required, plus the
  `data_collection_permissions` declaration AMO now asks for.
- MV3 host permissions are optional in Firefox: the user grants
  `https://api.index-pages.com/*` separately, so the options page would call
  `permissions.request()` before saving a key.
- The `chrome.*` calls used here (`storage.local/session`, `contextMenus`,
  `action` badge, `tabs.query`, `runtime.openOptionsPage`) exist in Firefox
  with promises; `minimum_chrome_version` would be replaced by
  `strict_min_version`.

## Privacy

The key and the URLs you choose go only to `api.index-pages.com`. Nothing else
is collected or sent. See `store/privacy.md` and the
[privacy policy](https://index-pages.com/privacy/).

Support: support@index-pages.com
