export const inventory = {
  transfer: ['transferStock', `
import {receiveStock, removeStock} from './adjust.js';
import {failure, success} from './result.js';

export function transferStock(source, destination, quantity) {
  if (source.sku !== destination.sku) return failure('SKU_MISMATCH', 'Transfer requires the same SKU');
  const removed = removeStock(source, quantity);
  if (!removed.ok) return removed;
  const received = receiveStock(destination, quantity);
  return success({source: removed.value, destination: received.value});
}
`, `
  const source = {sku: 'T-1', onHand: 10, reserved: 3};
  const destination = {sku: 'T-1', onHand: 2, reserved: 0};
  const transfer = transferStock(source, destination, 4);
  assert.deepEqual(transfer.value, {source: {...source, onHand: 6}, destination: {...destination, onHand: 6}});
  assert.equal(transferStock(source, destination, 8).error.code, 'INSUFFICIENT_STOCK');
`],
  reconcile: ['recountStock', `
import {failure, success} from './result.js';

export function recountStock(stock, countedUnits) {
  if (!Number.isInteger(countedUnits) || countedUnits < 0) return failure('INVALID_QTY', 'Use a whole stock count');
  if (countedUnits < stock.reserved) return failure('COUNT_BELOW_RESERVED', 'Count is below reserved units');
  return success({...stock, onHand: countedUnits});
}
`, `
  const stock = {sku: 'T-1', onHand: 10, reserved: 3};
  assert.equal(recountStock(stock, 7).value.onHand, 7);
  assert.equal(recountStock(stock, 2).error.code, 'COUNT_BELOW_RESERVED');
`],
  release: ['releaseReserved', `
import {failure, success} from './result.js';

export function releaseReserved(stock, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) return failure('INVALID_QTY', 'Release requires positive units');
  if (quantity > stock.reserved) return failure('RESERVATION_TOO_SMALL', 'Cannot release more units than reserved');
  return success({...stock, reserved: stock.reserved - quantity});
}
`, `
  const stock = {sku: 'T-1', onHand: 10, reserved: 3};
  assert.deepEqual(releaseReserved(stock, 3), {ok: true, value: {...stock, reserved: 0}});
  assert.equal(releaseReserved(stock, 4).error.code, 'RESERVATION_TOO_SMALL');
`],
  damage: ['quarantineUnits', `
import {removeStock} from './adjust.js';
import {success} from './result.js';

export function quarantineUnits(stock, quantity) {
  const removed = removeStock(stock, quantity);
  if (!removed.ok) return removed;
  return success({...removed.value, quarantined: (stock.quarantined ?? 0) + quantity});
}
`, `
  const stock = {sku: 'T-1', onHand: 10, reserved: 3, quarantined: 2};
  assert.deepEqual(quarantineUnits(stock, 2).value, {...stock, onHand: 8, quarantined: 4});
`],
  reorder: ['setReorderPoint', `
import {failure, success} from './result.js';

export function setReorderPoint(stock, reorderPoint) {
  if (!Number.isInteger(reorderPoint) || reorderPoint < 0) {
    return failure('INVALID_REORDER_POINT', 'Reorder point must be a nonnegative integer');
  }
  return success({...stock, reorderPoint});
}
`, `
  assert.equal(setReorderPoint({sku: 'T-1'}, 0).value.reorderPoint, 0);
  assert.equal(setReorderPoint({sku: 'T-1'}, 2.5).error.code, 'INVALID_REORDER_POINT');
`],
  shortage: ['replenishmentQty', `
import {availableUnits} from './availability.js';
import {failure, success} from './result.js';

export function replenishmentQty(stock, target) {
  if (!Number.isInteger(target) || target < 0) return failure('INVALID_TARGET', 'Use a nonnegative target');
  return success(Math.max(0, target - availableUnits(stock)));
}
`, `
  assert.deepEqual(replenishmentQty({onHand: 10, reserved: 3}, 12), {ok: true, value: 5});
`],
  count: ['stockFromCount', `
import {failure, success} from './result.js';

export function stockFromCount(sku, onHand) {
  if (typeof sku !== 'string' || !sku) return failure('SKU_REQUIRED', 'Stock requires a SKU');
  if (!Number.isInteger(onHand) || onHand < 0) return failure('INVALID_QTY', 'Use a whole stock count');
  return success({sku, onHand, reserved: 0});
}
`, `
  assert.deepEqual(stockFromCount('T-1', 10), {ok: true, value: {sku: 'T-1', onHand: 10, reserved: 0}});
`],
  location: ['assignStockLocation', `
import {failure, success} from './result.js';

export function assignStockLocation(stock, location) {
  const normalized = typeof location === 'string' ? location.trim().toUpperCase() : '';
  if (!/^[A-Z]+-[0-9]{2}$/.test(normalized)) return failure('INVALID_LOCATION', 'Use a zone and two-digit bin');
  return success({...stock, location: normalized});
}
`, `
  assert.equal(assignStockLocation({sku: 'T-1'}, ' west-02 ').value.location, 'WEST-02');
`],
  'availability-report': ['stockSummary', `
import {availableUnits} from './availability.js';

export function stockSummary(stocks) {
  return {
    skuCount: new Set(stocks.map(stock => stock.sku)).size,
    available: stocks.reduce((sum, stock) => sum + availableUnits(stock), 0),
  };
}
`, `
  const stocks = [{sku: 'T-1', onHand: 10, reserved: 3}, {sku: 'T-1', onHand: 5, reserved: 1}];
  assert.deepEqual(stockSummary(stocks), {skuCount: 1, available: 11});
`],
  merge: ['mergeStock', `
import {failure, success} from './result.js';

export function mergeStock(current, incoming) {
  if (current.sku !== incoming.sku) return failure('SKU_MISMATCH', 'Stock entries must share a SKU');
  return success({
    ...current,
    onHand: current.onHand + incoming.onHand,
    reserved: current.reserved + incoming.reserved,
  });
}
`, `
  const current = {sku: 'T-1', onHand: 10, reserved: 3};
  assert.deepEqual(mergeStock(current, {sku: 'T-1', onHand: 5, reserved: 1}).value, {...current, onHand: 15, reserved: 4});
`],
  'safety-stock': ['setSafetyStock', `
import {failure, success} from './result.js';

export function setSafetyStock(stock, safetyStock) {
  if (!Number.isInteger(safetyStock) || safetyStock < 0) return failure('INVALID_QTY', 'Use whole safety stock units');
  return success({...stock, safetyStock});
}
`, `
  assert.equal(setSafetyStock({sku: 'T-1'}, 6).value.safetyStock, 6);
  assert.equal(setSafetyStock({sku: 'T-1'}, -1).error.code, 'INVALID_QTY');
`],
  lot: ['setLotNumber', `
import {failure, success} from './result.js';

export function setLotNumber(stock, lotNumber) {
  if (typeof lotNumber !== 'string' || !/^[A-Z0-9-]+$/.test(lotNumber)) {
    return failure('INVALID_LOT', 'Use letters, digits, and dashes in lot numbers');
  }
  return success({...stock, lotNumber});
}
`, `
  assert.equal(setLotNumber({sku: 'T-1'}, '2026-LOT-1').value.lotNumber, '2026-LOT-1');
`],
  'stock-key': ['stockKey', `
export function stockKey(stock) {
  return [stock.sku, stock.location ?? 'UNASSIGNED', stock.lotNumber ?? 'NO-LOT'].join('/');
}
`, `
  assert.equal(stockKey({sku: 'T-1', location: 'WEST-02'}), 'T-1/WEST-02/NO-LOT');
`],
  expiry: ['setStockExpiry', `
import {failure, success} from './result.js';

export function setStockExpiry(stock, expiresOn) {
  if (typeof expiresOn !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(expiresOn)) {
    return failure('INVALID_EXPIRY', 'Expiry must be a calendar date');
  }
  const parsed = new Date(expiresOn);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expiresOn) {
    return failure('INVALID_EXPIRY', 'Expiry must be a calendar date');
  }
  return success({...stock, expiresOn});
}
`, `
  assert.equal(setStockExpiry({sku: 'T-1'}, '2026-11-21').value.expiresOn, '2026-11-21');
  assert.equal(setStockExpiry({sku: 'T-1'}, '2026-02-30').error.code, 'INVALID_EXPIRY');
`],
  projection: ['projectAvailability', `
import {availableUnits} from './availability.js';
import {failure, success} from './result.js';

export function projectAvailability(stock, incoming, outgoing) {
  if ([incoming, outgoing].some(quantity => !Number.isInteger(quantity) || quantity < 0)) {
    return failure('INVALID_QTY', 'Use whole incoming and outgoing counts');
  }
  const projected = availableUnits(stock) + incoming - outgoing;
  if (projected < 0) return failure('INSUFFICIENT_STOCK', 'Projection would leave available stock below zero');
  return success(projected);
}
`, `
  const stock = {onHand: 10, reserved: 3};
  assert.deepEqual(projectAvailability(stock, 5, 4), {ok: true, value: 8});
  assert.equal(projectAvailability(stock, 1, 9).error.code, 'INSUFFICIENT_STOCK');
`],
};
