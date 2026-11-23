import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, centsToDecimal, formatMoney, costCents, quote } from '../lib/money.js';

test('toCents parses the API money format only', () => {
  assert.equal(toCents('12.50'), 1250);
  assert.equal(toCents('0.00'), 0);
  assert.equal(toCents('1000.07'), 100007);
  assert.equal(toCents('12.5'), null);
  assert.equal(toCents('-1.00'), null);
  assert.equal(toCents('1e3'), null);
  assert.equal(toCents(12.5), null);
  assert.equal(toCents(null), null);
});

test('formatting', () => {
  assert.equal(centsToDecimal(5), '0.05');
  assert.equal(centsToDecimal(-250), '-2.50');
  assert.equal(formatMoney(2500), '$25.00');
  assert.equal(formatMoney(-250), '-$2.50');
  assert.equal(formatMoney(2500, 'EUR'), '25.00 EUR');
  assert.equal(formatMoney(null), '–');
});

test('cost is count × price in integer cents, no float drift', () => {
  assert.equal(costCents(3, '1.00'), 300);
  assert.equal(costCents(3, '0.10'), 30);
  assert.equal(costCents(1000, '0.07'), 7000);
  assert.equal(costCents(0, '1.00'), 0);
  assert.equal(costCents(2, 'abc'), null);
  assert.equal(costCents(1.5, '1.00'), null);
});

test('quote compares cost with balance', () => {
  assert.deepEqual(quote(100, '25.00'), { cost: 100, balance: 2500, after: 2400, enough: true });
  assert.deepEqual(quote(2500, '25.00'), { cost: 2500, balance: 2500, after: 0, enough: true });
  assert.deepEqual(quote(2600, '25.00'), { cost: 2600, balance: 2500, after: -100, enough: false });
  assert.deepEqual(quote(100, null), { cost: 100, balance: null, after: null, enough: null });
  assert.deepEqual(quote(null, '25.00'), { cost: null, balance: 2500, after: null, enough: null });
});
