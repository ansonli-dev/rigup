export async function runDelivery(delivery, send) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await send(delivery); return {delivered: true}; }
    catch (error) { if (attempt === 2) throw error; }
  }
}
