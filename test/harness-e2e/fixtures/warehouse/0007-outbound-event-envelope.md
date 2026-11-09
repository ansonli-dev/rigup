# ADR 0007. Outbound event envelope

Warehouse consumers receive version 1 of the outbound event envelope. An emitter
is called once per successful operation. Every envelope contains these fields.

- `id` is a distinct 26-character uppercase Crockford ULID. Its first ten
  characters encode the Unix timestamp in milliseconds. The first character is
  in the range 0 through 7.
- `schemaVersion` is the number `1`.
- `type` is the event name. Shipping uses `order.shipped`.
- `occurredAt` is the occurrence time as an ISO 8601 UTC timestamp ending in `Z`.
- `payload` contains the event fields. For `order.shipped` this is an object
  containing only `orderId`.
