# Privacy statement

Index Pages extension for Chrome.

The extension exists to send URLs that you choose to your Index Pages account.

**What it sends, and where.** Only to `api.index-pages.com`, the Index Pages API, over HTTPS:

- your API key, in the `Authorization` header of each request;
- the URLs you put in the list (the current page when you click "Add this page", a link or page you pick from the right-click menu, or URLs you paste), and an optional order title, when you click "Create draft" or "Create and run".

The extension also reads your balance, price, key scopes and recent orders from the same API to show them in the popup.

**What it stores.** In this browser's local extension storage: the API key, its prefix, last four characters, name and scopes, the URL list, and the account's order limits. In session storage, cleared when the browser closes: an order waiting for your run confirmation and short-lived request identifiers that prevent duplicate orders. Nothing is synced to other devices. Removing the key in the extension settings, or removing the extension, deletes it from the browser.

**What it does not do.** No analytics, no tracking, no advertising, no cookies, no remote code. It does not read page content or your browsing history; it reads a page's address only when you ask it to add that page. It contacts no server other than `api.index-pages.com`. Links in the popup open the Index Pages website in a new tab only when you click them.

**Data handled by Index Pages.** What the API does with orders and keys is covered by the Index Pages privacy policy: https://index-pages.com/privacy/

**Contact.** support@index-pages.com

## Chrome Web Store data disclosure

Suggested answers for the "Data usage" form:

- **Authentication information** – yes: the API key, stored locally and sent to api.index-pages.com to authenticate requests.
- **Web history** – yes, conservatively: the addresses of pages and links the user explicitly adds to the list are sent to api.index-pages.com as part of an order. No other browsing data is read.
- **Financial and payment information** – no: the popup displays the account balance and order costs it reads from api.index-pages.com, but sends no payment data anywhere and keeps none beyond the open popup.
- All other categories (personally identifiable information, health, personal communications, location, user activity, website content) – no.

Certifications: the data is not sold to third parties, not used or transferred for purposes unrelated to the extension's single purpose, and not used or transferred to determine creditworthiness or for lending purposes.
