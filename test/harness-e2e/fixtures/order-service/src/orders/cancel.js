import {recordEvent} from '../audit/log.js';
import {DomainError} from '../error.js';

export function cancelOrder(order) {
  if (order.status === 'shipped') throw new DomainError('ALREADY_SHIPPED', 'Shipped orders cannot be cancelled');
  recordEvent('order.cancelled', {orderId: order.id});
  return {...order, status: 'cancelled'};
}
