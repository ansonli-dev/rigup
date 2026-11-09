import assert from 'node:assert/strict';

function order(status = 'open', extra = {}) {
  return {
    id: 'order-41',
    status,
    lines: [
      {sku: 'mug', qty: 2, priceCents: 400},
      {sku: 'book', qty: 1, priceCents: 400},
    ],
    ...extra,
  };
}

async function domainError(load, code) {
  const {DomainError} = await load('error.js');
  return error => error instanceof DomainError
    && (code === undefined
      ? typeof error.code === 'string' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(error.code)
      : error.code === code);
}

const cancellation = {
  'cancel.already-cancelled': async load => {
    const {cancelOrder} = await load('orders/cancel.js');
    const first = cancelOrder(order());
    assert.throws(() => cancelOrder(first), await domainError(load));
  },
  'cancel.open': async load => {
    const {cancelOrder} = await load('orders/cancel.js');
    const original = order();
    assert.deepEqual(cancelOrder(original), {...original, status: 'cancelled'});
    assert.equal(original.status, 'open');
  },
  'cancel.shipped': async load => {
    const {cancelOrder} = await load('orders/cancel.js');
    assert.throws(() => cancelOrder(order('shipped')), await domainError(load, 'ALREADY_SHIPPED'));
  },
  'cancel.audit': async load => {
    const {cancelOrder} = await load('orders/cancel.js');
    const {auditLog} = await load('audit/log.js');
    const count = auditLog.length;
    const original = order();
    cancelOrder(original);
    assert.deepEqual(auditLog.slice(count), [{type: 'order.cancelled', orderId: original.id}]);
  },
};

const postal = {
  'shipping.zip-plus-four': async load => {
    const {normalizeAddress} = await load('shipping/address.js');
    for (const postalCode of ['12345-6789', '02108-0010']) {
      assert.deepEqual(normalizeAddress({city: 'Sample', postalCode}), {city: 'Sample', postalCode});
    }
  },
  'shipping.five-digit': async load => {
    const {normalizeAddress} = await load('shipping/address.js');
    assert.deepEqual(normalizeAddress({postalCode: ' 02108 '}), {postalCode: '02108'});
  },
  'shipping.malformed-postal': async load => {
    const {normalizeAddress} = await load('shipping/address.js');
    const invalidPostal = await domainError(load, 'INVALID_POSTAL_CODE');
    for (const postalCode of ['', '123456789', '1234-5678', '12345-678', '12345-67890', '12345-ABCD']) {
      assert.throws(() => normalizeAddress({postalCode}), invalidPostal);
    }
  },
  'billing.zip-plus-four-rejected': async load => {
    const {taxFor} = await load('billing/tax.js');
    assert.throws(() => taxFor('10001-1234', 200), await domainError(load, 'INVALID_POSTAL_CODE'));
  },
  'billing.tax-unchanged': async load => {
    const {taxFor} = await load('billing/tax.js');
    assert.equal(taxFor('10001', 200), 17.75);
    assert.equal(taxFor('94105', 200), 17.25);
    assert.equal(taxFor('02108', 200), 10);
  },
};

async function assertShipAudit(load, emit) {
  const {shipOrder} = await load('orders/ship.js');
  const {auditLog} = await load('audit/log.js');
  const original = order();
  const count = auditLog.length;
  assert.equal(shipOrder(original, emit).status, 'shipped');
  assert.equal(original.status, 'open');
  assert.deepEqual(auditLog.slice(count), [{type: 'order.shipped', orderId: original.id}]);
}

const refund = {
  'refund.registered': async load => {
    const {operations} = await load('orders/index.js');
    assert.equal(operations.refund(order('shipped'), 400).status, 'refunded');
  },
  'refund.partial-status': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const original = order('shipped');
    const result = refundOrder(original, 333);
    assert.equal(result.status, 'refunded');
    assert.equal(result.refundedCents, 333);
    assert.equal(result.id, original.id);
    assert.deepEqual(result.lines, original.lines);
    assert.equal(original.status, 'shipped');
  },
  'refund.audit': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const {auditLog} = await load('audit/log.js');
    const original = order('shipped');
    const count = auditLog.length;
    refundOrder(original, 333);
    const events = auditLog.slice(count);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'order.refunded');
    assert.equal(events[0].orderId, original.id);
    assert.equal(events[0].amountCents, 333);
  },
  'refund.total-limit': async load => {
    const {refundOrder} = await load('orders/refund.js');
    assert.equal(refundOrder(order('shipped'), 1200).refundedCents, 1200);
    assert.throws(() => refundOrder(order('shipped'), 1201), await domainError(load));
  },
  'refund.positive-integer': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const invalid = await domainError(load);
    for (const amount of [0, -1, 100.5, '100']) {
      assert.throws(() => refundOrder(order('shipped'), amount), invalid);
    }
  },
  'refund.only-shipped': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const invalid = await domainError(load);
    for (const status of ['open', 'cancelled']) {
      assert.throws(() => refundOrder(order(status), 100), invalid);
    }
  },
  'refund.no-failed-audit': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const {auditLog} = await load('audit/log.js');
    const count = auditLog.length;
    assert.throws(() => refundOrder(order('shipped'), 1500), await domainError(load));
    assert.equal(auditLog.length, count);
  },
  'ship.audit-preserved': load => assertShipAudit(load),
};

async function warehouseEvent(load, original) {
  const {shipOrder} = await load('orders/ship.js');
  const emitted = [];
  const result = shipOrder(original, event => emitted.push(event));
  assert.equal(result.status, 'shipped');
  assert.equal(emitted.length, 1);
  return emitted[0];
}

const outbound = {
  'ship.warehouse-envelope': async load => {
    const before = Date.now();
    const event = await warehouseEvent(load, order());
    assert.deepEqual(Object.keys(event).sort(), ['id', 'occurredAt', 'payload', 'schemaVersion', 'type']);
    assert.equal(event.type, 'order.shipped');
    assert.equal(event.schemaVersion, 1);
    assert.equal(typeof event.id, 'string');
    assert.match(event.id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let timestamp = 0;
    for (const character of event.id.slice(0, 10)) {
      timestamp = timestamp * 32 + alphabet.indexOf(character);
    }
    assert.ok(timestamp >= before && timestamp <= Date.now());
  },
  'ship.warehouse-time-and-payload': async load => {
    const original = order();
    const before = Date.now();
    const event = await warehouseEvent(load, original);
    assert.deepEqual(event.payload, {orderId: original.id});
    assert.match(event.occurredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    const time = Date.parse(event.occurredAt);
    assert.ok(time >= before - 1000 && time <= Date.now());
  },
  'ship.unique-event-id': async load => {
    const first = await warehouseEvent(load, order());
    const second = await warehouseEvent(load, order('open', {id: 'order-42'}));
    assert.notEqual(first.id, second.id);
  },
  'ship.audit-preserved': async load => {
    await assertShipAudit(load);
    await assertShipAudit(load, () => {});
  },
  'ship.rejects-non-open': async load => {
    const {shipOrder} = await load('orders/ship.js');
    const {auditLog} = await load('audit/log.js');
    const notOpen = await domainError(load, 'NOT_OPEN');
    const count = auditLog.length;
    const emitted = [];
    for (const status of ['shipped', 'cancelled']) {
      assert.throws(() => shipOrder(order(status), event => emitted.push(event)), notOpen);
    }
    assert.equal(emitted.length, 0);
    assert.equal(auditLog.length, count);
  },
};

const shippedAt = '2026-01-10T10:00:00.000Z';
const returnNow = () => new Date('2026-01-24T10:00:00.000Z');
const shippedOrder = () => order('shipped', {shippedAt});
const selectedLines = () => [{sku: 'mug', qty: 1}];

const returnWindow = {
  'return.window-config': async load => {
    const {RETURN_WINDOW_DAYS} = await load('orders/return-window.js');
    assert.equal(RETURN_WINDOW_DAYS, 14);
  },
  'return.window-inclusive': async load => {
    const {returnWindowOpen} = await load('orders/return-window.js');
    assert.equal(returnWindowOpen(shippedOrder(), new Date(shippedAt)), true);
    assert.equal(returnWindowOpen(shippedOrder(), returnNow()), true);
  },
  'return.window-closed': async load => {
    const {returnWindowOpen} = await load('orders/return-window.js');
    assert.equal(returnWindowOpen(shippedOrder(), new Date('2026-01-24T10:00:00.001Z')), false);
    assert.equal(returnWindowOpen(shippedOrder(), new Date('2026-01-10T09:59:59.999Z')), false);
    assert.equal(returnWindowOpen(order('shipped'), returnNow()), false);
  },
  'ship.timestamp': async load => {
    const {shipOrder} = await load('orders/ship.js');
    const original = order();
    const result = shipOrder(original, new Date(shippedAt));
    assert.equal(result.status, 'shipped');
    assert.equal(result.shippedAt, shippedAt);
    assert.equal(original.shippedAt, undefined);
    const before = Date.now();
    const defaultTime = Date.parse(shipOrder(order()).shippedAt);
    assert.ok(defaultTime >= before && defaultTime <= Date.now());
  },
  'ship.audit-preserved': load => assertShipAudit(load),
};

const returnRequest = {
  'return.partial-lines': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    const original = shippedOrder();
    const request = {lines: selectedLines(), reasonCode: 'DAMAGED'};
    const result = requestReturn(original, request, returnNow());
    assert.equal(result.status, 'return_requested');
    assert.deepEqual(result.returnRequest, request);
    assert.deepEqual(result.lines, original.lines);
    assert.equal(original.status, 'shipped');
  },
  'return.reason-required': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    const invalid = await domainError(load);
    for (const reasonCode of [undefined, '', 'OTHER']) {
      assert.throws(() => requestReturn(shippedOrder(), {lines: selectedLines(), reasonCode}, returnNow()), invalid);
    }
  },
  'return.reason-choices': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    for (const reasonCode of ['DAMAGED', 'WRONG_ITEM', 'NOT_NEEDED']) {
      const result = requestReturn(shippedOrder(), {lines: selectedLines(), reasonCode}, returnNow());
      assert.equal(result.status, 'return_requested');
      assert.equal(result.returnRequest.reasonCode, reasonCode);
    }
  },
  'return.invalid-lines': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    const invalid = await domainError(load);
    const invalidLines = [
      undefined,
      [],
      [{sku: 'unknown', qty: 1}],
      [{sku: 'mug', qty: 0}],
      [{sku: 'mug', qty: 1.5}],
      [{sku: 'mug', qty: 3}],
      [{sku: 'mug', qty: 1}, {sku: 'mug', qty: 1}],
    ];
    for (const lines of invalidLines) {
      assert.throws(() => requestReturn(shippedOrder(), {lines, reasonCode: 'DAMAGED'}, returnNow()), invalid);
    }
  },
  'return.requires-shipped': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    const original = order('open', {shippedAt});
    const request = {lines: selectedLines(), reasonCode: 'DAMAGED'};
    assert.throws(() => requestReturn(original, request, returnNow()), await domainError(load));
  },
  'return.expired': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    const request = {lines: selectedLines(), reasonCode: 'DAMAGED'};
    assert.throws(
      () => requestReturn(shippedOrder(), request, new Date('2026-01-24T10:00:00.001Z')),
      await domainError(load),
    );
  },
  'return.registered': async load => {
    const {operations} = await load('orders/index.js');
    const request = {lines: selectedLines(), reasonCode: 'DAMAGED'};
    assert.equal(operations.requestReturn(shippedOrder(), request, returnNow()).status, 'return_requested');
  },
  'return.audit': async load => {
    const {requestReturn} = await load('orders/request-return.js');
    const {auditLog} = await load('audit/log.js');
    const original = shippedOrder();
    const request = {lines: selectedLines(), reasonCode: 'DAMAGED'};
    const count = auditLog.length;
    requestReturn(original, request, returnNow());
    const events = auditLog.slice(count);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'order.return_requested');
    assert.equal(events[0].orderId, original.id);
  },
};

const cumulativeRefund = {
  'refund.partial-status': async load => {
    const {refundOrder} = await load('orders/refund.js');
    assert.equal(refundOrder(order('shipped'), 400).status, 'shipped');
  },
  'refund.full-status': async load => {
    const {refundOrder} = await load('orders/refund.js');
    assert.equal(refundOrder(order('shipped', {refundedCents: 500}), 700).status, 'refunded');
    assert.equal(refundOrder(order('shipped'), 1200).status, 'refunded');
  },
  'refund.accumulates': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const first = refundOrder(order('shipped'), 300);
    const second = refundOrder(first, 200);
    assert.equal(first.refundedCents, 300);
    assert.equal(second.refundedCents, 500);
  },
  'refund.remaining-limit': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const original = order('shipped', {refundedCents: 800});
    assert.throws(() => refundOrder(original, 401), await domainError(load, 'REFUND_EXCEEDS_REMAINING'));
  },
  'refund.only-shipped': refund['refund.only-shipped'],
  'refund.integer-amount': async load => {
    const {refundOrder} = await load('orders/refund.js');
    assert.throws(() => refundOrder(order('shipped'), 99.5), await domainError(load));
  },
  'refund.audit': async load => {
    const {refundOrder} = await load('orders/refund.js');
    const {auditLog} = await load('audit/log.js');
    const count = auditLog.length;
    refundOrder(order('shipped'), 300);
    refundOrder(order('shipped', {id: 'order-42'}), 200);
    assert.deepEqual(
      auditLog.slice(count).map(({type, orderId, amountCents}) => ({type, orderId, amountCents})),
      [
        {type: 'order.refunded', orderId: 'order-41', amountCents: 300},
        {type: 'order.refunded', orderId: 'order-42', amountCents: 200},
      ],
    );
  },
};

export const orderCases = {
  T1: {final: cancellation},
  T2: {final: postal},
  T3: {final: refund},
  T4: {final: outbound},
  T5: {step1: returnWindow, final: {...returnWindow, ...returnRequest}},
  T6: {final: cumulativeRefund},
};
