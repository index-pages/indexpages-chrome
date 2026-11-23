// Service worker: context menu entries and the toolbar badge. It never calls
// the API – it only adds URLs to the local list, which the popup sends.

import { K, addToList, getList } from './lib/storage.js';

const MENU_LINK = 'add-link';
const MENU_PAGE = 'add-page';
const WEB = ['http://*/*', 'https://*/*'];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: 'Add link to Index Pages list',
      contexts: ['link'],
      targetUrlPatterns: WEB,
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'Add this page to Index Pages list',
      contexts: ['page'],
      documentUrlPatterns: WEB,
    });
  });
}

async function updateBadge(count) {
  const n = count ?? (await getList()).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#7CC4FF' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#071018' });
  await chrome.action.setBadgeText({ text: n > 0 ? (n > 999 ? '999+' : String(n)) : '' });
  await chrome.action.setTitle({ title: n > 0 ? `Index Pages – ${n} URL${n === 1 ? '' : 's'} in the list` : 'Index Pages' });
}

async function flash(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => { updateBadge(); }, 1500);
}

chrome.runtime.onInstalled.addListener(() => {
  createMenus();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.menuItemId === MENU_LINK ? info.linkUrl : info.menuItemId === MENU_PAGE ? info.pageUrl : null;
  if (!url) return;
  const result = await addToList([url]);
  if (result.added.length) return;
  // Nothing added: say why on the icon for a moment instead of failing silently.
  if (result.duplicates.length) await flash('dup', '#9097A2');
  else await flash('!', '#F0888C');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && K.urls in changes) {
    const list = changes[K.urls].newValue;
    updateBadge(Array.isArray(list) ? list.length : 0);
  }
});
