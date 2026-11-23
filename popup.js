import { ApiClient, ApiError, capabilities, SCOPES } from './lib/api.js';
import { loadApiBase, orderDashboardUrl, TOPUP_URL } from './lib/config.js';
import { describeError } from './lib/problem.js';
import { costCents, formatMoney, quote, toCents } from './lib/money.js';
import { describeMerge, splitUrlText } from './lib/urls.js';
import { sha256Hex, storeFrom, withIdempotency } from './lib/idempotency.js';
import * as store from './lib/storage.js';

const $ = (id) => document.getElementById(id);

const state = {
  client: null,
  caps: capabilities([]),
  account: null,
  list: [],
  rejected: new Map(),
  pendingRun: null,
  busy: false,
};

const idemStore = storeFrom(store.sessionArea());

const STATUS_LABEL = { draft: 'Draft', in_progress: 'In progress', done: 'Done', error: 'Error' };

// ── DOM helpers ───────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function externalLink(text, href, cls) {
  return el('a', { href, target: '_blank', rel: 'noopener', class: cls }, text, el('span', { 'aria-hidden': 'true', text: ' ↗' }));
}

function clearMessages() {
  $('messages').replaceChildren();
}

/** kind: fault | ok | caution | info */
function notice(kind, { title, body, details = [], actions = [] }) {
  const box = el('div', { class: `notice is-${kind}`, role: kind === 'fault' ? 'alert' : null });
  if (title) box.append(el('p', { class: 'notice-title', text: title }));
  if (body) box.append(el('p', { class: 'notice-body', text: body }));
  if (details.length) {
    const shown = details.slice(0, 8);
    const ul = el('ul', { class: 'notice-list' }, ...shown.map((d) => el('li', { text: d })));
    if (details.length > shown.length) ul.append(el('li', { text: `…and ${details.length - shown.length} more.` }));
    box.append(ul);
  }
  if (actions.length) box.append(el('div', { class: 'notice-actions' }, ...actions));
  box.append(el('button', {
    type: 'button', class: 'btn btn-small btn-quiet notice-close', 'aria-label': 'Dismiss message',
    onclick: () => box.remove(),
  }, 'Dismiss'));
  $('messages').replaceChildren(box);
  return box;
}

function showError(err, ctx) {
  const d = describeError(err, ctx);
  const actions = [];
  if (d.action?.kind === 'settings') {
    actions.push(el('button', { type: 'button', class: 'btn btn-small', onclick: () => chrome.runtime.openOptionsPage() }, d.action.label));
  } else if (d.action?.url) {
    actions.push(externalLink(d.action.label, d.action.url, 'btn btn-small'));
  }
  notice('fault', { title: d.title, body: d.message, details: d.details, actions });
  return d;
}

function setBusy(busy) {
  state.busy = busy;
  document.body.setAttribute('aria-busy', busy ? 'true' : 'false');
  applyCaps();
  $('confirm-run').disabled = busy;
}

// ── Capabilities ──────────────────────────────────────────────

function applyCaps() {
  const c = state.caps;
  $('balance-note').hidden = c.readBalance;
  $('create-draft').disabled = state.busy || !c.createDrafts;
  $('create-run').hidden = !c.runOrders;
  $('create-run').disabled = state.busy || !c.createDrafts;
  $('actions-grid')?.classList.toggle('single', !c.runOrders);

  const note = $('write-note');
  if (!c.createDrafts) {
    note.textContent = 'This key has no orders:write scope: collect URLs here, but create orders in the dashboard.';
    note.hidden = false;
  } else if (!c.runOrders) {
    note.textContent = 'This key cannot spend money (no orders:run scope). Drafts created here are run in the dashboard.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  $('orders-note').hidden = c.readOrders;
  $('refresh-orders').hidden = !c.readOrders;
}

// ── Account ──────────────────────────────────────────────────

async function refreshAccount() {
  if (!state.caps.readBalance) {
    $('balance').textContent = '–';
    $('price').textContent = '–';
    return;
  }
  try {
    const account = await state.client.getAccount();
    state.account = account;
    $('balance').textContent = formatMoney(toCents(account.balance), account.currency);
    $('price').textContent = formatMoney(toCents(account.price_per_url), account.currency);
    await store.saveLimits(account.limits);
    const scopes = account.key?.scopes;
    if (Array.isArray(scopes)) {
      state.caps = capabilities(scopes);
      await store.updateKeyInfo({ scopes, name: account.key.name });
      applyCaps();
    }
    if (state.pendingRun) renderConfirm(state.pendingRun);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'forbidden_scope') {
      state.caps = { ...state.caps, readBalance: false };
      applyCaps();
      return;
    }
    showError(err);
  }
}

// ── URL list ─────────────────────────────────────────────────

function renderList() {
  const ul = $('url-list');
  ul.replaceChildren(...state.list.map((url) => {
    const reason = state.rejected.get(url);
    const li = el('li', { class: `url-item${reason ? ' is-rejected' : ''}` },
      el('span', { class: 'url-text', title: url, text: url }),
      el('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `Remove ${url}`, title: 'Remove',
        onclick: async () => {
          state.rejected.delete(url);
          await store.removeFromList(url);
          await loadList();
          $('add-page').focus();
        },
      }, removeIcon()));
    if (reason) li.append(el('span', { class: 'url-reason', text: reason }));
    return li;
  }));
  const n = state.list.length;
  $('list-count').textContent = String(n);
  $('list-count').setAttribute('aria-label', `${n} URL${n === 1 ? '' : 's'}`);
  $('list-empty').hidden = n > 0;
  $('clear-list').hidden = n === 0;
}

function removeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M4 4l8 8M12 4l-8 8');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  svg.append(path);
  return svg;
}

async function loadList() {
  state.list = await store.getList();
  renderList();
}

async function addThisPage() {
  const note = $('add-page-note');
  note.hidden = true;
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  if (!tab?.url) {
    note.textContent = 'This page’s address is not available to the extension.';
    note.hidden = false;
    return;
  }
  const result = await store.addToList([tab.url]);
  await loadList();
  if (result.added.length) note.textContent = 'Added.';
  else if (result.duplicates.length) note.textContent = 'This page is already in the list.';
  else if (result.overflow.length) note.textContent = 'The list is full for one order.';
  else note.textContent = `This page cannot be indexed: ${result.invalid[0]?.reason || 'not an http or https URL.'}`;
  note.hidden = false;
}

async function addPasted() {
  const area = $('paste');
  const tokens = splitUrlText(area.value);
  if (!tokens.length) {
    $('paste-result').textContent = 'Nothing to add.';
    return null;
  }
  const result = await store.addToList(tokens);
  await loadList();
  const limits = await store.getLimits();
  let text = describeMerge(result, { max: store.maxUrls(limits) });
  // Leave only what could not be added in the box, so it can be fixed.
  area.value = result.invalid.map((i) => i.input).join('\n');
  if (result.invalid.length) text += ' The skipped lines are left in the box.';
  $('paste-result').textContent = text;
  return result;
}

async function clearList() {
  const btn = $('clear-list');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Clear all?';
    setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Clear'; }, 4000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = 'Clear';
  state.rejected.clear();
  await store.setList([]);
  await loadList();
  $('add-page').focus();
}

// ── Create / run ─────────────────────────────────────────────

async function createOrder(andRun) {
  if (state.busy) return;
  clearMessages();
  if ($('paste').value.trim()) {
    const merged = await addPasted();
    if (merged && merged.invalid.length) {
      notice('caution', { title: 'Some lines were skipped', body: 'Fix or remove the lines left in the paste box, then try again.' });
      return;
    }
  }
  const urls = state.list.slice();
  if (!urls.length) {
    notice('caution', { title: 'The list is empty', body: 'Add this page or paste some URLs first.' });
    return;
  }
  const title = $('title').value.trim();
  const body = { urls };
  if (title) body.title = title;

  setBusy(true);
  try {
    const fingerprint = await sha256Hex(JSON.stringify(body));
    const order = await withIdempotency(idemStore, 'create', fingerprint,
      (idempotencyKey) => state.client.createOrder(body, { idempotencyKey }));
    state.rejected.clear();
    await store.removeSent(urls);
    await loadList();
    $('title').value = '';
    if (andRun) {
      state.pendingRun = order;
      await store.setPendingRun(order);
      renderConfirm(order);
    } else {
      notice('ok', {
        title: 'Draft created',
        body: `“${order.title}” with ${order.urls_total} URL${order.urls_total === 1 ? '' : 's'}. Nothing was charged.`,
        actions: [externalLink('Open in dashboard', orderDashboardUrl(order.id), 'btn btn-small')],
      });
    }
    refreshOrders();
  } catch (err) {
    const d = describeError(err, { urls });
    for (const r of d.rejected) if (r.url) state.rejected.set(r.url, r.message);
    renderList();
    showError(err, { urls });
  } finally {
    setBusy(false);
  }
}

function renderConfirm(order) {
  const section = $('confirm');
  const currency = order.currency || 'USD';
  const local = costCents(order.urls_total, order.price_per_url);
  const server = toCents(order.cost);
  const cost = server ?? local;
  const q = quote(cost, state.caps.readBalance ? state.account?.balance ?? null : null);

  $('confirm-order').textContent = `“${order.title}” – draft ${order.id}`;
  $('q-count').textContent = String(order.urls_total);
  $('q-price').textContent = formatMoney(toCents(order.price_per_url), currency);
  $('q-cost').textContent = formatMoney(cost, currency);
  $('q-balance').textContent = q.balance === null ? (state.caps.readBalance ? 'Loading…' : 'Not visible to this key') : formatMoney(q.balance, currency);
  $('q-after').textContent = q.after === null ? '–' : formatMoney(q.after, currency);

  const warning = $('confirm-warning');
  const short = q.enough === false;
  warning.hidden = !short;
  if (short) warning.textContent = `Your balance is ${formatMoney(cost - q.balance, currency)} short. Top up, then run the draft from Recent orders.`;
  if (!short && local !== null && server !== null && local !== server) {
    warning.hidden = false;
    warning.textContent = `Charged at the order’s own price: ${formatMoney(server, currency)}.`;
  }
  $('confirm-run').hidden = short;
  $('confirm-run').textContent = `Pay ${formatMoney(cost, currency)} and run`;
  $('confirm-topup').hidden = !short;

  const wasHidden = section.hidden;
  section.hidden = false;
  if (wasHidden) {
    section.focus();
    section.scrollIntoView({ block: 'nearest' });
  }
}

async function hideConfirm() {
  state.pendingRun = null;
  $('confirm').hidden = true;
  await store.clearPendingRun();
}

async function runConfirmed() {
  const order = state.pendingRun;
  if (!order || state.busy) return;
  clearMessages();
  setBusy(true);
  try {
    const result = await withIdempotency(idemStore, `run:${order.id}`, order.id,
      (idempotencyKey) => state.client.runOrder(order.id, { idempotencyKey }));
    await hideConfirm();
    notice('ok', {
      title: 'Order started',
      body: `“${result.title}” is running. ${formatMoney(toCents(result.cost), result.currency)} was charged.`,
      actions: [externalLink('Follow it in the dashboard', orderDashboardUrl(result.id), 'btn btn-small')],
    });
    refreshAccount();
    refreshOrders();
  } catch (err) {
    const d = showError(err);
    if (d.code === 'order_not_executable' || d.code === 'not_found') {
      await hideConfirm();
      refreshOrders();
    } else if (d.code === 'insufficient_balance') {
      if (state.account && err.problem?.available) state.account = { ...state.account, balance: err.problem.available };
      renderConfirm(order);
    }
  } finally {
    setBusy(false);
  }
}

async function keepDraft() {
  const order = state.pendingRun;
  await hideConfirm();
  if (order) {
    notice('info', {
      title: 'Kept as a draft',
      body: 'Nothing was charged. Run it later from Recent orders or the dashboard.',
      actions: [externalLink('Open in dashboard', orderDashboardUrl(order.id), 'btn btn-small')],
    });
  }
}

// ── Orders ───────────────────────────────────────────────────

let ordersSeq = 0;

async function refreshOrders() {
  if (!state.caps.readOrders) {
    $('orders').replaceChildren();
    return;
  }
  const seq = ++ordersSeq;
  const status = $('orders-status');
  status.textContent = 'Loading…';
  try {
    const page = await state.client.listOrders({ limit: 10 });
    if (seq !== ordersSeq) return;
    const orders = Array.isArray(page?.data) ? page.data : [];
    $('orders').replaceChildren(...orders.map(renderOrder));
    status.textContent = orders.length ? `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.` : 'No orders yet.';
  } catch (err) {
    if (seq !== ordersSeq) return;
    status.textContent = 'Could not load orders.';
    if (err instanceof ApiError && err.code === 'forbidden_scope') {
      state.caps = { ...state.caps, readOrders: false };
      applyCaps();
      $('orders').replaceChildren();
      status.textContent = '';
      return;
    }
    showError(err);
  }
}

function renderOrder(order) {
  const label = STATUS_LABEL[order.status] || order.status;
  const total = order.urls_total || 0;
  const done = Math.min(order.urls_done || 0, total);
  const created = order.created_at ? new Date(order.created_at) : null;
  const when = created && !Number.isNaN(created.getTime())
    ? created.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '';

  const li = el('li', { class: 'order' },
    el('div', { class: 'order-line' },
      el('a', {
        class: 'order-title', href: orderDashboardUrl(order.id), target: '_blank', rel: 'noopener',
        title: `${order.title} – open in the dashboard`, text: order.title,
      }),
      el('span', { class: `badge ${order.status}`, text: label })),
    el('div', { class: 'order-line' },
      el('span', { class: 'order-meta', text: [`${done} / ${total} URLs done`, formatMoney(toCents(order.cost), order.currency), when].filter(Boolean).join(' · ') })));

  if (order.status === 'in_progress' || order.status === 'done') {
    const pct = total ? Math.round((done / total) * 100) : 0;
    li.append(el('div', {
      class: 'progress', role: 'progressbar', 'aria-label': `${order.title} progress`,
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
    }, el('span', { style: `width: ${pct}%` })));
  }

  if (order.status === 'draft' && (state.caps.runOrders || state.caps.deleteDrafts)) {
    const actions = el('div', { class: 'order-actions' });
    if (state.caps.runOrders) {
      actions.append(el('button', {
        type: 'button', class: 'btn btn-small', 'aria-label': `Run ${order.title}`,
        onclick: async () => {
          clearMessages();
          state.pendingRun = order;
          await store.setPendingRun(order);
          renderConfirm(order);
        },
      }, 'Run…'));
    }
    if (state.caps.deleteDrafts) {
      const del = el('button', { type: 'button', class: 'btn btn-small btn-risk', 'aria-label': `Delete draft ${order.title}` }, 'Delete');
      del.addEventListener('click', () => deleteDraft(order, del));
      actions.append(del);
    }
    li.append(actions);
  }
  return li;
}

async function deleteDraft(order, button) {
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = 'Confirm delete';
    setTimeout(() => {
      if (button.isConnected) { button.dataset.armed = ''; button.textContent = 'Delete'; }
    }, 4000);
    return;
  }
  button.disabled = true;
  clearMessages();
  try {
    await state.client.deleteOrder(order.id);
    if (state.pendingRun?.id === order.id) await hideConfirm();
    notice('ok', { title: 'Draft deleted', body: `“${order.title}” was removed.` });
  } catch (err) {
    showError(err);
  }
  refreshOrders();
}

// ── Start ────────────────────────────────────────────────────

async function init() {
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('setup-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const [{ key, info }, api] = await Promise.all([store.getKey(), loadApiBase()]);
  $('dev-flag').hidden = !api.dev;
  if (api.dev) $('dev-flag').title = `Using ${api.base}`;

  if (!key) {
    $('setup').hidden = false;
    return;
  }

  state.client = new ApiClient({ key, base: api.base });
  state.caps = capabilities(Array.isArray(info?.scopes) ? info.scopes : SCOPES);
  $('app').hidden = false;
  $('topup-link').href = TOPUP_URL;
  applyCaps();

  $('add-page').addEventListener('click', addThisPage);
  $('add-pasted').addEventListener('click', addPasted);
  $('clear-list').addEventListener('click', clearList);
  $('create-draft').addEventListener('click', () => createOrder(false));
  $('create-run').addEventListener('click', () => createOrder(true));
  $('confirm-run').addEventListener('click', runConfirmed);
  $('confirm-cancel').addEventListener('click', keepDraft);
  $('refresh-orders').addEventListener('click', () => { refreshOrders(); refreshAccount(); });
  $('paste').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addPasted(); }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && store.K.urls in changes) loadList();
  });

  await loadList();
  state.pendingRun = await store.getPendingRun();
  if (state.pendingRun) renderConfirm(state.pendingRun);
  refreshAccount();
  refreshOrders();
}

init().catch((err) => {
  $('app').hidden = false;
  notice('fault', { title: 'The extension could not start', body: String(err?.message || err) });
});
