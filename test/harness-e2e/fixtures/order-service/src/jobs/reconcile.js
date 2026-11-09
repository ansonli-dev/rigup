export function reconcileShipment(shipment) {
  if (!shipment.externalId) return {ok: false, reason: 'NO_EXTERNAL_ID'};
  return {ok: true, externalId: shipment.externalId};
}
