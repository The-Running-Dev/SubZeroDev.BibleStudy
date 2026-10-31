// API.Bible Fair Use reporting (S13.6): every display of CSB text reports the chapter's token to
// https://fums.api.bible/f3 with t (tokens), dId (device), sId (session) and uId (SHA-256 of the user id), the format in
// https://docs.api.bible/guides/fair-use. Reports made offline wait in localStorage and go out once the device is online.

export const fumsUrl = 'https://fums.api.bible/f3';
const queueKey = 'fums-queue';
const deviceKey = 'fums-device';
// Several text tokens may share one request; a long backlog goes out in batches.
const batchSize = 20;
const maxQueued = 500;

interface Entry {
  token: string;
  userId: string;
}

// crypto.randomUUID needs a secure context; the fallback builds the same v4 form from random bytes.
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let sessionId: string | null = null;
let flushing: Promise<void> | null = null;
// Once storage refuses a write (private mode, full), this page keeps its reports in memory: they then wait only as
// long as the page is open.
let stored = true;
let memory: Entry[] = [];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function queued(): Entry[] {
  if (!stored) return memory;
  try {
    const text = read(queueKey);
    if (text === null) return memory;
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e?.token === 'string' && typeof e?.userId === 'string') : [];
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  if (stored && write(queueKey, JSON.stringify(entries))) return;
  stored = false;
  memory = entries;
  // The stored copy is now stale; left in place it would be sent again by the next page.
  try {
    localStorage.removeItem(queueKey);
  } catch {
    // Storage is unavailable altogether.
  }
}

function deviceId(): string {
  const known = read(deviceKey);
  if (known) return known;
  const fresh = uuid();
  write(deviceKey, fresh);
  return fresh;
}

async function hashed(userId: string): Promise<string> {
  if (!crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendQueued(): Promise<void> {
  // Each round removes the batch it sent, so a full queue empties in maxQueued / batchSize rounds.
  for (let round = 0; round <= maxQueued / batchSize && navigator.onLine; round++) {
    const all = queued();
    if (all.length === 0) return;
    const userId = all[0].userId;
    const batch = all.filter((e) => e.userId === userId).slice(0, batchSize);
    const url = new URL(fumsUrl);
    for (const entry of batch) url.searchParams.append('t', entry.token);
    url.searchParams.set('dId', deviceId());
    url.searchParams.set('sId', (sessionId ??= uuid()));
    url.searchParams.set('uId', await hashed(userId));
    try {
      // The beacon's answer is opaque to us; only a network failure keeps the batch queued.
      await fetch(url, { mode: 'no-cors', credentials: 'omit', keepalive: true, referrerPolicy: 'no-referrer' });
    } catch {
      return;
    }
    // Reports added while this one was in flight stay queued.
    const rest = queued();
    for (const entry of batch) {
      const at = rest.findIndex((e) => e.token === entry.token && e.userId === entry.userId);
      if (at >= 0) rest.splice(at, 1);
    }
    save(rest);
  }
}

// Tabs share the stored queue; only one of them sends it at a time. A queue held in memory is this page's alone.
function flushOnce(): Promise<void> {
  if (!stored || !navigator.locks) return sendQueued();
  return navigator.locks.request('fums-flush', { ifAvailable: true }, (lock) => (lock ? sendQueued() : undefined));
}

export function flushFums(): Promise<void> {
  flushing ??= flushOnce().finally(() => {
    flushing = null;
  });
  return flushing;
}

// Called each time a CSB chapter is shown.
export function reportFums(token: string, userId: string): void {
  save([...queued(), { token, userId }].slice(-maxQueued));
  void flushFums();
}

window.addEventListener('online', () => void flushFums());
