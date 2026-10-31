import { setTimeout as sleep } from 'node:timers/promises';
import { createPool } from './db.ts';
import { migrate } from './migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(url);
try {
  // A database still starting refuses connections for a moment after its health check first passes; a
  // one-shot service that gave up then would stop the whole deploy.
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      console.error(`database not ready (${(error as Error).message}); retrying`);
      await sleep(1000);
    }
  }
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date');
} finally {
  await pool.end();
}
