import {availableUnits} from './availability.js';
import {failure, success} from './result.js';

export function receiveStock(stock, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return failure('INVALID_QTY', 'Receipt quantity must be a positive integer');
  }
  return success({...stock, onHand: stock.onHand + quantity});
}

export function removeStock(stock, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return failure('INVALID_QTY', 'Removal quantity must be a positive integer');
  }
  if (quantity > availableUnits(stock)) {
    return failure('INSUFFICIENT_STOCK', 'Removal would consume reserved stock');
  }
  return success({...stock, onHand: stock.onHand - quantity});
}
