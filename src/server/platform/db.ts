import pg from 'pg';
import { AppError } from './errors.ts';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client that drops must not crash the process; the next query reconnects.
  pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', msg: 'idle database client failed', error: error.message })));
  return pool;
}

export async function withTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await connect(db);
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// The database is down or unreachable, as opposed to a query that failed: a refused connection, a
// connection-class SQLSTATE (08xxx), an administrator shutdown, or a pool that could not connect.
export function databaseUnavailable(error: unknown): boolean {
  if (error instanceof AppError) return error.code === 'unavailable';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code === 'ECONNREFUSED' || code.startsWith('08') || code === '57P01');
}

async function connect(db: Db): Promise<Tx> {
  try {
    return await db.connect();
  } catch (error) {
    throw new AppError('unavailable', 503, 'The database is unavailable.', { retryable: true, details: { cause: (error as Error).message } });
  }
}
