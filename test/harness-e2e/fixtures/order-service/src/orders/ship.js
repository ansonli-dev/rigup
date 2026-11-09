import {recordEvent} from '../audit/log.js';
import {DomainError} from '../error.js';

export function shipOrder(order) {
  if (order.status !== 'open') throw new DomainError('NOT_OPEN', 'Only open orders can ship');
  recordEvent('order.shipped', {orderId: order.id});
  return {...order, status: 'shipped'};
}
