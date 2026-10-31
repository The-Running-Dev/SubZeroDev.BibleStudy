// Adding the app to a phone's home screen (S14.6). Android Chrome offers its own prompt, which is kept until the member asks;
// iPhone Safari has no prompt, so the help names the Share menu steps.

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPrompt;
    for (const listener of listeners) listener();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    for (const listener of listeners) listener();
  });
}

export function onInstallPromptChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const canPrompt = () => deferred !== null;

export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  await event.prompt();
  return (await event.userChoice).outcome === 'accepted';
}

export type Platform = 'installed' | 'ios-safari' | 'ios-other' | 'android' | 'other';

export function platform(): Platform {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return 'installed';
  const ua = navigator.userAgent;
  // iPadOS reports a Mac; touch tells them apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}
