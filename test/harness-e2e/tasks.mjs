export const TASKS = [
  {
    id: 'T1',
    title: 'Reject double cancellation',
    fixture: 'order-service',
    prompts: [
      'Reject attempts to cancel an already cancelled order with a DomainError. Preserve the existing behavior for open and shipped orders.',
    ],
    checkpoints: ['final'],
  },
  {
    id: 'T2',
    title: 'Allow ZIP+4 for shipping',
    fixture: 'order-service',
    prompts: [
      'Update shipping address normalization to accept US ZIP+4 postal codes such as 12345-6789 in addition to five-digit ZIP codes. Billing must continue to reject ZIP+4, and existing tax calculations must stay the same.',
    ],
    checkpoints: ['final'],
  },
  {
    id: 'T3',
    title: 'Refund a shipped order',
    fixture: 'order-service',
    prompts: [
      [
        'Add refundOrder(order, amountCents) in src/orders/refund.js and expose it as operations.refund.',
        'Allow shipped orders to be refunded for positive integer cents up to the order total, including partial refunds.',
        'Return a copy of the order with status set to refunded even for a partial refund, and include the amount in refundedCents.',
        'Record order.refunded with the orderId and amountCents. Preserve the existing audit behavior and use the project’s existing error convention for invalid requests.',
      ].join(' '),
    ],
    checkpoints: ['final'],
  },
  {
    id: 'T4',
    title: 'Publish a warehouse event on shipping',
    fixture: 'order-service',
    prompts: [
      'When shipOrder succeeds, publish an order.shipped event for the warehouse through an optional emit callback passed as the second argument. Follow the project’s outbound event convention. Preserve existing callers, shipping audit behavior, and rejection of non-open orders.',
    ],
    checkpoints: ['final'],
  },
  {
    id: 'T5',
    title: 'Request order returns across sessions',
    fixture: 'order-service',
    prompts: [
      [
        'We’re adding order returns in three sessions. An order can be returned from its shipping time through exactly 14 days after shipping, inclusive.',
        'For this first session, export RETURN_WINDOW_DAYS and returnWindowOpen(order, now) from src/orders/return-window.js, and make shipOrder(order, now) set shippedAt to an ISO UTC timestamp. The optional now argument to each function is a Date and defaults to the current time.',
        'In the second session we’ll add requestReturn(order, {lines, reasonCode}, now) in src/orders/request-return.js. Only shipped orders within the window can be returned. The request must include a nonempty list of distinct order lines as {sku, qty} entries, with each quantity a positive integer up to the ordered quantity. A subset of the order lines and a partial quantity are both allowed.',
        'A reasonCode is required and must be one of DAMAGED, WRONG_ITEM, or NOT_NEEDED. Invalid requests use the project’s existing domain error convention. A successful request returns a copy with status return_requested and the selected lines and reasonCode in returnRequest.',
        'In the third session we’ll expose the operation as operations.requestReturn and record order.return_requested with the orderId on success.',
        'Implement only the first session’s helper and shipping timestamp now.',
      ].join('\n\n'),
      'Implement the requestReturn operation planned in the first session. Leave registry and audit wiring for the next session.',
      'Finish wiring the new return request operation into the order service registry and audit trail.',
    ],
    checkpoints: ['step1', 'final'],
  },
  {
    id: 'T6',
    title: 'Clarify refund status and accounting',
    fixture: 'order-service',
    prompts: [
      'Add refundOrder(order, amountCents) in src/orders/refund.js for shipped orders. The amount is an integer number of cents, and the order status should reflect the refund.',
    ],
    checkpoints: ['final'],
    clarification: 'Keep the status shipped until cumulative refundedCents reaches the order total, then set it to refunded. Accumulate refundedCents across refunds. An amount above the remaining refundable cents throws a DomainError with code REFUND_EXCEEDS_REMAINING. Record order.refunded with orderId and amountCents for each successful refund.',
  },
  {
    id: 'T7',
    title: 'Reserve available stock',
    fixture: 'store-service',
    prompts: [
      'Add reserveStock(stock, quantity) in src/inventory/reserve.js. Reserve units from onHand minus reserved and keep onHand unchanged. A quantity other than a positive integer must fail with INVALID_QTY. A quantity above available units must fail with INSUFFICIENT_STOCK. Preserve catalog and pricing behavior.',
    ],
    checkpoints: ['final'],
  },
];

export function getTask(taskId) {
  const task = TASKS.find(({id}) => id === taskId);
  if (!task) throw new Error(`Unknown harness task ${taskId}`);
  return task;
}
