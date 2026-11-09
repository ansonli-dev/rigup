import assert from 'node:assert/strict';
import test from 'node:test';
import {findProduct, makeProduct} from '../src/catalog/index.js';
import {DomainError} from '../src/error.js';

test('finds an active product by SKU', () => {
  const product = makeProduct({sku: 'BAG-1', name: 'Tote bag'});
  assert.equal(findProduct([product], 'BAG-1'), product);
});

test('reports a missing active product', () => {
  assert.throws(() => findProduct([], 'BAG-1'), error => error instanceof DomainError && error.code === 'SKU_NOT_FOUND');
});
