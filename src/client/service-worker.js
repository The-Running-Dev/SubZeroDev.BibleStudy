// The app shell for a start with no connection (S14). The build prepends `version` and `shell`.
// API, media and build-id requests are not intercepted: downloaded chapters are read from IndexedDB and Cache Storage by the app.
/* global version, shell */
const cacheName = `shell-${version}`;

self.addEventListener('install', (event) => {
  // A new build waits until the member approves it (S16); the first install has nothing to wait for.
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)));
});

// Approval from a window: refused while another window of the app is open, so no window runs on a shell it did not load.
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'apply' || !event.ports[0]) return;
  const port = event.ports[0];
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.length > 1) return port.postMessage({ applied: false, reason: 'multiple_windows' });
      port.postMessage({ applied: true });
      return self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('shell-') && name !== cacheName).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // The newest shell when the server answers; the stored one when it does not.
    event.respondWith(fetch(request).catch(() => caches.match('/', { cacheName }).then((cached) => cached ?? Response.error())));
    return;
  }
  if (shell.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname, { cacheName }).then((cached) => cached ?? fetch(request)));
  }
});
