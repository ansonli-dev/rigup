import assert from 'node:assert/strict';
import test from 'node:test';
import {quote} from '../src/pricing/quote.js';

test('quotes a discount in cents', () => {
  assert.equal(quote([{priceCents: 800, qty: 2}], 500), 1520);
});

test('rejects a discount outside the supported range', () => {
  assert.throws(() => quote([{priceCents: 800, qty: 2}], 10001), /^Error: PRICING:/);
});
