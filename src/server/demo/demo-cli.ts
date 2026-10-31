// demo-seed: fills an empty, migrated database (with Romans imported) with the synthetic demo group. Sends nothing.
import { systemClock } from '../platform/clock.ts';
import { createPool } from '../platform/db.ts';
import { seedDemo } from './demo.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const pool = createPool(url);
try {
  console.log(JSON.stringify(await seedDemo({ db: pool, clock: systemClock, ownerEmail: process.env.OWNER_EMAIL?.trim() || null })));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
