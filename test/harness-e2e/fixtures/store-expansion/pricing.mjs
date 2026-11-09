export const pricing = {
  checkout: ['checkoutTotal', `
import {quote} from './quote.js';

export function checkoutTotal(lines, basisPoints = 0, {expedited = false} = {}) {
  const total = quote(lines, basisPoints);
  const shippingCents = expedited ? 1299 : total < 5000 ? 499 : 0;
  return total + shippingCents;
}
`, `
  assert.equal(checkoutTotal([{priceCents: 2700, qty: 2}]), 5400);
  assert.equal(checkoutTotal([{priceCents: 2700, qty: 1}], 0, {expedited: true}), 3999);
`],
  currency: ['convertCents', `
import {linePrice} from './price.js';

export function convertCents(amountCents, numerator, denominator) {
  if (![numerator, denominator].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error('PRICING: Currency rates require positive integer terms');
  }
  return Math.round(linePrice(amountCents, numerator) / denominator);
}
`, `
  assert.equal(convertCents(1234, 7, 8), 1080);
  assert.throws(() => convertCents(1234, 7, 0), /^Error: PRICING:/);
`],
  markdown: ['markdownCents', `
import {linePrice} from './price.js';

export function markdownCents(listPriceCents, salePriceCents) {
  const savings = linePrice(listPriceCents, 1) - linePrice(salePriceCents, 1);
  if (savings < 0) throw new Error('PRICING: Sale price cannot exceed the list price');
  return savings;
}
`, `
  assert.equal(markdownCents(2000, 1549), 451);
  assert.throws(() => markdownCents(1000, 1200), /^Error: PRICING:/);
`],
  surcharge: ['addSurcharge', `
import {linePrice} from './price.js';

export function addSurcharge(totalCents, surchargeCents) {
  return linePrice(totalCents, 1) + linePrice(surchargeCents, 1);
}
`, `
  assert.equal(addSurcharge(2499, 250), 2749);
  assert.throws(() => addSurcharge(2499, -1), /^Error: PRICING:/);
`],
  rounding: ['roundToNickel', `
import {linePrice} from './price.js';

export function roundToNickel(amountCents) {
  return Math.round(linePrice(amountCents, 1) / 5) * 5;
}
`, `
  assert.equal(roundToNickel(1302), 1300);
  assert.equal(roundToNickel(1303), 1305);
`],
  volume: ['volumeUnitPrice', `
import {linePrice} from './price.js';

export function volumeUnitPrice(priceCents, quantity) {
  linePrice(priceCents, quantity);
  return quantity >= 10 ? Math.round(priceCents * 90 / 100) : priceCents;
}
`, `
  assert.equal(volumeUnitPrice(125, 9), 125);
  assert.equal(volumeUnitPrice(125, 10), 113);
`],
  bundle: ['bundlePrice', `
import {linePrice} from './price.js';
import {quote} from './quote.js';

export function bundlePrice(lines, maximumCents) {
  if (lines.length < 2) throw new Error('PRICING: A bundle must contain multiple lines');
  return Math.min(quote(lines), linePrice(maximumCents, 1));
}
`, `
  const lines = [{priceCents: 1400, qty: 1}, {priceCents: 800, qty: 2}];
  assert.equal(bundlePrice(lines, 2400), 2400);
`],
  'tier-rate': ['tierBasisPoints', `
const discounts = {standard: 0, silver: 500, gold: 1000};

export function tierBasisPoints(tier) {
  if (!Object.hasOwn(discounts, tier)) throw new Error('PRICING: Unknown customer tier');
  return discounts[tier];
}
`, `
  assert.equal(tierBasisPoints('silver'), 500);
  assert.throws(() => tierBasisPoints('premium'), /^Error: PRICING:/);
`],
  'line-credit': ['lineCredit', `
import {linePrice} from './price.js';

export function lineCredit(line, returnedQuantity) {
  if (returnedQuantity > line.qty) throw new Error('PRICING: Credit cannot exceed ordered quantity');
  return linePrice(line.priceCents, returnedQuantity);
}
`, `
  const line = {priceCents: 450, qty: 3};
  assert.equal(lineCredit(line, 2), 900);
  assert.throws(() => lineCredit(line, 4), /^Error: PRICING:/);
`],
  fees: ['paymentFeeCents', `
import {linePrice} from './price.js';

export function paymentFeeCents(subtotalCents, method) {
  const subtotal = linePrice(subtotalCents, 1);
  if (method === 'bank') return 0;
  if (method === 'card') return Math.round(subtotal * 29 / 1000) + 30;
  throw new Error('PRICING: Unknown payment method');
}
`, `
  assert.equal(paymentFeeCents(2000, 'card'), 88);
  assert.equal(paymentFeeCents(2000, 'bank'), 0);
`],
  allocation: ['splitCents', `
import {linePrice} from './price.js';

export function splitCents(totalCents, parts) {
  const total = linePrice(totalCents, 1);
  if (!Number.isInteger(parts) || parts < 1 || parts > 1000) {
    throw new Error('PRICING: Choose between 1 and 1000 parts');
  }
  const base = Math.floor(total / parts);
  const remainder = total % parts;
  return Array.from({length: parts}, (_, i) => base + Number(i < remainder));
}
`, `
  assert.deepEqual(splitCents(100, 3), [34, 33, 33]);
`],
  'gift-card': ['applyGiftCard', `
import {linePrice} from './price.js';

export function applyGiftCard(totalCents, balanceCents) {
  const total = linePrice(totalCents, 1);
  const balance = linePrice(balanceCents, 1);
  const usedCents = Math.min(total, balance);
  return {usedCents, amountDueCents: total - usedCents, balanceCents: balance - usedCents};
}
`, `
  assert.deepEqual(applyGiftCard(500, 1200), {usedCents: 500, amountDueCents: 0, balanceCents: 700});
`],
  tax: ['taxCents', `
import {linePrice} from './price.js';

export function taxCents(subtotalCents, basisPoints) {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new Error('PRICING: Tax rate must be between 0 and 10000 basis points');
  }
  return Math.round(linePrice(subtotalCents, 1) * basisPoints / 10000);
}
`, `
  assert.equal(taxCents(1299, 825), 107);
`],
  deposit: ['depositCents', `
import {linePrice} from './price.js';

export function depositCents(totalCents, percentage) {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error('PRICING: Deposit percentage must be between 0 and 100');
  }
  return Math.ceil(linePrice(totalCents, 1) * percentage / 100);
}
`, `
  assert.equal(depositCents(301, 20), 61);
  assert.throws(() => depositCents(301, 101), /^Error: PRICING:/);
`],
  'per-unit': ['effectiveUnitPrice', `
import {linePrice} from './price.js';

export function effectiveUnitPrice(totalCents, quantity) {
  linePrice(totalCents, quantity);
  return Math.round(totalCents / quantity);
}
`, `
  assert.equal(effectiveUnitPrice(799, 3), 266);
  assert.throws(() => effectiveUnitPrice(799, 0), /^Error: PRICING:/);
`],
};
