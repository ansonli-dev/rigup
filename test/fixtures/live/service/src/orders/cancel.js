import {DomainError} from '../error.js';
export function cancelOrder(order) {
  if (order.status === 'shipped') throw new DomainError('ALREADY_SHIPPED', 'Shipped orders cannot be cancelled');
  return {...order, status: 'cancelled'};
}
