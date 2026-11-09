import {validatePostalCode} from '../postal-code.js';

export function normalizeAddress(address) {
  const postalCode = String(address.postalCode ?? '').trim();
  validatePostalCode(postalCode);
  return {...address, postalCode};
}
