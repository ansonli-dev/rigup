import {DomainError} from '../error.js';
export function createOrder(input) {
  if (!input.customerId) throw new DomainError('CUSTOMER_REQUIRED', 'An order requires a customer');
  if (input.lines.length === 0) throw new DomainError('EMPTY_ORDER', 'At least one line is required');
  return {id: input.id, status: 'open', lines: input.lines};
}
