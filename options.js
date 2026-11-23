import { ApiClient, SCOPES, capabilities, looksLikeKey, maskKey } from './lib/api.js';
import { loadApiBase } from './lib/config.js';
import { describeError } from './lib/problem.js';
import * as store from './lib/storage.js';

const $ = (id) => document.getElementById(id);

const SCOPE_TEXT = {
  'balance:read': 'See the balance and the price per URL',
  'orders:read': 'List recent orders and their progress',
  'orders:write': 'Create and delete drafts',
  'orders:run': 'Run drafts – spends the balance, always after your confirmation',
};

let api = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function setStatus(kind, title, body, details = []) {
  const box = $('status');
  if (!kind) {
    box.replaceChildren();
    return;
  }
  const n = el('div', { class: `notice is-${kind}` },
    el('p', { class: 'notice-title', text: title }));
  if (body) n.append(el('p', { class: 'notice-body', text: body }));
  if (details.length) n.append(el('ul', { class: 'notice-list' }, ...details.map((d) => el('li', { text: d }))));
  box.replaceChildren(n);
}

function summary(scopes) {
  const c = capabilities(scopes);
  if (!c.createDrafts) return 'This key cannot create orders. The popup can collect URLs, but orders have to be created in the dashboard.';
  if (!c.runOrders) return 'This key creates drafts but cannot spend money. Run drafts in the dashboard.';
  return 'This key can create and run orders. Every run asks you to confirm the cost first.';
}

async function render() {
  const { key, info } = await store.getKey();
  setStatus(null);
  if (!key) {
    $('key-view').hidden = true;
    $('key-form').hidden = false;
    $('cancel-replace').hidden = true;
    return;
  }
  $('key-view').hidden = false;
  $('key-form').hidden = true;
  $('key-mask').textContent = maskKey(key);
  $('key-name').textContent = info?.name || 'Not visible to this key (needs balance:read)';
  $('key-checked').textContent = info?.verifiedAt
    ? new Date(info.verifiedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : '–';
  const scopes = Array.isArray(info?.scopes) ? info.scopes : [];
  $('key-scopes').replaceChildren(...SCOPES.map((s) => {
    const on = scopes.includes(s);
    return el('li', { class: `scope ${on ? 'is-on' : 'is-off'}` },
      el('span', { class: 'scope-mark', 'aria-hidden': 'true', text: on ? '✓' : '–' }),
      el('code', { text: s }),
      el('span', { class: 'scope-what', text: `${SCOPE_TEXT[s]}${on ? '' : ' (not granted)'}` }));
  }));
  $('key-summary').textContent = summary(scopes);
}

async function verifyAndSave(key) {
  const client = new ApiClient({ key, base: api.base });
  const result = await client.verify();
  const info = {
    prefix: key.slice(0, 13),
    last4: key.slice(-4),
    name: result.key?.name ?? null,
    scopes: result.scopes,
    source: result.source,
    verifiedAt: new Date().toISOString(),
  };
  await store.saveKey(key, info);
  if (result.account?.limits) await store.saveLimits(result.account.limits);
  return info;
}

async function onSubmit(event) {
  event.preventDefault();
  const input = $('key-input');
  const key = input.value.trim();
  $('key-error').textContent = '';
  input.removeAttribute('aria-invalid');
  if (!looksLikeKey(key)) {
    $('key-error').textContent = 'That does not look like an Index Pages API key. It starts with ipk_live_ followed by 40 letters and digits.';
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  const button = $('save');
  button.disabled = true;
  setStatus('info', 'Checking the key…', `Asking ${new URL(api.base).host} what this key may do.`);
  try {
    const info = await verifyAndSave(key);
    input.value = '';
    await render();
    setStatus('ok', 'Key saved', `Granted scopes: ${info.scopes.length ? info.scopes.join(', ') : 'none'}.`);
    $('recheck').focus();
  } catch (err) {
    const d = describeError(err);
    $('key-error').textContent = [d.title, d.message].filter(Boolean).join('. ');
    input.setAttribute('aria-invalid', 'true');
    setStatus(null);
    input.focus();
  } finally {
    button.disabled = false;
  }
}

async function recheck() {
  const { key } = await store.getKey();
  if (!key) return render();
  $('recheck').disabled = true;
  setStatus('info', 'Checking the key…');
  try {
    const info = await verifyAndSave(key);
    await render();
    setStatus('ok', 'Key is valid', `Granted scopes: ${info.scopes.length ? info.scopes.join(', ') : 'none'}.`);
  } catch (err) {
    const d = describeError(err);
    setStatus('fault', d.title, d.message, d.details);
  } finally {
    $('recheck').disabled = false;
  }
}

async function removeKey() {
  const button = $('remove');
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = 'Click again to remove';
    setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Remove key'; }, 5000);
    return;
  }
  button.dataset.armed = '';
  button.textContent = 'Remove key';
  await store.removeKey();
  await render();
  setStatus('ok', 'Key removed', 'The key was deleted from this browser. It is still active on your account – revoke it in the dashboard if you no longer need it.');
  $('key-input').focus();
}

function showReplace() {
  $('key-form').hidden = false;
  $('cancel-replace').hidden = false;
  $('key-input').focus();
}

function cancelReplace() {
  $('key-form').hidden = true;
  $('key-input').value = '';
  $('key-error').textContent = '';
  $('replace').focus();
}

function toggleKey() {
  const input = $('key-input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? 'Hide' : 'Show';
  $('toggle-key').setAttribute('aria-pressed', String(show));
}

async function init() {
  api = await loadApiBase();
  if (api.dev) {
    $('dev-note').hidden = false;
    $('dev-note-body').textContent = `Requests go to ${api.base}, not to the production API. Remove the apiBase key from the extension’s local storage to switch back.`;
    $('api-host').textContent = new URL(api.base).host;
  } else if (api.rejected) {
    $('dev-note').hidden = false;
    $('dev-note-body').textContent = 'A stored apiBase override was ignored because it is not an https URL or a loopback address.';
  }
  $('key-form').addEventListener('submit', onSubmit);
  $('toggle-key').addEventListener('click', toggleKey);
  $('recheck').addEventListener('click', recheck);
  $('replace').addEventListener('click', showReplace);
  $('cancel-replace').addEventListener('click', cancelReplace);
  $('remove').addEventListener('click', removeKey);
  await render();
}

init();
