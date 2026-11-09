export function discountCents(subtotalCents, basisPoints) {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
    throw new Error('PRICING: Discount must be between 0 and 10000 basis points');
  }
  return Math.round(subtotalCents * basisPoints / 10000);
}
