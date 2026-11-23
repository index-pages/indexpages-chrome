# Permission justifications

Text for the Privacy practices tab of the Chrome Web Store dashboard, one
line per field.

**activeTab** – Reads the address of the current tab only when the user clicks "Add this page" in the popup or picks an entry from the right-click menu, so that page can be added to the list of URLs to submit. No access to other tabs or to page content.

**storage** – Keeps the user's API key, the list of URLs waiting to be submitted and the last known order limits in local extension storage, and a pending run confirmation in session storage. Nothing is synced.

**contextMenus** – Adds two right-click entries, "Add link to Index Pages list" on links and "Add this page to Index Pages list" on pages, which put that URL into the local list.

**Host permission https://api.index-pages.com/*** – The Index Pages API does not send CORS headers; the extension needs this host permission to call it with the user's API key: verify the key, read the balance and orders, create a draft, run it after confirmation, delete a draft. No other host is contacted.

**Remote code** – No. All JavaScript is in the package; the extension loads no remote scripts, uses no eval and has no content scripts.
