import { AppError } from '../platform/errors.ts';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lower-cased and trimmed; the same person always maps to one user row.
export function normalizeEmail(input: unknown): string {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (email.length > 254 || !emailPattern.test(email)) throw new AppError('invalid_email', 400, 'Enter a valid email address.');
  return email;
}

// The runtime's canonical spelling of an IANA zone name ("europe/sofia" becomes "Europe/Sofia"), or null.
// The runtime also accepts bare offsets such as "+01:00"; those are refused, since a stored zone must follow
// daylight-saving changes (I-03).
export function canonicalTimeZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return null;
  try {
    const resolved = new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
    return /^[A-Za-z]/.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function isValidTimeZone(zone: unknown): zone is string {
  return canonicalTimeZone(zone) !== null;
}

export function normalizeDisplayName(input: unknown): string {
  const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 60) throw new AppError('invalid_request', 400, 'A display name is 1 to 60 characters.');
  return name;
}
