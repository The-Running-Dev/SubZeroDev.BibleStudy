import { AppError } from '../platform/errors.ts';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lower-cased and trimmed; the same person always maps to one user row.
export function normalizeEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (email.length > 254 || !emailPattern.test(email)) throw new AppError('invalid_email', 400, 'Enter a valid email address.');
  return email;
}

// Accepts exactly what the runtime's zone data accepts, so stored zones always format.
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function normalizeDisplayName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 60) throw new AppError('invalid_request', 400, 'A display name is 1 to 60 characters.');
  return name;
}
