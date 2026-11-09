export function availableUnits(stock) {
  return stock.onHand - stock.reserved;
}
