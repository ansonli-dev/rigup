import {validatePostalCode} from '../postal-code.js';

const rates = {
  '10001': 0.08875,
  '94105': 0.08625,
};

export function taxFor(postalCode, amount) {
  validatePostalCode(postalCode);
  const rate = rates[postalCode] ?? 0.05;
  return Math.round(amount * rate * 100) / 100;
}
