// The app shell for a start with no connection (S14). The build prepends `version` and `shell`.
// API, media and build-id requests are not intercepted: downloaded chapters are read from IndexedDB and Cache Storage by the app.
/* global version, shell */
const cacheName = `shell-${version}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)).then(() => self.skipWaiting()));
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
