# Order service

The service creates, cancels, and ships orders. The operation registry lives in
`src/orders/index.js`. Billing calculates tax and shipping normalizes delivery
addresses. Jobs handle work from external systems.

Run `npm test` from the repository root.
