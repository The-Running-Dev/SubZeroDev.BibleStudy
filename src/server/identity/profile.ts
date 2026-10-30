import type { Profile, ProfilePatch, TranslationId } from '../../shared/api.ts';
import type { Queryable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';
import { isValidTimeZone, normalizeDisplayName } from './validation.ts';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  time_zone: string;
  display_translation_id: TranslationId | null;
}

export function toProfile(row: UserRow): Profile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    timeZone: row.time_zone,
    displayTranslationId: row.display_translation_id,
  };
}

const userColumns = 'id, email, display_name, time_zone, display_translation_id';

export async function getProfile(db: Queryable, userId: string): Promise<Profile> {
  const result = await db.query<UserRow>(`SELECT ${userColumns} FROM users WHERE id = $1`, [userId]);
  if (!result.rowCount) throw new AppError('unauthenticated', 401, 'Sign in again.');
  return toProfile(result.rows[0]);
}

export async function updateProfile(db: Queryable, userId: string, patch: unknown): Promise<Profile> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new AppError('invalid_request', 400, 'Send a JSON object.');
  const input = patch as Record<string, unknown>;
  const allowed: (keyof ProfilePatch)[] = ['displayName', 'timeZone', 'displayTranslationId'];
  const unknownKeys = Object.keys(input).filter((key) => !allowed.includes(key as keyof ProfilePatch));
  if (unknownKeys.length) throw new AppError('invalid_request', 400, `Unknown fields: ${unknownKeys.join(', ')}.`);

  const sets: string[] = [];
  const values: unknown[] = [userId];
  if ('displayName' in input) {
    values.push(normalizeDisplayName(input.displayName));
    sets.push(`display_name = $${values.length}`);
  }
  if ('timeZone' in input) {
    if (!isValidTimeZone(input.timeZone)) throw new AppError('invalid_zone', 400, `${String(input.timeZone)} is not a known time zone.`);
    values.push(input.timeZone);
    sets.push(`time_zone = $${values.length}`);
  }
  if ('displayTranslationId' in input) {
    const id = input.displayTranslationId;
    if (id !== null && id !== 'BSB' && id !== 'CSB') throw new AppError('invalid_request', 400, 'displayTranslationId is BSB, CSB or null.');
    values.push(id);
    sets.push(`display_translation_id = $${values.length}`);
  }
  if (!sets.length) return getProfile(db, userId);

  const result = await db.query<UserRow>(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${userColumns}`, values);
  if (!result.rowCount) throw new AppError('unauthenticated', 401, 'Sign in again.');
  return toProfile(result.rows[0]);
}
