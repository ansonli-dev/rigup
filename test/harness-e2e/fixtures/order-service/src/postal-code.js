import {DomainError} from './error.js';

export function validatePostalCode(postalCode) {
  if (typeof postalCode !== 'string' || !/^\d{5}$/.test(postalCode)) {
    throw new DomainError('INVALID_POSTAL_CODE', 'Enter a five-digit US ZIP code');
  }
}
