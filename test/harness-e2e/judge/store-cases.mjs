import assert from 'node:assert/strict';

const stock = Object.freeze({sku: 'BAG-18', onHand: 15, reserved: 6});

export const storeCases = {
  T7: {final: {
    'reserve.success': async load => {
      const {reserveStock} = await load('inventory/reserve.js');
      assert.deepEqual(reserveStock(stock, 3), {ok: true, value: {...stock, reserved: 9}});
    },
    'reserve.exact-available': async load => {
      const {reserveStock} = await load('inventory/reserve.js');
      assert.deepEqual(reserveStock(stock, 9), {ok: true, value: {...stock, reserved: 15}});
    },
    'reserve.invalid-quantity': async load => {
      const {reserveStock} = await load('inventory/reserve.js');
      for (const quantity of [0, -1, 1.5, '2', NaN]) {
        const result = reserveStock(stock, quantity);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'INVALID_QTY');
      }
    },
    'reserve.insufficient-stock': async load => {
      const {reserveStock} = await load('inventory/reserve.js');
      const result = reserveStock(stock, 10);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'INSUFFICIENT_STOCK');
    },
    'catalog.domain-error': async load => {
      const {findProduct} = await load('catalog/index.js');
      const {DomainError} = await load('error.js');
      assert.throws(
        () => findProduct([{sku: 'BAG-18', active: false}], 'BAG-18'),
        error => error instanceof DomainError && error.code === 'SKU_NOT_FOUND',
      );
    },
    'pricing.prefixed-error': async load => {
      const {quote} = await load('pricing/quote.js');
      assert.throws(
        () => quote([{priceCents: -100, qty: 1}]),
        error => error.constructor === Error && /^PRICING:/.test(error.message),
      );
    },
    'inventory.existing-result': async load => {
      const {receiveStock, removeStock} = await load('inventory/adjust.js');
      assert.deepEqual(receiveStock(stock, 2), {ok: true, value: {...stock, onHand: 17}});
      const result = removeStock(stock, 10);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'INSUFFICIENT_STOCK');
    },
  }},
};
