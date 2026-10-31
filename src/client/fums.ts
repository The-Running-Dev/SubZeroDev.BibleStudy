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

const sessionId = crypto.randomUUID();
let flushing: Promise<void> | null = null;
// Used when storage is refused (private mode, full): reports then wait only as long as the page is open.
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
  try {
    const stored = read(queueKey);
    if (stored === null) return memory;
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e?.token === 'string' && typeof e?.userId === 'string') : [];
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  memory = write(queueKey, JSON.stringify(entries)) ? [] : entries;
}

function deviceId(): string {
  const known = read(deviceKey);
  if (known) return known;
  const fresh = crypto.randomUUID();
  write(deviceKey, fresh);
  return fresh;
}

async function hashed(userId: string): Promise<string> {
  if (!crypto.subtle) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sendQueued(): Promise<void> {
  while (navigator.onLine) {
    const all = queued();
    if (all.length === 0) return;
    const userId = all[0].userId;
    const batch = all.filter((e) => e.userId === userId).slice(0, batchSize);
    const url = new URL(fumsUrl);
    for (const entry of batch) url.searchParams.append('t', entry.token);
    url.searchParams.set('dId', deviceId());
    url.searchParams.set('sId', sessionId);
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

export function flushFums(): Promise<void> {
  flushing ??= sendQueued().finally(() => {
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
