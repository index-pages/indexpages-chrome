// Money arrives as decimal strings with two digits ("12.50") and is handled
// here as integer cents, so no float ever touches a price or a balance.

const MONEY = /^(\d+)\.(\d{2})$/;

/** "12.50" -> 1250. Returns null for anything that is not the API's money format. */
export function toCents(value) {
  if (typeof value !== 'string') return null;
  const m = MONEY.exec(value.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number(m[2]);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 1250 -> "12.50" */
export function centsToDecimal(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 1250, "USD" -> "$12.50"; other currencies -> "12.50 EUR". */
export function formatMoney(cents, currency = 'USD') {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '–';
  const decimal = centsToDecimal(cents);
  if (currency === 'USD') return decimal.startsWith('-') ? `-$${decimal.slice(1)}` : `$${decimal}`;
  return `${decimal} ${currency}`;
}

/** Cost of `count` URLs at `pricePerUrl` (money string), in cents; null when the price is unknown. */
export function costCents(count, pricePerUrl) {
  const price = toCents(pricePerUrl);
  if (price === null || !Number.isInteger(count) || count < 0) return null;
  return count * price;
}

/**
 * Compare a cost with the balance.
 * Returns { cost, balance, after, enough } in cents; `balance`, `after` and
 * `enough` are null when the balance is unknown (key without balance:read).
 */
export function quote(cost, balance) {
  const balanceCents = typeof balance === 'string' ? toCents(balance) : balance ?? null;
  if (cost === null || cost === undefined) return { cost: null, balance: balanceCents, after: null, enough: null };
  if (balanceCents === null) return { cost, balance: null, after: null, enough: null };
  return { cost, balance: balanceCents, after: balanceCents - cost, enough: balanceCents >= cost };
}
