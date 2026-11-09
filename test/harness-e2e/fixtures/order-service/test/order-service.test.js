import assert from 'node:assert/strict';
import test from 'node:test';
import {auditLog} from '../src/audit/log.js';
import {taxFor} from '../src/billing/tax.js';
import {DomainError} from '../src/error.js';
import {reconcileShipment} from '../src/jobs/reconcile.js';
import {operations} from '../src/orders/index.js';
import {orderTotalCents} from '../src/orders/total.js';
import {normalizeAddress} from '../src/shipping/address.js';

const order = {
  id: 'order-18',
  status: 'open',
  lines: [{sku: 'mug', qty: 2, priceCents: 600}],
};

test('creates an open order and calculates the line total', () => {
  const created = operations.create({...order, customerId: 'customer-6'});
  assert.deepEqual(created, order);
  assert.equal(orderTotalCents(created), 1200);
});

test('cancels an open order and rejects a shipped order', () => {
  assert.equal(operations.cancel(order).status, 'cancelled');
  assert.throws(
    () => operations.cancel({...order, status: 'shipped'}),
    error => error instanceof DomainError && error.code === 'ALREADY_SHIPPED',
  );
});

test('ships an open order and records an audit event', () => {
  assert.equal(operations.ship(order).status, 'shipped');
  assert.deepEqual(auditLog.at(-1), {type: 'order.shipped', orderId: order.id});
});

test('normalizes a five-digit shipping ZIP code', () => {
  assert.deepEqual(
    normalizeAddress({city: 'New York', postalCode: ' 10001 '}),
    {city: 'New York', postalCode: '10001'},
  );
});

test('applies the billing tax rate for a known ZIP code', () => {
  assert.equal(taxFor('10001', 200), 17.75);
});

test('a shipment reconciliation job reports a missing external ID', () => {
  assert.deepEqual(reconcileShipment({}), {ok: false, reason: 'NO_EXTERNAL_ID'});
});
