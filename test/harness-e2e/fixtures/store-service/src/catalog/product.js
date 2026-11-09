import {DomainError} from '../error.js';

export function makeProduct({sku, name}) {
  if (!sku) throw new DomainError('SKU_REQUIRED', 'A product requires a SKU');
  if (!name) throw new DomainError('PRODUCT_NAME_REQUIRED', 'A product requires a name');
  return {sku, name, active: true};
}
