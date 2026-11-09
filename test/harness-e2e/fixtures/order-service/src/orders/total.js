export function orderTotalCents(order) {
  return order.lines.reduce((total, line) => total + line.priceCents * line.qty, 0);
}
