export function linePrice(priceCents, quantity) {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new Error('PRICING: Price must be a nonnegative integer in cents');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('PRICING: Quantity must be a positive integer');
  }
  return priceCents * quantity;
}
