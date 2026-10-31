// Updates and accounts across windows (S16). A new build waits as a service worker until the member approves it,
// and approval is refused while it could cut something off (DOD-27). Logging out or switching account is broadcast,
// so every open window hides the previous account's notes, drafts and downloads.
import type { Uuid } from '../shared/api.ts';

export type UpdateResult = { applied: true } | { applied: false; reason: 'live_session' | 'signing_in' | 'multiple_windows' };

const accountChannel = 'bs-account';
const busy = { live_session: 0, signing_in: 0 };

// Held while joined to a live session, or while a sign-in is under way; returns the release.
export function holdUpdate(reason: keyof typeof busy): () => void {
  busy[reason]++;
  let released = false;
  return () => {
    if (!released) busy[reason]--;
    released = true;
  };
}

// Tells every other window which account is now signed in here; null after a logout.
export async function switchAccount(nextUserId: Uuid | null): Promise<void> {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(accountChannel);
  channel.postMessage({ userId: nextUserId });
  channel.close();
}

// Calls back when another window signs out or signs in as someone else.
export function onAccountSwitch(listener: (userId: Uuid | null) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(accountChannel);
  channel.onmessage = (event: MessageEvent<{ userId: Uuid | null }>) => listener(event.data.userId);
  return () => channel.close();
}

let waiting: ServiceWorker | null = null;
const readyListeners = new Set<() => void>();

// Watches the registration for a new build that is installed and waiting. A first install has nothing to replace.
export function watchForUpdate(registration: ServiceWorkerRegistration): void {
  const found = () => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      waiting = registration.waiting;
      for (const listener of readyListeners) listener();
    }
  };
  found();
  registration.addEventListener('updatefound', () => {
    registration.installing?.addEventListener('statechange', found);
  });
}

export function updateReady(): boolean {
  return waiting !== null;
}

export function onUpdateReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

// Applies the waiting build when nothing would be cut off; the page reloads once the new worker takes over. The
// waiting worker counts the app's windows, so a window this one cannot see still refuses the update.
export async function requestUpdate(): Promise<UpdateResult> {
  if (busy.live_session > 0) return { applied: false, reason: 'live_session' };
  if (busy.signing_in > 0) return { applied: false, reason: 'signing_in' };
  const worker = waiting;
  if (!worker) return { applied: true };
  // Listening before asking: the worker takes over right after it answers, which can come before the answer does.
  const reload = () => window.location.reload();
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  const answer = await new Promise<UpdateResult>((resolve) => {
    const port = new MessageChannel();
    port.port1.onmessage = (event: MessageEvent<UpdateResult>) => resolve(event.data);
    worker.postMessage({ type: 'apply' }, [port.port2]);
  });
  if (!answer.applied) navigator.serviceWorker.removeEventListener('controllerchange', reload);
  return answer;
}
