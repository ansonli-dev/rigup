import assert from 'node:assert/strict';
import test from 'node:test';
import {receiveStock, removeStock} from '../src/inventory/adjust.js';

const stock = {sku: 'BAG-1', onHand: 12, reserved: 4};

test('receives stock without changing reservations', () => {
  assert.deepEqual(receiveStock(stock, 3), {ok: true, value: {...stock, onHand: 15}});
});

test('cannot remove units that are already reserved', () => {
  const result = removeStock(stock, 9);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INSUFFICIENT_STOCK');
});
