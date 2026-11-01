// Imported CSB is private to the configured instance owner, never granted by a group role.
import type { Config } from '../platform/config.ts';
import type { Queryable } from '../platform/db.ts';
import { AppError } from '../platform/errors.ts';

export interface ContentAccess {
  importedCsbUserId: string | null;
}

export const noImportedCsb: ContentAccess = { importedCsbUserId: null };
export const importedCsbDenied = () => new AppError('content_not_permitted', 403, 'Imported CSB is restricted to the configured owner.');

export async function contentAccess(db: Queryable, config: Config, userId: string): Promise<ContentAccess> {
  if (config.csbImportedAccess !== 'owner' || !config.ownerEmail) return noImportedCsb;
  // userId comes from the verified server session, never from a request parameter or a group role.
  const user = await db.query('SELECT 1 FROM users WHERE id = $1 AND email = $2', [userId, config.ownerEmail]);
  return user.rowCount ? { importedCsbUserId: userId } : noImportedCsb;
}
