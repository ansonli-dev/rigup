import {discountCents} from './discount.js';
import {linePrice} from './price.js';

export function quote(lines, basisPoints = 0) {
  const subtotalCents = lines.reduce((sum, line) => sum + linePrice(line.priceCents, line.qty), 0);
  return subtotalCents - discountCents(subtotalCents, basisPoints);
}
