// Chrome Web Store screenshots: store/assets/screenshot-1.png … screenshot-5.png.
//
//   node tools/store-screenshots.mjs [--fonts DIR] [--chrome PATH] [--keep]
//
// The extension's own popup.html and options.html are served from this
// directory and rendered in headless Chromium with the production config. A
// stubbed `chrome.*` (storage, tabs, runtime) and a stubbed `fetch` that
// answers https://api.index-pages.com/v1 with fixture data shaped like the
// real API stand in for the browser and the server, so the pages run their
// real code with no dev badge, no loopback host and no real key. Each page is
// captured at 2x and placed on a 1280×800 canvas with a headline; ImageMagick
// (`magick`) then flattens it to 24-bit PNG without metadata.
//
// --fonts DIR  a directory with the site's font files (inter-tight-300-700-latin.woff2,
//              jetbrains-mono-400-500-latin.woff2, source-serif-4-300-700-latin.woff2).
//              They are loaded for the families ui.css asks for first; without them
//              the pages render in the system's fallback fonts.
// --chrome     Chromium or Chrome binary (default: $CHROME, then the usual paths).
// --keep       keep the work directory with the raw 2x captures.
//
// Plain Node 22+ (global WebSocket), no packages: Chromium is driven over the
// DevTools protocol directly.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'store', 'assets');

// ── Arguments ────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fontsDir = opt('--fonts') ? resolve(opt('--fonts')) : null;
const keep = args.includes('--keep');
const chromePath = opt('--chrome') || process.env.CHROME
  || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    .find((p) => existsSync(p));
if (!chromePath) {
  console.error('No Chromium found. Pass --chrome PATH or set CHROME.');
  process.exit(2);
}

const FONTS = [
  { family: 'Inter Tight', file: 'inter-tight-300-700-latin.woff2', weight: '300 700' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono-400-500-latin.woff2', weight: '400 500' },
  { family: 'Source Serif 4', file: 'source-serif-4-300-700-latin.woff2', weight: '300 700' },
].filter((f) => fontsDir && existsSync(join(fontsDir, f.file)));
if (fontsDir && !FONTS.length) console.warn(`No font files found in ${fontsDir}; using system fonts.`);

// ── Fixtures ─────────────────────────────────────────────────
// Neutral, made-up data. The key is not a real key; the popup and the
// options page only ever show it masked.

// Assembled from parts so that no key-shaped literal sits in the repository.
const FAKE_KEY = ['ipk', 'live', 'Hq7X' + 'x'.repeat(32) + 'Bn0w'].join('_');
const ALL_SCOPES = ['orders:read', 'orders:write', 'orders:run', 'balance:read'];

const daysAgo = (d, h = 10) => {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() - d);
  t.setUTCHours(h, 12, 0, 0);
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

function account(scopes = ALL_SCOPES) {
  return {
    balance: '48.00',
    currency: 'USD',
    price_per_url: '1.00',
    limits: { min_urls_per_order: 1, max_urls_per_order: 1000, max_draft_orders: 100 },
    key: { name: 'Chrome extension', prefix: FAKE_KEY.slice(0, 13), scopes },
  };
}

function order(id, title, status, total, done, ageDays) {
  const run = status !== 'draft';
  const created = daysAgo(ageDays);
  return {
    id, title, comment: null, status,
    urls_total: total, urls_done: done,
    price_per_url: '1.00', cost: `${total}.00`, currency: 'USD',
    created_at: created,
    started_at: run ? created : null,
    campaign_ends_at: run ? daysAgo(ageDays - 4) : null,
  };
}

const ORDERS = [
  order('r7m2k9p4x1c8v5n3', 'Blog posts – November', 'in_progress', 8, 5, 1),
  order('h4t8w2q6z9b3d7f1', 'Changelog 2026-11', 'in_progress', 5, 2, 2),
  order('n6c1j5y8e3u7a2s4', 'New product pages', 'done', 12, 12, 5),
  order('p3v9g6k2m8x4b1z7', 'Pricing and plans', 'done', 3, 3, 9),
  order('d8f2s5a1w7q4e9t6', 'October blog posts', 'done', 20, 20, 20),
];

function keyInfo(scopes) {
  return {
    prefix: FAKE_KEY.slice(0, 13), last4: FAKE_KEY.slice(-4),
    name: 'Chrome extension', scopes, source: 'account', verifiedAt: daysAgo(0, 9),
  };
}

const blog = ['pour-over-guide', 'cold-brew-ratios', 'grinder-settings', 'water-temperature', 'french-press-basics', 'storing-beans', 'espresso-at-home', 'decaf-explained'];
const products = ['burr-grinder', 'gooseneck-kettle', 'paper-filters', 'glass-carafe', 'digital-scale', 'travel-mug', 'dripper-ceramic', 'dripper-glass', 'milk-frother', 'bean-canister', 'cleaning-tablets', 'gift-card'];

// Each shot: the page and colour scheme, the CSS width it is laid out at
// (the popup is 24rem wide), `steps` run in the page after it has loaded,
// and `bottom`, an expression for the viewport y where the capture ends, so
// it is cut at a section edge. `scale` is how many canvas pixels one CSS
// pixel gets (never below 1: text is at least as large as in the browser).
const POPUP = { page: 'popup.html', width: 384, scale: 1.5 };
const SHOTS = [
  {
    ...POPUP, theme: 'light',
    headline: 'Collect the pages you want indexed',
    text: 'Add the open tab, right-click a link or paste a list. The URLs wait in this browser until you send them.',
    local: {
      apiKey: FAKE_KEY, keyInfo: keyInfo(ALL_SCOPES),
      urlList: [
        'https://example.com/blog/pour-over-guide/',
        'https://example.com/pricing/',
        'https://example.com/changelog/2026-11/',
        'https://example.org/docs/quick-start/',
      ],
    },
    activeTab: 'https://example.com/blog/grind-size/',
    steps: `
      click('add-page');
      await until(() => !$('add-page-note').hidden && $('list-count').textContent === '5');
    `,
    bottom: "$('url-list').getBoundingClientRect().bottom + 12",
  },
  {
    ...POPUP, theme: 'light',
    headline: 'A free draft first',
    text: 'Send the list as a draft order with one click. Nothing is charged until you decide to run it.',
    local: { apiKey: FAKE_KEY, keyInfo: keyInfo(ALL_SCOPES), urlList: blog.map((s) => `https://example.com/blog/${s}/`) },
    steps: `
      $('title').value = 'Blog posts – November';
      click('create-draft');
      await until(() => document.querySelector('.notice.is-ok') && $('orders').children.length === 6);
    `,
    bottom: "$('messages').getBoundingClientRect().bottom + 16",
  },
  {
    ...POPUP, theme: 'light',
    headline: 'You confirm every charge',
    text: 'Before a run you see the number of URLs, the cost and your balance after it. Or keep the order as a draft.',
    local: { apiKey: FAKE_KEY, keyInfo: keyInfo(ALL_SCOPES), urlList: products.map((s) => `https://example.com/products/${s}/`) },
    steps: `
      $('title').value = 'New product pages';
      click('create-run');
      await until(() => !$('confirm').hidden && /^\\$/.test($('q-balance').textContent));
      document.activeElement?.blur();
    `,
    bottom: "$('confirm').getBoundingClientRect().bottom + 16",
  },
  {
    ...POPUP, theme: 'dark',
    headline: 'Follow the order',
    text: 'Recent orders show status, progress and cost. Each one opens in the dashboard.',
    local: { apiKey: FAKE_KEY, keyInfo: keyInfo(ALL_SCOPES), urlList: [] },
    // The spacer below the capture lets the list scroll up under the header,
    // as it does in a popup that is shorter than its content.
    steps: `
      document.body.style.paddingBottom = '600px';
      const head = document.querySelector('.top').getBoundingClientRect().height;
      const panel = $('orders-title').closest('.panel');
      window.scrollTo(0, panel.getBoundingClientRect().top + window.scrollY - head - 12);
    `,
    bottom: "document.querySelectorAll('#orders .order')[3].getBoundingClientRect().bottom + 4",
  },
  {
    page: 'options.html', width: 600, scale: 1.2, theme: 'light',
    headline: 'Your own key, your own limits',
    text: 'Paste a key from your dashboard and see what it may do. Without orders:run it can only create drafts.',
    local: { apiKey: FAKE_KEY, keyInfo: keyInfo(['orders:read', 'orders:write', 'balance:read']) },
    account: account(['orders:read', 'orders:write', 'balance:read']),
    steps: '',
    bottom: "$('key-title').closest('.card').getBoundingClientRect().bottom + 24",
  },
];

// ── Stubs injected before the page's own scripts ───────────

function installStubs(fx) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const listeners = [];
  const fire = (changes, area) => setTimeout(() => listeners.forEach((fn) => fn(changes, area)), 0);
  const makeArea = (name, data) => ({
    async get(keys) {
      if (keys === undefined || keys === null) return clone(data);
      const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        if (k in data) out[k] = clone(data[k]);
        else if (k in defaults) out[k] = defaults[k];
      }
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data[k], newValue: clone(v) };
        data[k] = clone(v);
      }
      fire(changes, name);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; }
      }
      fire(changes, name);
    },
  });

  window.chrome = {
    runtime: { id: 'store-screenshots', openOptionsPage() {} },
    tabs: { async query() { return fx.activeTab ? [{ id: 1, active: true, url: fx.activeTab }] : []; } },
    storage: {
      local: makeArea('local', clone(fx.local)),
      session: makeArea('session', {}),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };

  const API = 'https://api.index-pages.com/v1';
  const orders = clone(fx.orders);
  const newIds = ['k3j4h5g6f7d8s9a0', 'm2n8b4v6c1x9z5l7'];
  const json = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
  const problem = (status, code, title, detail) => json(status, { type: `https://index-pages.com/api/#err-${code}`, title, status, detail, code });
  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!url.href.startsWith(`${API}/`)) return realFetch(input, init);
    const path = url.pathname.slice('/v1'.length);
    const method = (init.method || 'GET').toUpperCase();
    await new Promise((r) => setTimeout(r, 30));

    if (method === 'GET' && path === '/account') return json(200, fx.account);
    if (method === 'GET' && path === '/orders') {
      const limit = Number(url.searchParams.get('limit') || 25);
      return json(200, { data: orders.slice(0, limit), next_cursor: null, has_more: orders.length > limit });
    }
    if (method === 'POST' && path === '/orders') {
      const body = JSON.parse(init.body || '{}');
      if (!Array.isArray(body.urls) || !body.urls.length) {
        return json(422, { type: 'https://index-pages.com/api/#err-validation_failed', title: 'Validation failed', status: 422, detail: 'The urls field is required.', code: 'validation_failed', errors: [{ field: 'urls', message: 'The urls field is required.' }] });
      }
      const n = body.urls.length;
      const o = {
        id: newIds.shift(), title: body.title || 'Untitled Order', comment: body.comment ?? null,
        status: 'draft', urls_total: n, urls_done: 0,
        price_per_url: fx.account.price_per_url, cost: `${n * Number(fx.account.price_per_url.split('.')[0])}.00`, currency: 'USD',
        created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), started_at: null, campaign_ends_at: null,
      };
      orders.unshift(o);
      return json(201, o);
    }
    const m = /^\/orders\/([a-z0-9]{16})(\/run)?$/.exec(path);
    const o = m && orders.find((x) => x.id === m[1]);
    if (!o) return problem(404, 'not_found', 'Not found', 'No order with this id.');
    if (method === 'GET' && !m[2]) return json(200, o);
    if (method === 'DELETE' && !m[2]) {
      orders.splice(orders.indexOf(o), 1);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && m[2]) {
      Object.assign(o, { status: 'in_progress', started_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
      return json(200, o);
    }
    return problem(405, 'method_not_allowed', 'Method not allowed', 'This method is not allowed here.');
  };

  for (const f of fx.fonts) document.fonts.add(new FontFace(f.family, `url(/__fonts/${f.file}) format("woff2")`, { weight: f.weight }));

  window.__shot = {
    $: (id) => document.getElementById(id),
    click: (id) => document.getElementById(id).click(),
    async until(test, ms = 5000) {
      const end = Date.now() + ms;
      while (!test()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${test}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

// ── Static server: the extension, the font files, captures, the canvas ──

const work = mkdtempSync(join(process.env.SHOTS_TMP || tmpdir(), 'store-shots-'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

function within(base, rel) {
  const p = normalize(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

const pages = new Map();
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = null;
  if (pages.has(path)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pages.get(path));
    return;
  }
  if (path.startsWith('/__fonts/') && fontsDir) file = within(fontsDir, path.slice(9));
  else if (path.startsWith('/__work/')) file = within(work, path.slice(8));
  else if (!path.startsWith('/__')) file = within(ROOT, path.slice(1) || 'popup.html');
  if (!file || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// ── Chromium over the DevTools protocol ──────────────────────

const profile = join(work, 'profile');
// --password-store=basic: without it Chromium on a Linux desktop may wait on
// the system keyring before its first network request, and every page hangs.
const chrome = spawn(chromePath, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--password-store=basic', '--use-mock-keychain', '--disable-sync',
  '--disable-background-networking', '--disable-component-update',
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--force-color-profile=srgb', '--mute-audio', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) res(m[1]);
  });
  chrome.on('exit', (code) => rej(new Error(`Chromium exited (${code}):\n${buf}`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && waiting.has(msg.id)) {
    const { res, rej, method } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
    else res(msg.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej, method });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function capture(shot, index) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await send('Page.enable', {}, sessionId);
    // 600 is the tallest a Chrome popup gets; the options page is a tab.
    const metrics = { width: shot.width, height: shot.page === 'popup.html' ? 600 : 900, deviceScaleFactor: 2, mobile: false };
    await send('Emulation.setDeviceMetricsOverride', metrics, sessionId);
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: shot.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }],
    }, sessionId);
    const fx = {
      local: shot.local, activeTab: shot.activeTab || null,
      account: shot.account || account(), orders: ORDERS, fonts: FONTS,
    };
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installStubs})(${JSON.stringify(fx)});` }, sessionId);
    await send('Page.navigate', { url: `${origin}/${shot.page}` }, sessionId);
    const { bottom, scrollY } = await evaluate(sessionId, `(async () => {
      const { $, click, until } = window.__shot;
      await until(() => document.readyState === 'complete');
      ${shot.page === 'popup.html'
        ? "await until(() => !$('app').hidden && $('balance').textContent !== '–' && /^Updated/.test($('orders-status').textContent));"
        : "await until(() => !$('key-view').hidden);"}
      ${shot.steps}
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { bottom: ${shot.bottom}, scrollY: window.scrollY };
    })()`);
    // Cut the viewport at the section edge, as if the popup were that tall.
    const height = Math.min(metrics.height, Math.ceil(bottom));
    await send('Emulation.setDeviceMetricsOverride', { ...metrics, height }, sessionId);
    await evaluate(sessionId, `(async () => {
      window.scrollTo(0, ${scrollY});
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })()`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = join(work, `raw-${index}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    return { file, height };
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

// ── The 1280×800 canvas ──────────────────────────────────────

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function canvas(shot, raw) {
  // The capture is 2x; it is shown at `shot.scale` canvas pixels per CSS
  // pixel, less only if it would not fit, and never below 1.
  const maxH = 800 - 2 * 56;
  const scale = Math.max(1, Math.min(shot.scale, maxH / raw.height));
  if (raw.height * scale > maxH) throw new Error(`Shot "${shot.headline}" is too tall: cut it higher.`);
  const w = Math.round(shot.width * scale);
  const h = Math.round(raw.height * scale);
  const inter = FONTS.find((f) => f.family === 'Inter Tight');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
${inter ? `@font-face { font-family: "Inter Tight"; src: url(/__fonts/${inter.file}) format("woff2"); font-weight: 300 700; }` : ''}
html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
body {
  position: relative;
  background: linear-gradient(180deg, #0e141c 0%, #07080a 100%);
  font-family: ${inter ? '"Inter Tight", ' : ''}"DejaVu Sans", sans-serif;
  color: #e9eaec;
  -webkit-font-smoothing: antialiased;
}
.brand { position: absolute; left: 72px; top: 56px; display: flex; align-items: center; gap: 12px; font-size: 20px; font-weight: 500; letter-spacing: -0.01em; }
.brand img { width: 32px; height: 32px; display: block; }
.brand .dot { color: #7cc4ff; padding: 0 4px; }
.brand .second { color: #9aa3ad; }
.copy { position: absolute; left: 72px; top: 50%; transform: translateY(-50%); width: ${1280 - w - 64 - 72 - 56}px; }
h1 { margin: 0 0 20px; font-size: 46px; line-height: 1.1; font-weight: 600; letter-spacing: -0.02em; color: #e9eaec; }
p { margin: 0; font-size: 21px; line-height: 1.5; color: #9aa3ad; }
.shot {
  position: absolute; right: 64px; top: ${Math.round((800 - h) / 2)}px; width: ${w}px; height: ${h}px;
  border-radius: 14px; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(233, 234, 236, 0.10), 0 28px 64px rgba(0, 0, 0, 0.55);
}
.shot img { display: block; width: ${w}px; height: ${h}px; }
</style></head><body>
<div class="brand"><img src="/icons/logo.svg" alt=""><span>Index<span class="dot">·</span><span class="second">Pages</span></span></div>
<div class="copy"><h1>${esc(shot.headline)}</h1><p>${esc(shot.text)}</p></div>
<div class="shot"><img src="/__work/${raw.file.split(sep).pop()}" alt=""></div>
</body></html>`;
}

async function compose(shot, raw, index) {
  const path = `/__canvas/${index}.html`;
  pages.set(path, canvas(shot, raw));
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: origin + path }, sessionId);
    await evaluate(sessionId, `(async () => {
      while (document.readyState !== 'complete') await new Promise((r) => setTimeout(r, 25));
      await document.fonts.ready;
      await Promise.all([...document.images].map((i) => i.decode()));
    })()`);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const tmp = join(work, `canvas-${index}.png`);
    writeFileSync(tmp, Buffer.from(data, 'base64'));
    const out = join(OUT, `screenshot-${index}.png`);
    execFileSync('magick', [tmp, '-background', '#07080a', '-alpha', 'remove', '-alpha', 'off', '-strip',
      '-define', 'png:exclude-chunks=date,time', '-define', 'png:color-type=2', '-define', 'png:bit-depth=8', `PNG24:${out}`]);
    return out;
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}

// ── Run ──────────────────────────────────────────────────────

let failed = false;
try {
  for (const [i, shot] of SHOTS.entries()) {
    const raw = await capture(shot, i + 1);
    const out = await compose(shot, raw, i + 1);
    console.log(`${out.slice(ROOT.length + 1)}  ${shot.headline}`);
  }
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  ws.close();
  server.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    // Its helper processes may still write to the profile for a moment.
    await new Promise((r) => setTimeout(r, 500));
  }
  if (keep) console.log(`Work directory kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
