import {DomainError} from '../error.js';

export function findProduct(products, sku) {
  const product = products.find(entry => entry.sku === sku && entry.active);
  if (!product) throw new DomainError('SKU_NOT_FOUND', 'Active product not found');
  return product;
}
