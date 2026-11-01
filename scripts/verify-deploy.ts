// After a Portainer redeploy: waits until the public site serves the expected build.
// Portainer answers its webhook before the new container is serving, and the redeploy pulls the image
// first, so a slow pull gets five minutes rather than failing a deploy that succeeds a moment later.
//
//   node scripts/verify-deploy.ts https://<hostname> <build id>
import { setTimeout } from 'node:timers/promises';

const [origin, expected] = process.argv.slice(2);
if (!origin || !expected) throw new Error('usage: verify-deploy.ts https://<hostname> <build id>');
const url = new URL('/__build-id', origin);
if (url.protocol !== 'https:') throw new Error(`${origin} is not an HTTPS origin`);

let last = 'no answer';
for (let attempt = 0; attempt < 150; attempt++) {
  try {
    const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    last = `${response.status} ${body.slice(0, 200)}`;
    if (response.ok && (JSON.parse(body) as { buildId?: string }).buildId === expected) {
      console.log(`${url} serves ${expected}`);
      process.exit(0);
    }
  } catch (error) {
    // The proxy may briefly have no healthy upstream while the stack restarts.
    last = (error as Error).message;
  }
  await setTimeout(2000);
}
console.error(`${url} did not serve ${expected} within five minutes; last answer: ${last}`);
process.exit(1);
